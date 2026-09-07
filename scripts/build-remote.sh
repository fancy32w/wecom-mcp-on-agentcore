#!/usr/bin/env bash
# 在 CodeBuild（ARM）上构建并推送容器镜像。
#
# 为什么需要它：AgentCore Runtime 只跑 ARM64，在 x86 机器上 docker build 会以
# `exec /bin/sh: exec format error` 失败。这条路让部署者**本地完全不需要容器运行时**，
# Windows / Intel Mac 也能部署。
#
# 用法（一般由 deploy.sh 调用，也可单独跑）：
#   bash scripts/build-remote.sh <bucket> <project> <image-uri> [region] [profile-args...]
set -euo pipefail

BUCKET="$1"; PROJECT="$2"; IMAGE_URI="$3"; REGION="${4:-us-east-1}"
shift 4 || true
AWSBIN="${AWS:-aws}"
aws_() { "$AWSBIN" --region "$REGION" "$@"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ZIP="$(mktemp -d)/source.zip"

# 只打包构建真正需要的东西。排除项都是有理由的：
#   node_modules  体积大且 Dockerfile 自己会装（宿主机装的还可能是错架构的二进制）
#   cdk.out       CDK 合成产物，含账号信息，不该进构建上下文
#   .venv .git    本地环境与历史
echo "① 打包源码"
zip -qr "$ZIP" . \
  -x '*/node_modules/*' 'node_modules/*' \
     '*/cdk.out/*' 'cdk.out/*' \
     '*/.venv/*' '.venv/*' \
     '*/.git/*' '.git/*' \
     '*.zip' '.last-image'
echo "   $(du -h "$ZIP" | cut -f1)"

echo "② 上传到 s3://${BUCKET}/source.zip"
aws_ s3 cp "$ZIP" "s3://${BUCKET}/source.zip" --only-show-errors
rm -rf "$(dirname "$ZIP")"

echo "③ 启动 CodeBuild"
BUILD_ID=$(aws_ codebuild start-build \
  --project-name "$PROJECT" \
  --environment-variables-override "name=IMAGE_URI,value=${IMAGE_URI},type=PLAINTEXT" \
  --query 'build.id' --output text)
echo "   $BUILD_ID"

echo "④ 等待构建完成（ARM 构建约 3-6 分钟）"
while true; do
  sleep 15
  read -r PHASE STATUS <<<"$(aws_ codebuild batch-get-builds --ids "$BUILD_ID" \
    --query 'builds[0].[currentPhase,buildStatus]' --output text)"
  printf '   %s / %s\n' "$PHASE" "$STATUS"
  [ "$STATUS" = "IN_PROGRESS" ] || break
done

if [ "$STATUS" != "SUCCEEDED" ]; then
  echo "   ✗ 构建失败（$STATUS）。日志："
  # 直接把日志位置打出来，省得再去控制台翻
  aws_ codebuild batch-get-builds --ids "$BUILD_ID" \
    --query 'builds[0].logs.[groupName,streamName]' --output text | sed 's/^/     /'
  echo "   查看： $AWSBIN logs tail <groupName> --log-stream-names <streamName> --region $REGION"
  exit 1
fi

echo "   ✓ 构建成功"
