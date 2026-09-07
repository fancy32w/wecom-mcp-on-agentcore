# 构建上下文是**项目根目录**（需要 tools/ 与 docker/ 两棵子树）：
#   finch build -f docker/Dockerfile -t wecom-mcp:dev .
#
# AgentCore Runtime 只支持 ARM64，且必须在 ARM64 机器上构建
#（x86_64 上无模拟构建会以 "exec /bin/sh: exec format error" 失败）
#
# 与 Lambda 运行时对齐到 Node 24。容器不受 Lambda 的运行时弃用策略约束（镜像是我们自己的），
# 但 Node 20 上游 LTS 维护也已结束，保持一致省得两套版本各自漂移。
FROM --platform=linux/arm64 node:24-alpine

# wecom-cli 的 linux-arm64 包是 statically linked stripped ELF aarch64，
# 容器内零额外运行时依赖 —— 实测在 alpine（musl，无 glibc）上直接跑通。
# 平台二进制来自 optionalDependencies；若 npm 配置禁用 optional deps 会静默缺失，
# 故显式再装一次平台包兜底（实测宿主机上就出现过只装了 shim 的情况）。
ARG WECOM_CLI_VERSION=1.1.0
RUN npm install -g --no-fund --no-audit \
      "@wecom/cli@${WECOM_CLI_VERSION}" \
      "@wecom/cli-linux-arm64@${WECOM_CLI_VERSION}" \
 && wecom-cli --version

WORKDIR /app

COPY docker/package.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY docker/server.js ./
COPY docker/lib ./lib

# 构建期生成工具目录：13 次 service --schema + 94 次 method --schema，秒级完成。
# --schema 实测不需要凭证也不需要网络（schema 内嵌在二进制里），所以构建期可用；
# 且这样能把工具定义与镜像里的 CLI 版本严格绑定，避免预生成产物与 CLI 漂移。
RUN apk add --no-cache python3
COPY tools ./tools
COPY schemas/tier1.txt ./schemas/tier1.txt
RUN python3 tools/extract-schemas.py /app/schemas \
 && python3 tools/to_mcp_schema.py /app/schemas --tier1 /app/schemas/tier1.txt \
 && rm -rf /app/schemas/methods          # 单方法原始 schema 只是中间产物，不入镜像

# 凭证物化到 tmpfs（目录 0700 / 文件 0600），CLI 的 cwd 也必须可写：
# --output-qrcode 只接受当前目录相对路径。
ENV WECOM_TMP_ROOT=/tmp/wc \
    WECOM_SCHEMA_DIR=/app/schemas \
    WECOM_SECRETS_PROVIDER=aws \
    NODE_ENV=production \
    PORT=8000

RUN mkdir -p /tmp/wc && chown -R node:node /tmp/wc /app
USER node

# AgentCore Runtime 探的是 8000，不是 8080。改了这个必须同步 server.js 的默认值。
EXPOSE 8000
CMD ["node", "server.js"]
