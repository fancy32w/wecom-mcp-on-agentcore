#!/usr/bin/env bash
#
# 企业微信托管远程 MCP 服务 —— 部署编排。
#
# 顺序是有讲究的，几处依赖倒不过来：
#   ① 前置检查（ARM64 是硬门槛）
#   ② SSM 签名根密钥（不由 CDK 建：栈重建会换密钥，已签发的 MCP token 全失效）
#   ③ CDK 部署 → 拿到 CloudFront 端点、KMS ARN、Lambda 名
#   ④ 构建并推镜像到 ECR（需要 ③ 的账号信息，但不依赖栈输出）
#   ⑤ AgentCore Runtime（需要 ③ 的 AUTHORIZE_BASE 与 ④ 的镜像）
#   ⑥ 回填 Lambda 环境变量（需要 ⑤ 的 RUNTIME_ARN）
#
# 用法：
#   ./scripts/deploy.sh [--app <slug>] [--region <region>] [--profile <p>] \
#                       [--skip-image] [--redirect-hosts a.com,b.com]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

SLUG=""; REGION="${AWS_REGION:-us-east-1}"; SKIP_IMAGE=0; PROFILE_ARG=()
# local = 本机 docker/finch 构建（需 arm64 宿主机）
# codebuild = 远程 ARM 构建（本机不需要容器运行时）
# auto = 探测：有可用的容器运行时且宿主机是 arm64 就 local，否则 codebuild
BUILD_MODE="${WECOM_BUILD_MODE:-auto}"
# 留空，默认值在参数解析**之后**才算 —— 它依赖 REGION，而 REGION 可能被 --region 改写。
REDIRECT_HOSTS="${WECOM_REDIRECT_HOSTS:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) SLUG="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE_ARG=(--profile "$2"); shift 2 ;;
    --skip-image) SKIP_IMAGE=1; shift ;;
    --build) BUILD_MODE="$2"; shift 2 ;;
    --redirect-hosts) REDIRECT_HOSTS="$2"; shift 2 ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done

# Quick 云端的回调地址是 https://{region}.quicksight.aws.amazon.com/sn/oauthcallback
#（官方文档 quick/latest/userguide/zapier-integration.html → Configuring Zapier，
#  同一格式在 adobe / shopify / figma / moodys 各集成页重复出现）。
# **必须带 region 前缀** —— redirectAllowed() 是 host 精确比对，只写裸域名会被拒成
# invalid_redirect_uri。裸域名一并保留，成本为零且能兜住变体。
# Quick Desktop 走 loopback，代码里恒许，不用列在这里。
# OAuth 路径 access token 有效期（分钟），默认 30 天。
# 必须显式传：环境变量是**整组替换**的，不列在这里下次部署就会退回代码里的默认值。
# 选 30 天的理由见 lambda/oauth/index.js 里 ACCESS_TTL_MS 的注释 ——
# Quick 是反应式续期，实测到期后 4.2 分钟才刷，这个失败窗口每周期出现一次，
# 周期越短用户可见的失败越频繁。
ACCESS_TTL_MIN="${WECOM_ACCESS_TTL_MINUTES:-43200}"

: "${REDIRECT_HOSTS:=${REGION}.quicksight.aws.amazon.com,quicksight.aws.amazon.com}"

SFX=""; [ -n "$SLUG" ] && SFX="-$SLUG"
STACK="WecomMcpOnAgentCore${SFX}"
PREFIX="wecom-mcp-on-agentcore"; [ -n "$SLUG" ] && PREFIX="$PREFIX/$SLUG"
STATE_PARAM="/${PREFIX}/state-secret"
CLIENT_SECRET_PARAM="/${PREFIX}/oauth-client-secret"
# agentRuntimeName 只接受字母数字下划线，连字符要转掉
RUNTIME_NAME="wecom_mcp_on_agentcore$(echo "$SFX" | tr '-' '_')"
ECR_REPO="wecom-mcp${SFX}"
IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"

AWS="${AWS:-aws}"          # launchd 派生的 shell 常缺 /usr/local/bin
DOCKER="${DOCKER:-docker}" # finch / podman / nerdctl 均可替换
PY_BIN="${PY_BIN:-python3}" # 需要 boto3；系统 python 常被 externally-managed 挡住，
                           # 建议 python3 -m venv .venv && .venv/bin/pip install boto3
aws_() { "$AWS" "$@" --region "$REGION" "${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}"; }
say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

# ---------- ① 前置检查 ----------
say "① 前置检查"

ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "aarch64" ]; then
  echo "  ✗ 必须在 ARM64 机器上部署（当前 $ARCH）。"
  echo "    AgentCore Runtime 只支持 ARM64；x86_64 上无模拟构建会以"
  echo "    'exec /bin/sh: exec format error' 失败。用 Apple Silicon 或 Graviton 实例。"
  exit 1
fi

for c in "$AWS" "$PY_BIN" node npm; do
  command -v "$c" >/dev/null || { echo "  ✗ 缺少 $c"; exit 1; }
done
"$PY_BIN" -c 'import boto3' 2>/dev/null \
  || { echo "  ✗ $PY_BIN 缺少 boto3。建议：python3 -m venv .venv && .venv/bin/pip install boto3，然后 PY_BIN=.venv/bin/python"; exit 1; }

# 构建方式决策。**容器运行时不再是硬依赖** —— 没有它就走 CodeBuild(ARM)，
# 这样 Windows / Intel Mac / 无 Docker 的机器也能完成部署。
# AgentCore 只跑 ARM64，所以本地构建还要求宿主机本身是 arm64；x86 上本地构建
# 会以 `exec /bin/sh: exec format error` 失败，那种情况一律推给 CodeBuild。
if [ "$SKIP_IMAGE" -eq 1 ]; then
  BUILD_MODE=skip
elif [ "$BUILD_MODE" = "auto" ]; then
  if command -v "$DOCKER" >/dev/null 2>&1 \
     && "$DOCKER" info >/dev/null 2>&1 \
     && [ "$ARCH" = "arm64" ]; then
    BUILD_MODE=local
  else
    BUILD_MODE=codebuild
  fi
fi
if [ "$BUILD_MODE" = "local" ]; then
  command -v "$DOCKER" >/dev/null || { echo "  ✗ --build local 但找不到 $DOCKER"; exit 1; }
  "$DOCKER" info >/dev/null 2>&1 || { echo "  ✗ 容器守护进程未运行（$DOCKER）"; exit 1; }
  [ "$ARCH" = "arm64" ] || { echo "  ✗ --build local 需要 arm64 宿主机（当前 $ARCH）；改用 --build codebuild"; exit 1; }
fi

ACCOUNT_ID=$(aws_ sts get-caller-identity --query Account --output text)
echo "  账号 $ACCOUNT_ID / 区域 $REGION / 架构 $ARCH"
echo "  镜像标签 $IMAGE_TAG / 构建方式 $BUILD_MODE"

# ---------- ② SSM 签名根密钥 ----------
say "② 签名根密钥"
# 刻意不由 CDK 创建：栈重建会换掉根密钥 → 所有已签发的 MCP token 立即失效，
# 全体用户被登出。所以由脚本创建且**只在不存在时**创建。
if aws_ ssm get-parameter --name "$STATE_PARAM" --with-decryption >/dev/null 2>&1; then
  echo "  已存在，保持不变（轮换会让所有 MCP token 失效）"
else
  aws_ ssm put-parameter --name "$STATE_PARAM" --type SecureString \
    --value "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" >/dev/null
  echo "  已创建 $STATE_PARAM"
fi

# Quick 走共享 client_secret（不走 DCR），需要一个稳定密钥
if aws_ ssm get-parameter --name "$CLIENT_SECRET_PARAM" --with-decryption >/dev/null 2>&1; then
  echo "  OAuth client secret 已存在"
else
  aws_ ssm put-parameter --name "$CLIENT_SECRET_PARAM" --type SecureString \
    --value "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')" >/dev/null
  echo "  已创建 $CLIENT_SECRET_PARAM"
fi
CLIENT_SECRET=$(aws_ ssm get-parameter --name "$CLIENT_SECRET_PARAM" --with-decryption \
  --query Parameter.Value --output text)

# ---------- ③ CDK ----------
say "③ CDK 部署"
# Lambda 依赖必须先装进 lambda/node_modules：@smithy/* 与 @aws-crypto/* 不能
# 指望 Node 20 运行时一定自带，asset 要自包含。
( cd lambda && npm install --omit=dev --no-fund --no-audit >/dev/null )
( cd infra && npm install --no-fund --no-audit >/dev/null && npx tsc --noEmit )
( cd infra && npx cdk deploy "$STACK" -c "slug=$SLUG" --require-approval never \
    --outputs-file "$ROOT/.deploy-outputs.json" )

out() { python3 -c "
import json,sys
d=json.load(open('$ROOT/.deploy-outputs.json'))
print(list(d.values())[0].get('$1',''))"; }

ENDPOINT=$(out Endpoint)
KMS_ARN=$(out UserSecretKmsKeyArn)
SECRET_PREFIX=$(out SecretPrefix)
OAUTH_FN=$(out OAuthFunctionName)
MW_FN=$(out MiddlewareFunctionName)
[ -n "$ENDPOINT" ] || { echo "  ✗ 未取到 CloudFront 端点"; exit 1; }
echo "  端点 $ENDPOINT"

# ---------- ④ 镜像 ----------
if [ "$BUILD_MODE" != "skip" ]; then
  # ⚠️ 变量名必须用 ${} 界定：紧跟全角括号时 bash 会把它的字节当成变量名的一部分，
  # 在 set -u 下直接报 `BUILD_MODE : unbound variable`（实测踩过）。
  say "④ 构建并推送镜像（${BUILD_MODE}）"
  aws_ ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1 \
    || aws_ ecr create-repository --repository-name "$ECR_REPO" \
         --image-scanning-configuration scanOnPush=true >/dev/null
  REG="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
  IMAGE_URI="${REG}/${ECR_REPO}:${IMAGE_TAG}"
fi

if [ "$BUILD_MODE" = "local" ]; then
  # 用**临时** DOCKER_CONFIG 而不是默认凭证存储。
  # 实测 finch 配了 creds_helpers: osxkeychain 时，login 会返回 Login Succeeded，
  # 但紧接着的 push 仍报 "no basic auth credentials" —— 凭证进了 keychain，
  # 推送路径读不回来。临时目录里没有 credsStore，凭证以明文落在该目录
  # （ECR 令牌 12 小时有效），推送完成后立即删除。
  TMPCFG=$(mktemp -d); chmod 700 "$TMPCFG"
  printf '{"auths":{}}' > "$TMPCFG/config.json"; chmod 600 "$TMPCFG/config.json"
  export DOCKER_CONFIG="$TMPCFG"
  cleanup_cfg() { [ -n "${TMPCFG:-}" ] && rm -rf "$TMPCFG"; unset DOCKER_CONFIG; }
  trap cleanup_cfg EXIT
  aws_ ecr get-login-password | "$DOCKER" login --username AWS --password-stdin "$REG" >/dev/null
  # 构建上下文是项目根：Dockerfile 需要 tools/ 与 docker/ 两棵子树
  "$DOCKER" build --platform linux/arm64 -f docker/Dockerfile -t "$IMAGE_URI" .
  "$DOCKER" push "$IMAGE_URI"
  cleanup_cfg; trap - EXIT
  echo "$IMAGE_URI" > .last-image
elif [ "$BUILD_MODE" = "codebuild" ]; then
  # 远程 ARM 构建：本机不需要容器运行时。桶名与项目名来自 CDK 输出。
  BUILD_BUCKET=$(out BuildSourceBucket)
  BUILD_PROJECT=$(out ImageBuildProject)
  [ -n "$BUILD_BUCKET" ] && [ -n "$BUILD_PROJECT" ] \
    || { echo "  ✗ 拿不到 CodeBuild 输出，CDK 是否为最新版本？"; exit 1; }
  AWS="$AWS" bash "$(dirname "$0")/build-remote.sh" \
    "$BUILD_BUCKET" "$BUILD_PROJECT" "$IMAGE_URI" "$REGION"
  echo "$IMAGE_URI" > .last-image
else
  IMAGE_URI=$(cat .last-image 2>/dev/null || true)
  [ -n "$IMAGE_URI" ] || { echo "  ✗ --skip-image 但没有 .last-image"; exit 1; }
  warn "跳过镜像构建，沿用 $IMAGE_URI"
fi

# ---------- ⑤ AgentCore Runtime ----------
say "⑤ AgentCore Runtime"
# 执行角色不由 CDK 建（Runtime 本身就不在 CDK 里），这里确保存在
ROLE_NAME="${RUNTIME_NAME}_role"
POLDIR=$(mktemp -d); trap 'rm -rf "$POLDIR"' EXIT

# 信任策略：**Condition 是必需的**。
# 只写 Principal.Service 会被 CreateAgentRuntime 拒掉：
#   ValidationException: Role validation failed ... verify that the role exists and
#   its trust policy allows assumption by this service
# 官方要求 aws:SourceAccount + aws:SourceArn 两个条件
# （bedrock-agentcore/latest/devguide/runtime-permissions.html → AgentCore Runtime trust policy）
cat > "$POLDIR/trust.json" <<EOF
{"Version":"2012-10-17","Statement":[{
  "Sid":"AssumeRolePolicy","Effect":"Allow",
  "Principal":{"Service":"bedrock-agentcore.amazonaws.com"},
  "Action":"sts:AssumeRole",
  "Condition":{
    "StringEquals":{"aws:SourceAccount":"${ACCOUNT_ID}"},
    "ArnLike":{"aws:SourceArn":"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:*"}}}]}
EOF

# 权限策略 = 官方要求的运行时最小集 + 本项目特有的凭证读写。
# 官方那部分不能省：容器要自己从 ECR 拉镜像、往 /aws/bedrock-agentcore/runtimes/* 写日志、
# 报 X-Ray 与 CloudWatch 指标、取 workload access token。
# 本项目额外需要：per-user secret 的读写 + CMK 加解密（凭证 blob）。
# 不需要 bedrock:InvokeModel —— 容器只调企业微信 CLI，不碰模型。
cat > "$POLDIR/perm.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"ECRImageAccess","Effect":"Allow",
  "Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],
  "Resource":["arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/*"]},
 {"Sid":"ECRTokenAccess","Effect":"Allow","Action":["ecr:GetAuthorizationToken"],"Resource":"*"},
 {"Effect":"Allow","Action":["logs:DescribeLogStreams","logs:CreateLogGroup"],
  "Resource":["arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*"]},
 {"Effect":"Allow","Action":["logs:PutResourcePolicy"],
  "Resource":["arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/${RUNTIME_NAME}-*"]},
 {"Effect":"Allow","Action":["logs:DescribeLogGroups"],
  "Resource":["arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*"]},
 {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],
  "Resource":["arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"]},
 {"Effect":"Allow","Action":["xray:PutTraceSegments","xray:PutTelemetryRecords",
   "xray:GetSamplingRules","xray:GetSamplingTargets"],"Resource":["*"]},
 {"Effect":"Allow","Action":"cloudwatch:PutMetricData","Resource":"*",
  "Condition":{"StringEquals":{"cloudwatch:namespace":"bedrock-agentcore"}}},
 {"Sid":"GetAgentAccessToken","Effect":"Allow",
  "Action":["bedrock-agentcore:GetWorkloadAccessToken",
            "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
            "bedrock-agentcore:GetWorkloadAccessTokenForUserId"],
  "Resource":["arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/default",
              "arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/default/workload-identity/${RUNTIME_NAME}-*"]},
 {"Sid":"WecomCredentialBlobs","Effect":"Allow",
  "Action":["secretsmanager:GetSecretValue","secretsmanager:PutSecretValue",
            "secretsmanager:CreateSecret","secretsmanager:DeleteSecret","secretsmanager:DescribeSecret",
            "secretsmanager:TagResource"],
  "Resource":"arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${SECRET_PREFIX}/*"},
 {"Sid":"WecomCredentialKms","Effect":"Allow",
  "Action":["kms:Encrypt","kms:Decrypt","kms:GenerateDataKey","kms:DescribeKey"],
  "Resource":"${KMS_ARN}"}]}
EOF

if aws_ iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  # 信任策略每次都重设：早期版本漏了 Condition，重跑要能自愈
  aws_ iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "file://$POLDIR/trust.json" >/dev/null
  echo "  执行角色已存在，信任策略已刷新"
else
  aws_ iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$POLDIR/trust.json" >/dev/null
  echo "  已创建执行角色 $ROLE_NAME"
fi
ROLE_ARN=$(aws_ iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)

aws_ iam put-role-policy --role-name "$ROLE_NAME" --policy-name wecom-mcp-runtime \
  --policy-document "file://$POLDIR/perm.json" >/dev/null
echo "  执行角色策略已更新"

# IAM 是最终一致的：角色刚建好就用会偶发 ValidationException
sleep 10

RESULT=$("$PY_BIN" scripts/agentcore.py \
  --name "$RUNTIME_NAME" --role-arn "$ROLE_ARN" --image-uri "$IMAGE_URI" \
  --region "$REGION" --authorize-base "$ENDPOINT" \
  --secret-prefix "$SECRET_PREFIX" --kms-key-arn "$KMS_ARN" \
  --app-tag "${SLUG:-default}")
RUNTIME_ARN=$(echo "$RESULT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["runtimeArn"])')
RUNTIME_ID=$(echo "$RESULT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["runtimeId"])')
echo "  $RUNTIME_ARN"

# ---------- ⑤b 容器日志的 CRITICAL 告警过滤器 ----------
# 必须在这里建、不能在 CDK 里建：容器的 CRITICAL 日志落在
# /aws/bedrock-agentcore/runtimes/<runtimeId>-{DEFAULT,ep}，而 runtimeId 由上面这步才产生。
# 早期版本把 filter 挂在 middleware 的 log group 上 —— 部署成功但告警永远不触发。
#
# 监控的是这两条（都由容器打）：
#   credential_writeback_failed  调用中 CLI 刷新了 token 但回写 Secrets Manager 失败
#   auth_writeback_failed        扫码成功但凭证落库失败（用户会以为授权成功了）
# 两条都意味着凭证可能丢失，而重新授权会新建机器人并永久失去对旧产物的写权限。
for SUFFIX in DEFAULT ep; do
  LG="/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-${SUFFIX}"
  if aws_ logs describe-log-groups --log-group-name-prefix "$LG" \
       --query 'logGroups[0].logGroupName' --output text 2>/dev/null | grep -q "$LG"; then
    aws_ logs put-metric-filter \
      --log-group-name "$LG" \
      --filter-name wecom-mcp-critical \
      --filter-pattern '{ $.level = "CRITICAL" }' \
      --metric-transformations \
        "metricName=CredentialWritebackLost,metricNamespace=WecomMcp,metricValue=1,defaultValue=0" \
      >/dev/null && echo "  告警过滤器已建: ${SUFFIX}"
  else
    warn "日志组尚不存在，跳过: $LG（容器首次被调用后重跑本脚本即可补上）"
  fi
done

# ---------- ⑥ 回填 Lambda 环境变量 ----------
say "⑥ 回填 Lambda 配置"
# ⚠️ update-function-configuration 会**替换整个 env**。
# 只传 RUNTIME_ARN 会把 CDK 设的其他变量全抹掉 —— 必须一次把完整集合重传。
# 参考实现在 deploy.sh:1433-1435 为此专门留了注释，是踩过的坑。
#
# ⚠️ 用 JSON 而不是 `Variables={k=v,k=v}` 简写：简写把**值里的逗号也当 key 分隔符**，
# ALLOWED_REDIRECT_HOSTS 是逗号分隔的多 host，用简写会报
#   ParamValidation: Expected: '=', received: '}'
# 用 python 生成 JSON 而非手拼字符串，顺带把引号转义交给 json 模块。
env_json() {
  "${PY_BIN:-python3}" -c '
import json, sys
print(json.dumps({"Variables": dict(kv.split("=", 1) for kv in sys.argv[1:])}))
' "$@"
}

COMMON_KV=(
  "DEPLOY_REGION=${REGION}"
  "STATE_SECRET_PARAM=${STATE_PARAM}"
  "SECRET_PREFIX=${SECRET_PREFIX}"
  "USER_SECRET_KMS_KEY_ARN=${KMS_ARN}"
  "AUTHORIZE_BASE=${ENDPOINT}"
  "RUNTIME_ARN=${RUNTIME_ARN}"
)

aws_ lambda update-function-configuration --function-name "$MW_FN" \
  --environment "$(env_json "${COMMON_KV[@]}")" >/dev/null
echo "  middleware ✓"

aws_ lambda update-function-configuration --function-name "$OAUTH_FN" \
  --environment "$(env_json "${COMMON_KV[@]}" \
    "OAUTH_CODES_TABLE=wecom-mcp-oauth-codes${SFX}" \
    "AUTH_FLOWS_TABLE=wecom-mcp-auth-flows${SFX}" \
    "REFRESH_TOKENS_TABLE=wecom-mcp-refresh-tokens${SFX}" \
    "IDENTITIES_TABLE=wecom-mcp-identities${SFX}" \
    "ACCESS_TOKEN_TTL_MINUTES=${ACCESS_TTL_MIN}" \
    "OAUTH_CLIENT_SECRET=${CLIENT_SECRET}" \
    "ALLOWED_REDIRECT_HOSTS=${REDIRECT_HOSTS}")" >/dev/null
echo "  oauth ✓"

# ---------- 完成 ----------
cat <<EOF

$(printf '\033[1;32m部署完成\033[0m')

  MCP 端点     ${ENDPOINT}/mcp
  授权入口     ${ENDPOINT}/authorize
  元数据       ${ENDPOINT}/.well-known/oauth-protected-resource

  客户端接入方式二选一：
    · 支持 DCR 的客户端（Kiro / Claude Code / Codex）：填 MCP 端点即可自注册
    · Quick（不走 DCR）：需手配 client_secret，取值见 SSM ${CLIENT_SECRET_PARAM}

  提醒：
    · 首次调用会返回 -32001 wecom_not_authorized，让用户走 ${ENDPOINT}/authorize 扫码
    · 每次重新授权都会在企业微信侧新建一个机器人，且新机器人无法修改旧机器人建的对象
    · 凭证回写失败会触发 CRITICAL 告警，务必订阅 SNS 主题
EOF
