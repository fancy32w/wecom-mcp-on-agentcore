#!/usr/bin/env bash
# deploy.sh 的运行包装：**自动探测**本机工具，把环境差异收在一个文件里。
#
# 为什么需要它：
#  1. GUI / launchd 派生的 shell 常缺 /usr/local/bin，`aws` 不在 PATH；容器运行时
#     可能是 finch / podman / nerdctl 而不是 docker；boto3 常装在项目内虚拟环境里。
#  2. 调用方只需一行命令，不必记一串 export。
#
# 三个变量都可以从外部覆盖，探测失败时也会给出可执行的补救建议：
#     AWS=/path/to/aws DOCKER=/path/to/podman PY_BIN=/path/to/python \
#       bash scripts/run-deploy.sh --region ap-northeast-1
#
# 用法：bash scripts/run-deploy.sh [传给 deploy.sh 的参数...]
#   常用：--region <区域>  --build auto|local|codebuild  --skip-image

set -euo pipefail
cd "$(dirname "$0")/.."

# GUI 派生的 shell 常缺这两个目录，补进 PATH 再探测
PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export PATH

# ---------- aws CLI（必需） ----------
if [ -z "${AWS:-}" ]; then
  AWS="$(command -v aws || true)"
fi
if [ -z "$AWS" ]; then
  echo "✗ 找不到 aws CLI。安装：https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  echo "  已装但探测不到时显式指定：AWS=/full/path/to/aws bash scripts/run-deploy.sh ..."
  exit 1
fi
export AWS

# ---------- 容器运行时（可选） ----------
# 找不到不算错：deploy.sh 会自动改走 CodeBuild(ARM) 远程构建，本机无需容器环境。
if [ -z "${DOCKER:-}" ]; then
  # 两轮探测：先找**守护进程真的能响应**的，全都不响应时再退回「存在但没起来」的那个，
  # 好让 deploy.sh 打出准确的提示。只按 PATH 顺序取第一个存在的容易选中一个装了
  # 但没运行的 docker，从而白等一次失败。
  for c in docker finch podman nerdctl "$HOME/.toolbox/bin/finch"; do
    if command -v "$c" >/dev/null 2>&1 && "$c" info >/dev/null 2>&1; then DOCKER="$c"; break; fi
  done
fi
if [ -z "${DOCKER:-}" ]; then
  for c in docker finch podman nerdctl "$HOME/.toolbox/bin/finch"; do
    if command -v "$c" >/dev/null 2>&1; then DOCKER="$c"; break; fi
  done
fi
export DOCKER="${DOCKER:-docker}"

# ---------- python + boto3（必需，AgentCore Runtime 不走 CDK） ----------
if [ -z "${PY_BIN:-}" ]; then
  for p in "$PWD/.venv/bin/python" python3 python; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import boto3' >/dev/null 2>&1; then
      PY_BIN="$p"; break
    fi
  done
fi
if [ -z "${PY_BIN:-}" ]; then
  echo "✗ 找不到带 boto3 的 python。创建一个："
  echo "    python3 -m venv .venv && .venv/bin/pip install boto3"
  echo "  然后重跑本脚本（会自动认到 .venv/bin/python）。"
  exit 1
fi
export PY_BIN

echo "工具： aws=$AWS"
echo "      container=$DOCKER$(command -v "$DOCKER" >/dev/null 2>&1 || echo '  (未找到 → 走 CodeBuild 远程构建)')"
echo "      python=$PY_BIN"

exec bash scripts/deploy.sh "$@"
