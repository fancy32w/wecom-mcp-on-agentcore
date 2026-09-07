#!/usr/bin/env bash
# 打出一个可以直接交给客户的干净压缩包。
#
# 排除规则是这个脚本存在的全部理由 —— 手工打包一定会漏掉某一项：
#   docs/security_zh.md  内部材料，不随包交付（合规话题由客户团队自行处理）
#   docs/改造评估.md   内部评估与决策过程记录，含我方账号 ID 与验证环境域名，不交付
#   infra/cdk.out      CDK 合成产物，含账号 ID、S3 asset 桶名、角色 ARN
#   node_modules       客户自己 npm install（宿主机装的还可能是错架构的二进制）
#   .venv              本地虚拟环境
#   .last-image        上次构建的镜像 URI，含我方账号
#   .deploy-outputs.json  CDK 输出快照，含我方账号 ID 与验证环境 CloudFront 域名
#   scripts/package-delivery.sh  本脚本自身：它的扫描模式里就写着那些敏感串，
#                                 且客户不需要再打包一次
#   .git               提交历史
#
# 打完会自动扫一遍成品里有没有身份/账号/域名残留，扫到就直接失败，不让它出门。
#
# 用法： bash scripts/package-delivery.sh [输出目录]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/../wecom-mcp-delivery}"
STAMP="$(date +%Y%m%d)"
NAME="wecom-mcp-on-agentcore-${STAMP}"
STAGE="$(mktemp -d)/${NAME}"

mkdir -p "$STAGE" "$OUT_DIR"
cd "$ROOT"

echo "① 复制源码到暂存区"
# 用 tar 管道而不是 cp -r：排除规则一次写清，且不会把符号链接展开
tar -cf - \
  --exclude='./docs/改造评估.md' \
  --exclude='./docs/security_zh.md' \
  --exclude='./infra/cdk.out' \
  --exclude='*/node_modules' --exclude='./node_modules' \
  --exclude='./.venv' \
  --exclude='./.git' \
  --exclude='./.last-image' \
  --exclude='./.deploy-outputs.json' \
  --exclude='./scripts/package-delivery.sh' \
  --exclude='*.zip' \
  . | (cd "$STAGE" && tar -xf -)

echo "② 检查交付物完整性"
for f in README.md docs/deployment_zh.md docs/limitations_zh.md docs/connect-mcp-clients_zh.md \
         scripts/run-deploy.sh scripts/deploy.sh scripts/build-remote.sh \
         infra/lib/wecom-mcp-stack.ts docker/Dockerfile; do
  [ -f "$STAGE/$f" ] || { echo "   ✗ 缺少 $f"; exit 1; }
done
echo "   必需文件齐全"

echo "③ 扫描敏感残留"
# 检测项：ECR 镜像 URI 里的 12 位账号 ID、任意 CloudFront 域名、真实企业微信用户/机器人 ID。
# 刻意写成**通用模式**而不是硬编码我方的具体值 —— 本仓库是公开的，把自己的线上域名
# 写进检测模式等于把它发布出去；通用模式还能同时挡住任何人的泄漏，不只是我们的。
# 脱敏占位符（wo_EXAMPLE / aibEXAMPLE / <MCP_ENDPOINT>）需排除，否则会自己误报。
PATTERNS='[0-9]{12}\.dkr\.ecr|[a-z0-9]{12,14}\.cloudfront\.net|wo_[A-Za-z0-9_-]{10,}|aib[A-Za-z0-9_-]{10,}'
PLACEHOLDERS='wo_EXAMPLE|aibEXAMPLE|MCP_ENDPOINT'
# 逐**行**判定而不是逐文件：同一个文件里可能既有占位符又有真实残留，
# 按文件豁免会把真的漏掉。
BAD=$(cd "$STAGE" && grep -rEn "$PATTERNS" . 2>/dev/null \
        | grep -vE "$PLACEHOLDERS" \
        | cut -d: -f1 | sort -u || true)
if [ -n "$BAD" ]; then
  echo "   ✗ 以下文件仍含敏感信息，交付中止："
  echo "$BAD" | sed 's/^/     /'
  exit 1
fi
echo "   干净"

echo "④ 压缩"
(cd "$(dirname "$STAGE")" && zip -qr "$OUT_DIR/${NAME}.zip" "$NAME")
rm -rf "$(dirname "$STAGE")"

echo
echo "✓ 交付包： $OUT_DIR/${NAME}.zip"
echo "  $(du -h "$OUT_DIR/${NAME}.zip" | cut -f1)"
echo
echo "  交给客户时请一并说明："
echo "   1. 运维照 docs/deployment_zh.md 做，逐步都有「看到什么算对」"
echo "   2. 先读 docs/limitations_zh.md —— 每次授权会新建一个企业微信机器人"
echo "   3. 部署完把 docs/connect-mcp-clients_zh.md 里的 <MCP_ENDPOINT> 换成实际端点再发给员工"
