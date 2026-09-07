'use strict';
/**
 * OAuth 授权服务器（企业微信版）。
 *
 * 与参考实现最大的结构差异：**没有 /callback，也没有刷新 cron**。
 *
 *   飞书版：/authorize → 302 到飞书 → 飞书回调 /callback 带 code → exchangeCode 换 token
 *           + EventBridge 每 30min 刷新 refresh_token
 *
 *   企业微信：/authorize → 让容器起扫码会话 → 返回一个带链接的页面 + 前端轮询
 *           → 容器在 CLI 成功退出时**自己**把凭证落库（推送式，见 docker/lib/auth.js）
 *           → 本 Lambda 只负责把「已授权」翻译成客户端要的 authorization_code
 *
 *   刷新 cron 不需要：wecom-cli 在每次真实调用中自行刷新 access token，
 *   容器按 credentials.enc 的 mtime 判定并回写（docker/lib/credentials.js）。
 *   ⚠️ 遗留风险：长期不活跃的用户凭证是否会过期未验证。若会，需要一个定时任务
 *   触发容器做一次空转调用来保活 —— 这件事只能在容器里做（Lambda 没有 wecom-cli）。
 *
 * 路由：
 *   GET  /.well-known/oauth-authorization-server   RFC 8414
 *   GET  /.well-known/oauth-protected-resource     RFC 9728
 *   POST /register                                 RFC 7591 DCR
 *   GET  /authorize                                起扫码会话 + 返回轮询页
 *   GET  /authorize/status                         轮询；授权完成后签发 authorization_code
 *   POST /token                                    code → MCP token
 */

const crypto = require('crypto');
const {
  DynamoDBClient, PutItemCommand, DeleteItemCommand, GetItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { SignatureV4 } = require('@smithy/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { HttpRequest } = require('@smithy/protocol-http');

// 见 mcp-middleware/index.js 的说明：Lambda 运行时注入这三个环境变量，
// 直接读比拉 @aws-sdk/credential-provider-node 省一个依赖。
const credentials = () => Promise.resolve({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
});

const T = require('../shared/tokens');

const REGION = process.env.DEPLOY_REGION || process.env.AWS_REGION || 'us-east-1';
const BASE = process.env.AUTHORIZE_BASE;
const CODES_TABLE = process.env.OAUTH_CODES_TABLE;
const FLOWS_TABLE = process.env.AUTH_FLOWS_TABLE;
const REFRESH_TABLE = process.env.REFRESH_TOKENS_TABLE;
// 真人身份 → 当前在用的凭证槽位。缺失时 resolveIdentitySlot 退化为不去重。
const IDENT_TABLE = process.env.IDENTITIES_TABLE;
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const SHARED_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const ALLOWED_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * 唯一 scope。本服务的授权粒度就是「以授权人身份访问其企业微信」，没有更细的分级，
 * 所以只声明一个。必须在两份元数据里都出现并在 /token 响应里回显 —— 见
 * oauth-protected-resource 处关于 Quick 默认 scope 的注释。
 */
const SCOPE = 'wecom';

// 扫码轮询上限与 CLI 内部一致（实测硬编码 300s），流程 TTL 对齐
const FLOW_TTL_S = 300;
const CODE_TTL_S = 300;

const ddb = new DynamoDBClient({ region: REGION });
const signer = new SignatureV4({
  service: 'bedrock-agentcore', region: REGION,
  credentials, sha256: Sha256,
});

// ---------- 工具 ----------

const J = (code, obj, headers = {}) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(obj),
});
const HTML = (code, html) => ({
  statusCode: code,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: html,
});

/**
 * redirect_uri 校验：**精确比对 host**，不用正则。
 * 参考实现同样如此（前缀/正则匹配是开放重定向的经典来源）。
 */
function redirectAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) return false;
  return loopback || ALLOWED_HOSTS.includes(u.hostname);
}

/** 经 AgentCore 调容器的 JSON-RPC（容器的 /auth/* HTTP 路径从这里走不通，见 server.js 注释） */
async function callRuntime(method, params, userId) {
  const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
  const path = `/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations`;
  const query = { qualifier: process.env.RUNTIME_QUALIFIER || 'ep' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

  const signed = await signer.sign(new HttpRequest({
    method: 'POST', protocol: 'https:', hostname: host, path, query,
    headers: {
      host,
      'content-type': 'application/json',
      // AgentCore 在 serverProtocol=MCP 下**强制校验**这个头，缺了直接报
      //   "MCP Accept header must contain: application/json, text/event-stream"
      // 这是 MCP Streamable HTTP 规范的要求，只有真部署才会撞到。
      accept: 'application/json, text/event-stream',
      'X-Runtime-User-Id': userId,
    },
    body,
  }));
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`https://${host}${path}?${qs}`, {
    method: 'POST', headers: signed.headers, body: signed.body,
  });
  const text = await r.text();
  // 容器回的是单帧 SSE
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : text);
  if (payload.error) throw new Error(payload.error.message || 'runtime_error');
  return payload.result;
}

// ---------- 路由 ----------

exports.handler = async (event) => {
  const path = event.rawPath || event.path || '';
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const q = event.queryStringParameters || {};

  try {
    if (method === 'GET' && path.endsWith('/.well-known/oauth-authorization-server')) {
      return J(200, {
        issuer: BASE,
        authorization_endpoint: `${BASE}/authorize`,
        token_endpoint: `${BASE}/token`,
        registration_endpoint: `${BASE}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        // offline_access 一并声明：查到 Quick 对 OneDrive / SharePoint 这类连接器是靠这个
        // scope 触发 refresh token 签发的（quick/latest/userguide/sharepoint-kb-troubleshooting.html
        // → Token refresh with user-managed setup）。MCP 连接器是否同样看它，官方文档没写明，
        // 声明出来成本为零；客户端不要也不影响。
        scopes_supported: [SCOPE, 'offline_access'],
        // 两条客户端认证路径：DCR 公开客户端（none）与共享密钥机密客户端
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
    }

    if (method === 'GET' && path.endsWith('/.well-known/oauth-protected-resource')) {
      return J(200, {
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
        // ⚠️ scopes_supported 必须显式声明，不能省。
        // Quick 云端的文档明确写了两条行为（quick/latest/userguide/mcp-integration.html
        // → Limitations → Scope handling）：
        //   1. 它**不读** 401 WWW-Authenticate 里的 scope，只从本文档取；
        //   2. 本文档没写 scopes_supported 时，它会**自己套一组默认 scope**，
        //      而不是不带 —— 「might cause authentication failures with servers
        //      that do not recognize the default scopes」。
        // 所以这里主动给出唯一 scope，让客户端要的就是我们认的。
        scopes_supported: [SCOPE, 'offline_access'],
        bearer_methods_supported: ['header'],
      });
    }

    if (method === 'POST' && path.endsWith('/register')) return register(event);
    // 顺序要紧：/authorize/self/status 必须在 /authorize/status 与 /authorize 之前判
    if (method === 'GET' && path.includes('/authorize/self/status')) return selfStatus(event);
    if (method === 'GET' && path.endsWith('/authorize/self')) return selfAuthorize();
    if (method === 'GET' && path.includes('/authorize/status')) return authorizeStatus(q);
    if (method === 'GET' && path.endsWith('/authorize')) return authorize(q);
    if (method === 'POST' && path.endsWith('/token')) return token(event);

    return J(404, { error: 'not_found' });
  } catch (e) {
    console.error(JSON.stringify({ level: 'ERROR', event: 'oauth_unhandled', path, error: String(e.message || e) }));
    return J(500, { error: 'server_error' });
  }
};

// ---------- RFC 7591 DCR ----------

async function register(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return J(400, { error: 'invalid_request' }); }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    return J(400, { error: 'invalid_redirect_uri' });
  }
  if (!uris.every(redirectAllowed)) return J(400, { error: 'invalid_redirect_uri' });

  const clientId = await T.signClientId({ redirect_uris: uris });
  return J(201, {
    client_id: clientId,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
}

// ---------- /authorize ----------

async function authorize(q) {
  const { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge } = q;
  if (q.code_challenge_method && q.code_challenge_method !== 'S256') {
    return J(400, { error: 'invalid_request', error_description: 'only S256' });
  }
  if (!challenge) return J(400, { error: 'invalid_request', error_description: 'PKCE required' });
  if (!redirectUri || !redirectAllowed(redirectUri)) return J(400, { error: 'invalid_redirect_uri' });

  const client = clientId ? await T.verifyClientId(clientId) : null;
  if (clientId && !client) return J(400, { error: 'invalid_client' });
  if (client && !client.redirect_uris.includes(redirectUri)) {
    return J(400, { error: 'invalid_redirect_uri', error_description: 'not registered for this client' });
  }

  // userId 在扫码之前就必须存在（企业微信不像飞书那样回调带身份）
  const userId = T.newUserId();
  let started;
  try {
    started = await callRuntime('wecom/auth.start', {}, userId);
  } catch (e) {
    return J(502, { error: 'auth_start_failed', error_description: String(e.message || e) });
  }
  if (!started.authorizeUrl) return J(502, { error: 'auth_start_failed' });

  const flowId = crypto.randomBytes(16).toString('hex');
  await ddb.send(new PutItemCommand({
    TableName: FLOWS_TABLE,
    Item: {
      flowId: { S: flowId },
      userId: { S: userId },
      redirectUri: { S: redirectUri },
      clientState: { S: state || '' },
      codeChallenge: { S: challenge },
      containerSession: { S: started.sessionId || '' },
      ttl: { N: String(Math.floor(Date.now() / 1000) + FLOW_TTL_S) },
    },
  }));

  return HTML(200, scanPage(flowId, started.authorizeUrl, started.qrPngBase64));
}

/**
 * 扫码页（OAuth 授权码流的 /authorize 落地页，Quick 云端走这条）。
 * 轮询 /authorize/status，拿到 redirect 就跳回客户端。
 *
 * 二维码就地显示，**不跳新标签**：旧版只给一个 target="_blank" 按钮，
 * 用户点进去后盯着新标签看，而跳转发生在原标签 —— 扫码成功了却以为卡住。
 */
function scanPage(flowId, wecomUrl, qrBase64) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const qrBlock = qrBase64
    ? `<img id="qr" alt="企业微信授权二维码" width="240" height="240"
         src="data:image/png;base64,${qrBase64}">`
    : `<p><a class="btn" href="${esc(wecomUrl)}" target="_blank" rel="noopener">打开企业微信授权页</a></p>
       <p class="hint">二维码未能生成，改为跳转。<strong>扫码完成后请回到本页</strong>，本页会自动跳回客户端。</p>`;

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>企业微信授权</title>
<style>
body{font:16px/1.7 system-ui,-apple-system,sans-serif;max-width:36rem;margin:5vh auto;padding:0 1.5rem;color:#1a1a1a}
h2{margin-bottom:.3rem}
#qr{border:1px solid #e8e8e8;border-radius:8px;padding:10px;background:#fff;display:block}
a.btn{display:inline-block;background:#07c160;color:#fff;padding:.7rem 1.4rem;border-radius:6px;text-decoration:none;font-weight:600}
.warn{background:#fff7e6;border-left:4px solid #fa8c16;padding:.8rem 1rem;margin:1.2rem 0;font-size:.94rem}
.hint{color:#666;font-size:.92rem}
#s{margin-top:1.2rem;color:#666}
</style>
<h2>用企业微信扫码授权</h2>
<p class="hint">授权后，该 MCP 客户端将以<strong>你本人的企业微信身份</strong>访问日程、文档、通讯录等。</p>

<div class="warn">
<strong>安全提醒</strong>：只扫<strong>你自己发起的这个页面</strong>上的二维码。
如果这个链接是别人发给你的，扫了对方就能以你的身份操作企业微信 —— 不要扫。
</div>

${qrBlock}
<p id="s">等待扫码…（5 分钟内有效）</p>
<p class="hint">扫码后企业微信会问你：<strong>新建一个「机器人」</strong>，还是<strong>绑定已有的</strong>。
第一次授权只能新建。<strong>如果你以前授权过，请选「绑定已有机器人」并选中原来那个</strong> ——
选新建会让你失去对旧机器人所建文档、表格、日程的编辑权限，且无法恢复。</p>
<script>
const f=${JSON.stringify(flowId)};
let n=0;
async function tick(){
  n++;
  try{
    const r=await fetch('authorize/status?flow='+encodeURIComponent(f),{cache:'no-store'});
    const d=await r.json();
    if(d.redirect){location.href=d.redirect;return}
    if(d.status==='expired'||d.status==='failed'){
      document.getElementById('s').textContent='授权未完成：'+(d.reason||d.status)+'，请重新发起。';return}
  }catch(e){}
  if(n>110){document.getElementById('s').textContent='超时，请重新发起授权。';return}
  setTimeout(tick,3000);
}
tick();
</script></html>`;
}

/**
 * 探测某个凭证槽位的状态，并顺带取出它属于哪个真人。
 *
 * 为什么必须以 Secrets Manager 为准（而不是容器内存）：容器把授权会话存在进程内存里，
 * 而 AgentCore 会把请求分发到**多个实例**。实测撞到过：
 *   /authorize        → 落在实例 A，A 起 CLI、扫码成功、把凭证写进 Secrets Manager
 *   /authorize/status → 落在实例 B，B 内存里没有这个会话，返回 { status: 'unknown' }
 * Lambda 原样透传 unknown，而页面只认 redirect / expired / failed，
 * 于是**永远停在「等待扫码」**，尽管授权早就成功、凭证也已落库。
 *
 * 用「密钥是否存在」作为完成信号是安全的：每个授权流都由 T.newUserId() 生成一个
 * 全新随机 userId，此前不可能存在同名密钥 —— 存在即等于「这一次流程完成了」。
 *
 * 身份从 **Tag** 读，不从 SecretString 读：DescribeSecret 会带回 Tags 且**不解密**，
 * 所以这个 Lambda 始终不需要 GetSecretValue（IAM 里也刻意没给）。
 * 容器写凭证时把 wo_… 打进 WecomUserId 标签，正是为了这里能免解密拿到人。
 */
async function describeCredential(userId) {
  const { SecretsManagerClient, DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const prefix = process.env.SECRET_PREFIX || 'wecom-mcp-on-agentcore/users';
  try {
    const r = await sm.send(new DescribeSecretCommand({ SecretId: `${prefix}/${userId}` }));
    const tag = (r.Tags || []).find((t) => t.Key === 'WecomUserId');
    return { landed: true, wecomUserId: tag ? tag.Value : null };
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return { landed: false, wecomUserId: null };
    // 其他错误（权限/限流）不该被当成「没授权」而让用户干等，记下来并按未完成处理
    console.error(JSON.stringify({
      level: 'WARN', event: 'credential_probe_failed', userId, error: String(e.name || e),
    }));
    return { landed: false, wecomUserId: null };
  }
}

/** 兼容旧调用点：只关心「落库了没有」 */
async function credentialLanded(userId) {
  return (await describeCredential(userId)).landed;
}

/**
 * 旧凭证槽位现在还能用吗 —— 必须真打一次企业微信才知道。
 *
 * 不能用「密钥是否存在」代替：密钥和机器人是两回事。用户在企业微信里**删掉机器人**后，
 * 密钥照样在，但调用会返回 errcode 853005 cli token invalid（2026-08-27 实测：
 * 5 条历史凭证因机器人被删而全部失效，而同一人未被删的两条同时有效）。
 *
 * 探针用查不到结果的关键词，负载几十字节。
 */
async function probeSlotAlive(userId) {
  try {
    const r = await callRuntime('tools/call', {
      name: 'wecom_contact_users_search',
      arguments: { keyword: '__wecom_mcp_identity_probe__' },
    }, userId);
    return !(r && r.isError);
  } catch (e) {
    console.error(JSON.stringify({
      level: 'WARN', event: 'slot_probe_failed', userId, error: String(e.message || e),
    }));
    return false;
  }
}

/**
 * 把「这一次授权」收敛到「这个人的那一个槽位」。
 *
 * 同一个人每走一遍授权流程都会拿到一个全新随机 userId（扫码前无从得知他是谁，
 * 这是鸡生蛋，避不开），于是凭证会越堆越多、撤销一个人要满地找、
 * 而且**新机器人不拥有旧机器人建的对象**，写权限会断。
 *
 * 这里的处理：认出是老用户且旧槽位还活着，就继续用旧槽位 —— 重新授权因此变成幂等操作，
 * 对旧文档的编辑权不再丢失。旧槽位已死（机器人被删）才切到新的。
 *
 * 返回实际应当签发令牌的 userId。
 */
async function resolveIdentitySlot(flowUserId, containerIdentity) {
  if (!IDENT_TABLE) return flowUserId;

  let wecomUserId = containerIdentity && containerIdentity.userId;
  if (!wecomUserId) wecomUserId = (await describeCredential(flowUserId)).wecomUserId;
  // 身份探针失败时退化为原行为：一次授权一个槽位，不做去重但也不出错
  if (!wecomUserId) return flowUserId;

  const prev = await ddb.send(new GetItemCommand({
    TableName: IDENT_TABLE, Key: { wecomUserId: { S: wecomUserId } }, ConsistentRead: true,
  }));
  const prevSlot = prev.Item && prev.Item.userId.S;

  if (prevSlot && prevSlot !== flowUserId && await probeSlotAlive(prevSlot)) {
    console.log(JSON.stringify({
      level: 'INFO', event: 'identity_slot_reused', wecomUserId,
      reusedSlot: prevSlot, discardedSlot: flowUserId,
      note: '同一人重复授权，复用旧槽位以保住对旧机器人所建对象的写权限',
    }));
    return prevSlot;
  }

  await ddb.send(new PutItemCommand({
    TableName: IDENT_TABLE,
    Item: {
      wecomUserId: { S: wecomUserId },
      userId: { S: flowUserId },
      userName: { S: (containerIdentity && containerIdentity.userName) || '' },
      updatedAt: { S: new Date().toISOString() },
    },
  }));
  console.log(JSON.stringify({
    level: 'INFO', event: prevSlot ? 'identity_slot_replaced' : 'identity_slot_registered',
    wecomUserId, slot: flowUserId, deadSlot: prevSlot || undefined,
  }));
  return flowUserId;
}

async function authorizeStatus(q) {
  const flowId = q.flow;
  if (!flowId) return J(400, { error: 'invalid_request' });

  const got = await ddb.send(new GetItemCommand({
    TableName: FLOWS_TABLE, Key: { flowId: { S: flowId } }, ConsistentRead: true,
  }));
  if (!got.Item) return J(200, { status: 'expired', reason: 'flow_not_found' });

  const userId = got.Item.userId.S;
  const st = await callRuntime('wecom/auth.status',
    { sessionId: got.Item.containerSession.S || undefined }, userId);

  let ok = st.status === 'authorized' || st.status === 'already_authorized';
  if (!ok && await credentialLanded(userId)) {
    ok = true;
    console.log(JSON.stringify({
      level: 'INFO', event: 'auth_confirmed_via_secret', userId,
      containerStatus: st.status, note: '容器状态来自另一个实例，改以密钥落库为准',
    }));
  }
  if (!ok) return J(200, { status: st.status, reason: st.reason });

  // 同一人重复授权收敛到同一槽位（详见 resolveIdentitySlot）
  const slot = await resolveIdentitySlot(userId, st.wecomIdentity);

  // 授权成功：凭证已由容器落库。这里只签发客户端要的 authorization_code。
  const code = crypto.randomBytes(32).toString('hex');
  await ddb.send(new PutItemCommand({
    TableName: CODES_TABLE,
    Item: {
      code: { S: code },
      userId: { S: slot },
      codeChallenge: { S: got.Item.codeChallenge.S },
      redirectUri: { S: got.Item.redirectUri.S },
      ttl: { N: String(Math.floor(Date.now() / 1000) + CODE_TTL_S) },
    },
  }));
  await ddb.send(new DeleteItemCommand({
    TableName: FLOWS_TABLE, Key: { flowId: { S: flowId } },
  }));

  const u = new URL(got.Item.redirectUri.S);
  u.searchParams.set('code', code);
  if (got.Item.clientState.S) u.searchParams.set('state', got.Item.clientState.S);
  return J(200, { status: 'authorized', redirect: u.toString() });
}

// ---------- 自助取 token（给没有 OAuth 流程的客户端） ----------
//
// 为什么需要：Quick Desktop 的 Remote MCP 只有 URL + Headers 两个输入，**没有 OAuth 流程**
// —— 它不会跳浏览器、不会走 /authorize，只能发静态 header。所以 Desktop 用户拿不到
// MCP token。这条路让用户自己在浏览器里扫码，然后把 token 贴进 Quick Desktop 的
// Authorization header。
//
// ⚠️ 固有的钓鱼风险（扫码登录类流程都有）：攻击者自己发起 flow、把二维码转发给受害者，
// 受害者扫码后攻击者去取 token，就得到了以受害者身份调用的凭据。三道防线：
//   1. **浏览器绑定**：发起时下发 HttpOnly cookie，取 token 时校验；flowId 泄漏
//      （日志 / Referer / 转发链接）本身不足以取到 token
//   2. **一次性**：取过即删 flow，第二次拿不到
//   3. **短 TTL**：与 CLI 的 300s 扫码超时对齐
// 残余风险：攻击者用自己的浏览器发起并轮询、只把二维码图片转给受害者，防不住。
// 所以页面上明确写「只在你自己打开的页面上扫码」。企业内部场景可接受，
// 对外开放前应改为需要先通过企业 SSO 登录。

function cookieOf(event, name) {
  const raw = (event.cookies || []).join('; ')
    || (lower(event.headers || {}).cookie || '');
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw);
  return m ? m[1] : null;
}

async function selfAuthorize() {
  const userId = T.newUserId();
  let started;
  try {
    started = await callRuntime('wecom/auth.start', {}, userId);
  } catch (e) {
    return J(502, { error: 'auth_start_failed', error_description: String(e.message || e) });
  }
  if (!started.authorizeUrl) return J(502, { error: 'auth_start_failed' });

  const flowId = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  await ddb.send(new PutItemCommand({
    TableName: FLOWS_TABLE,
    Item: {
      flowId: { S: flowId },
      userId: { S: userId },
      redirectUri: { S: '' },
      clientState: { S: '' },
      codeChallenge: { S: '' },
      containerSession: { S: started.sessionId || '' },
      mode: { S: 'self' },
      bindNonce: { S: nonce },
      ttl: { N: String(Math.floor(Date.now() / 1000) + FLOW_TTL_S) },
    },
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // 浏览器绑定。Path 收窄到 self 分支，Secure 因为整条链路是 CloudFront HTTPS。
      'Set-Cookie': `wm_flow=${nonce}; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_TTL_S}; Path=/authorize/self`,
    },
    body: selfPage(flowId, started.authorizeUrl, started.qrPngBase64),
  };
}

async function selfStatus(event) {
  const flowId = (event.queryStringParameters || {}).flow;
  if (!flowId) return J(400, { error: 'invalid_request' });

  const got = await ddb.send(new GetItemCommand({
    TableName: FLOWS_TABLE, Key: { flowId: { S: flowId } }, ConsistentRead: true,
  }));
  if (!got.Item) return J(200, { status: 'expired', reason: 'flow_not_found' });
  if ((got.Item.mode?.S || '') !== 'self') return J(400, { error: 'wrong_flow_mode' });

  // 防线 1：必须是发起这个 flow 的同一个浏览器
  const cookie = cookieOf(event, 'wm_flow');
  if (!cookie || !T.safeEq(cookie, got.Item.bindNonce.S)) {
    return J(403, { error: 'flow_not_bound_to_this_browser' });
  }

  const userId = got.Item.userId.S;
  const st = await callRuntime('wecom/auth.status',
    { sessionId: got.Item.containerSession.S || undefined }, userId);

  // 同 authorizeStatus：容器状态可能来自没有该会话的另一个实例，以密钥落库为准
  let ok = st.status === 'authorized' || st.status === 'already_authorized';
  if (!ok && await credentialLanded(userId)) {
    ok = true;
    console.log(JSON.stringify({
      level: 'INFO', event: 'auth_confirmed_via_secret', userId,
      containerStatus: st.status, mode: 'self',
    }));
  }
  if (!ok) return J(200, { status: st.status, reason: st.reason });

  const slot = await resolveIdentitySlot(userId, st.wecomIdentity);

  // 防线 2：一次性 —— 取过即删
  await ddb.send(new DeleteItemCommand({
    TableName: FLOWS_TABLE, Key: { flowId: { S: flowId } },
  }));

  const accessToken = await T.signMcpToken(slot);
  return J(200, {
    status: 'authorized',
    token: accessToken,
    header_name: 'Authorization',
    header_value: `Bearer ${accessToken}`,
    expires_in_days: Math.floor(T.MCP_TOKEN_TTL_MS / 86400000),
  });
}

function selfPage(flowId, wecomUrl, qrBase64) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 二维码就地显示，**不再跳新标签**。
  // 早期版本只给一个 target="_blank" 的按钮，用户点进企业微信授权页后盯着那个新标签看，
  // 而变化发生在原标签 —— 扫码明明成功了却以为失败，且一次性 token 已被轮询取走。
  // 拿不到 PNG 时才退化为链接，并明确写「扫完请回到本页」。
  const qrBlock = qrBase64
    ? `<img id="qr" alt="企业微信授权二维码" width="240" height="240"
         src="data:image/png;base64,${qrBase64}">`
    : `<p><a class="btn" href="${esc(wecomUrl)}" target="_blank" rel="noopener">打开企业微信授权页</a></p>
       <p class="hint">二维码未能生成，改为跳转。<strong>扫码完成后请回到本页</strong>查看令牌。</p>`;

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>获取企业微信 MCP 访问令牌</title>
<style>
body{font:16px/1.7 system-ui,-apple-system,sans-serif;max-width:40rem;margin:5vh auto;padding:0 1.5rem;color:#1a1a1a}
h2{margin-bottom:.3rem}
#qr{border:1px solid #e8e8e8;border-radius:8px;padding:10px;background:#fff;display:block}
a.btn{display:inline-block;background:#07c160;color:#fff;padding:.7rem 1.4rem;border-radius:6px;text-decoration:none;font-weight:600}
.warn{background:#fff7e6;border-left:4px solid #fa8c16;padding:.8rem 1rem;margin:1.2rem 0;font-size:.94rem}
.hint{color:#666;font-size:.92rem}
#s{margin-top:1.2rem;color:#666}
#out{display:none;margin-top:1.5rem}
textarea{width:100%;height:6.5rem;font:13px/1.5 ui-monospace,Menlo,monospace;padding:.7rem;border:1px solid #d9d9d9;border-radius:6px;box-sizing:border-box}
ol{padding-left:1.3rem}code{background:#f5f5f5;padding:.1rem .35rem;border-radius:3px;font-size:.9em}
</style>
<h2>获取企业微信 MCP 访问令牌</h2>
<p class="hint">用于 Quick Desktop 等只能填 Header、不支持 OAuth 流程的客户端。</p>

<div class="warn">
<strong>安全提醒</strong>：只扫<strong>你自己打开的这个页面</strong>上的二维码。
如果这个二维码是别人发给你的，扫了对方就能拿到以你身份操作企业微信的令牌 —— 不要扫。
</div>

<div id="scan">
  <p><strong>用企业微信扫下面的二维码</strong>，扫完本页会自动显示令牌，无需离开。</p>
  ${qrBlock}
  <p id="s">等待扫码…（5 分钟内有效）</p>
</div>

<div id="out">
  <h3>✅ 授权完成</h3>
  <p>在客户端（Quick Desktop → Settings → Capabilities → Connectors → MCP server → <b>Remote</b>）里填：</p>
  <ol>
    <li><b>URL</b>：<code id="u"></code></li>
    <li><b>Header</b> 名 <code>Authorization</code>，值为下面这一整行：</li>
  </ol>
  <textarea id="t" readonly onclick="this.select()"></textarea>
  <p class="hint">有效期 <span id="d"></span> 天。此令牌等同于你的企业微信读取权限，不要转发。
  <strong>本页关闭后无法再次取回</strong> —— 没复制到就找管理员补发，不要重新扫码
  （重扫要重走一遍授权，一旦在机器人选择页上选了「新建」就会失去对旧文档的编辑权限）。</p>
</div>

<script>
const f=${JSON.stringify(flowId)};
let n=0;
async function tick(){
  n++;
  try{
    const r=await fetch('self/status?flow='+encodeURIComponent(f),{cache:'no-store',credentials:'same-origin'});
    const d=await r.json();
    if(d.status==='authorized'&&d.token){
      document.getElementById('scan').style.display='none';
      document.getElementById('u').textContent=location.origin+'/mcp';
      document.getElementById('t').value=d.header_value;
      document.getElementById('d').textContent=d.expires_in_days;
      document.getElementById('out').style.display='block';
      return;
    }
    if(d.status==='expired'||d.status==='failed'||d.error){
      document.getElementById('s').textContent='未完成：'+(d.reason||d.error||d.status)+'，请重新打开本页。';
      return;
    }
  }catch(e){}
  if(n>110){document.getElementById('s').textContent='超时，请重新打开本页。';return}
  setTimeout(tick,3000);
}
tick();
</script></html>`;
}

// ---------- /token ----------

/**
 * OAuth 路径的 access token 有效期，默认 30 天。
 *
 * 与自助路径（同样 30 天）取值相同，但两者刻意分开变量：自助路径**没有** refresh
 * 机制，必须长；OAuth 路径能续期，长短是可调的运维选择。别合成一个。
 *
 * 为什么最终选 30 天而不是 1 小时 ——
 * 2026-08-27 实测确认 Quick 会消费 refresh token，但它是**反应式续期**：
 * 到期后不主动刷，等下一次调用撞到 401 才去换。实测延迟 4.2 分钟
 * （token 20:53 到期 → 20:57:14 才 refresh_grant_used），这段时间内的调用会失败。
 * 该窗口每个 access token 周期出现一次，所以周期越短、用户可见的失败越频繁：
 * 1 小时 = 每小时一次，30 天 = 每 30 天一次。
 *
 * 安全侧的代价是泄露窗口变长。这里接受它：本服务是内部自用 PoC，
 * 且 token 只授予「以授权人身份访问其企业微信」这一种能力。
 * 要收紧就调小这个值，同时接受更频繁的失败窗口。
 *
 * refresh token 仍是 90 天滑动窗口（REFRESH_TOKEN_TTL_DAYS），每次续期轮换后重置，
 * 所以只要客户端在 90 天内用过一次，链路就能一直续下去、不必重新扫码。
 */
const ACCESS_TTL_MS = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 43200) * 60 * 1000;

/**
 * 轮换并签发一对新令牌。authorization_code 与 refresh_token 两条路最后都走这里。
 * 先写库再签发：万一写库失败，宁可让客户端重试，也不要发出一个库里没有的 jti。
 */
async function issueTokenPair(userId) {
  const jti = T.newJti();
  await ddb.send(new PutItemCommand({
    TableName: REFRESH_TABLE,
    Item: {
      userId: { S: userId },
      jti: { S: jti },
      ttl: { N: String(Math.floor((Date.now() + T.REFRESH_TTL_MS) / 1000)) },
    },
  }));
  return {
    access_token: await T.signMcpToken(userId, ACCESS_TTL_MS),
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: await T.signRefreshToken(userId, jti),
    scope: SCOPE,
  };
}

/**
 * refresh_token 授权类型。
 *
 * 这是「每次扫码都新建一个企业微信机器人」的主要缓解手段：access token 到期后
 * 客户端用 refresh token 续期，**不必重走授权流程**，因而不会新建机器人。
 * 轮换是滑动窗口 —— 只要客户端在 refresh TTL 内用过一次，就能一直续下去。
 */
async function refreshGrant(form) {
  const presented = await T.verifyRefreshToken(form.get('refresh_token'));
  if (!presented) return J(400, { error: 'invalid_grant' });

  const got = await ddb.send(new GetItemCommand({
    TableName: REFRESH_TABLE, Key: { userId: { S: presented.userId } }, ConsistentRead: true,
  }));
  if (!got.Item) return J(400, { error: 'invalid_grant', error_description: 'revoked' });

  if (!T.safeEq(got.Item.jti.S, presented.jti)) {
    // 签名合法但 jti 不是当前那个 = 用了已轮换掉的旧令牌 = 重放/泄露。
    // 按 OAuth 2.1 建议吊销整个家族，而不是只拒这一次。
    await ddb.send(new DeleteItemCommand({
      TableName: REFRESH_TABLE, Key: { userId: { S: presented.userId } },
    }));
    console.error(JSON.stringify({
      level: 'CRITICAL', event: 'refresh_token_reuse_detected',
      userId: presented.userId, note: '已吊销该用户全部 refresh token，需重新授权',
    }));
    return J(400, { error: 'invalid_grant', error_description: 'token_reuse_detected' });
  }

  // 凭证还在吗？用户凭证被清理过就不该继续续期
  if (!await credentialLanded(presented.userId)) {
    return J(400, { error: 'invalid_grant', error_description: 'credential_gone' });
  }

  // 这条日志是「客户端到底用不用 refresh token」的唯一证据，别删。
  console.log(JSON.stringify({
    level: 'INFO', event: 'refresh_grant_used', userId: presented.userId,
  }));
  return J(200, await issueTokenPair(presented.userId));
}

async function token(event) {
  const form = new URLSearchParams(event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || ''));

  const grant = form.get('grant_type');
  if (grant === 'refresh_token') return refreshGrant(form);
  if (grant !== 'authorization_code') {
    return J(400, { error: 'unsupported_grant_type' });
  }

  const clientId = form.get('client_id');
  const clientSecret = form.get('client_secret');
  const verifier = form.get('code_verifier');

  // 三分支客户端认证（照搬参考实现 index.ts:864-895 的分叉）
  const dcrClient = clientId ? await T.verifyClientId(clientId) : null;
  if (dcrClient) {
    // DCR 公开客户端：禁止带 client_secret，强制 PKCE
    if (clientSecret) return J(401, { error: 'invalid_client' });
    if (!verifier) return J(400, { error: 'invalid_request', error_description: 'code_verifier required' });
  } else if (clientSecret) {
    // 共享密钥机密客户端（Quick 走这条）：常量时间比对
    if (!SHARED_CLIENT_SECRET || !T.safeEq(clientSecret, SHARED_CLIENT_SECRET)) {
      return J(401, { error: 'invalid_client' });
    }
  } else {
    return J(401, { error: 'invalid_client' });
  }

  const code = form.get('code');
  if (!code) return J(400, { error: 'invalid_request' });

  // 单次消费：DeleteItem + ReturnValues=ALL_OLD 原子领取，竞态下只有一方拿到 Attributes
  const claimed = await ddb.send(new DeleteItemCommand({
    TableName: CODES_TABLE, Key: { code: { S: code } }, ReturnValues: 'ALL_OLD',
  }));
  if (!claimed.Attributes) return J(400, { error: 'invalid_grant' });

  const rec = claimed.Attributes;
  if (Number(rec.ttl.N) * 1000 < Date.now()) return J(400, { error: 'invalid_grant', error_description: 'expired' });

  const redirectUri = form.get('redirect_uri');
  if (redirectUri && redirectUri !== rec.redirectUri.S) return J(400, { error: 'invalid_grant' });

  if (verifier) {
    const calc = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!T.safeEq(calc, rec.codeChallenge.S)) return J(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
  }

  return J(200, await issueTokenPair(rec.userId.S));
}
