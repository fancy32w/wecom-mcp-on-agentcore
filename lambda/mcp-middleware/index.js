'use strict';
/**
 * MCP 数据面中间层。
 *
 * 职责只有三件（照搬参考实现 lambda/mcp-middleware/index.ts 的形态）：
 *   1. 验 MCP token（HMAC 自验证，不查库）
 *   2. 未授权时按两条不同语义返回 —— 这个区分容易配错，见下
 *   3. SigV4 签名转发到 AgentCore Runtime，把 userId 经 header 注入容器
 *
 * ⚠️ AgentCore 侧必须把注入的 header 放进 requestHeaderAllowlist，否则会被**静默丢弃**：
 *      X-Runtime-User-Id
 *    （参考实现是 X-User-Access-Token / X-Runtime-User-Id / X-Incr-Auth-Token）
 *    漏配的表现是容器永远拿不到身份、每次都回 wecom_not_authorized，且没有任何报错。
 *
 * 与参考实现的差异：这里**不取 SaaS 凭证**。飞书版 middleware 要从 Secrets Manager 读出
 * user access token 塞进 header；企业微信的凭证是一个目录 blob、只能由容器物化，
 * 所以 middleware 只传 userId，取凭证的事在容器里做（docker/lib/credentials.js）。
 * 好处是 middleware 不再需要 KMS Decrypt 权限，攻击面更小。
 */

const { verifyMcpToken } = require('../shared/tokens');
const { SignatureV4 } = require('@smithy/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { HttpRequest } = require('@smithy/protocol-http');

/**
 * 直接从环境变量取凭证，而不是拉 @aws-sdk/credential-provider-node。
 *
 * Lambda 运行时保证注入 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN，
 * 所以在 Lambda 里这三行就够了。少一个依赖 = 部署包更小（见 infra 里关于 asset 体积的注释）。
 * 注意：运行时只暴露 @aws-sdk/client-*，`@smithy/*` 必须自己打包 —— 实测漏了会报
 * Runtime.ImportModuleError: Cannot find module '@smithy/signature-v4'。
 */
const credentials = () => Promise.resolve({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
});

const REGION = process.env.DEPLOY_REGION || process.env.AWS_REGION || 'us-east-1';
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const AUTHORIZE_BASE = process.env.AUTHORIZE_BASE;
const FETCH_BUDGET_MS = Number(process.env.FETCH_BUDGET_MS || 25000);

const signer = new SignatureV4({
  service: 'bedrock-agentcore',
  region: REGION,
  credentials,
  sha256: Sha256,
});

function reply(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const headers = lower(event.headers || {});
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization || '');

  // 【语义一】完全没有 MCP token → 401 + RFC 9728 指针，客户端据此去发现授权服务器
  if (!bearer) {
    return reply(401, { error: 'unauthorized' }, {
      'WWW-Authenticate':
        `Bearer realm="wecom-mcp", resource_metadata="${AUTHORIZE_BASE}/.well-known/oauth-protected-resource"`,
    });
  }

  const claims = await verifyMcpToken(bearer[1]);
  if (!claims) {
    return reply(401, { error: 'invalid_token' }, {
      'WWW-Authenticate':
        `Bearer realm="wecom-mcp", error="invalid_token", resource_metadata="${AUTHORIZE_BASE}/.well-known/oauth-protected-resource"`,
    });
  }

  // 【语义二】MCP token 合法但企业微信凭证缺失 → 由**容器**返回 -32001 wecom_not_authorized。
  // 参考实现在 middleware 这一层先探测 SaaS 凭证再回 403 + authorize_url；
  // 我们把这个判断留在容器里（凭证只有容器能读），middleware 不介入。
  // 客户端拿到 -32001 后去 /authorize 走扫码。

  if (!RUNTIME_ARN) return reply(500, { error: 'runtime_not_configured' });

  const url = new URL(
    `https://bedrock-agentcore.${REGION}.amazonaws.com`
    + `/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations`,
  );
  url.searchParams.set('qualifier', process.env.RUNTIME_QUALIFIER || 'ep');

  const req = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname: url.hostname,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      host: url.hostname,
      'content-type': 'application/json',
      // AgentCore 在 serverProtocol=MCP 下**强制校验** Accept 头，缺了会被拒：
      //   "MCP Accept header must contain: application/json, text/event-stream"
      // 不能只转发客户端的 Accept —— 客户端可能只发 application/json。
      accept: 'application/json, text/event-stream',
      // 身份注入。必须同时出现在 AgentCore 的 requestHeaderAllowlist 里。
      'X-Runtime-User-Id': claims.userId,
    },
    body: event.body || '{}',
  });

  const signed = await signer.sign(req);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_BUDGET_MS);
  try {
    const r = await fetch(`${url.origin}${url.pathname}${url.search}`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: ac.signal,
    });
    const text = await r.text();
    if (r.status >= 500) {
      console.error(JSON.stringify({ level: 'ERROR', event: 'agentcore_5xx', status: r.status }));
    }
    return {
      statusCode: r.status,
      headers: { 'Content-Type': r.headers.get('content-type') || 'application/json' },
      body: text,
    };
  } catch (e) {
    const aborted = e.name === 'AbortError';
    console.error(JSON.stringify({
      level: 'ERROR', event: aborted ? 'agentcore_timeout' : 'agentcore_fetch_failed',
      error: String(e.message || e),
    }));
    return reply(aborted ? 504 : 502, { error: aborted ? 'upstream_timeout' : 'upstream_error' });
  } finally {
    clearTimeout(timer);
  }
};

function lower(h) {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}
