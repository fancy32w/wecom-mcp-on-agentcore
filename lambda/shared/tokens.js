'use strict';
/**
 * 令牌签名工具 —— 两个 Lambda 共用。
 *
 * 照搬参考实现的做法（lambda/token-refresh-shim/index.ts:52-60）：SSM 里放**一个**根密钥，
 * 派生出多把域分离子密钥。好处是轮换一处生效全域，且各用途的签名互不可伪造。
 *
 * 五把子密钥：
 *   stateKey   oauth-state-v1       /authorize 的 state 签名
 *   tokenKey   mcp-token-v1         发给客户端的 MCP access token
 *   refreshKey mcp-refresh-v1       refresh token
 *   dcrKey     mcp-dcr-client-v1    DCR 自注册签发的 client_id
 *   sessKey    wecom-authsess-v1    扫码会话与我们自造的 userId 的绑定
 *
 * MCP token 是**无状态自验证**的：base64url(userId:expiresAt:hmac)，不落库。
 * 参考实现给 30 天，客户端无感于底层 SaaS 凭证的刷新。
 *
 * refresh token 与 access token 不同：它**必须落库**，因为要能轮换和检测重放。
 * 见下方 signRefreshToken 的说明。
 */

const crypto = require('crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const REGION = process.env.AWS_REGION || 'us-east-1';
const STATE_SECRET_PARAM = process.env.STATE_SECRET_PARAM;
const MCP_TOKEN_TTL_MS = Number(process.env.MCP_TOKEN_TTL_DAYS || 30) * 86400 * 1000;

const ssm = new SSMClient({ region: REGION });

let keys = null;
let keysAt = 0;
const KEY_CACHE_MS = 5 * 60 * 1000;

function derive(root, label) {
  return crypto.createHmac('sha256', root).update(label).digest();
}

async function loadKeys() {
  if (keys && Date.now() - keysAt < KEY_CACHE_MS) return keys;
  if (!STATE_SECRET_PARAM) throw new Error('STATE_SECRET_PARAM 未配置');
  const r = await ssm.send(new GetParameterCommand({
    Name: STATE_SECRET_PARAM, WithDecryption: true,
  }));
  const root = Buffer.from(r.Parameter.Value, 'utf8');
  keys = {
    stateKey: derive(root, 'oauth-state-v1'),
    tokenKey: derive(root, 'mcp-token-v1'),
    refreshKey: derive(root, 'mcp-refresh-v1'),
    dcrKey: derive(root, 'mcp-dcr-client-v1'),
    sessKey: derive(root, 'wecom-authsess-v1'),
  };
  keysAt = Date.now();
  return keys;
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

function mac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest('base64url').slice(0, 43);
}

/** 常量时间比较，长度不等直接 false（timingSafeEqual 对不等长会抛） */
function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- MCP token ----------

async function signMcpToken(userId, ttlMs = MCP_TOKEN_TTL_MS) {
  const { tokenKey } = await loadKeys();
  const exp = Date.now() + ttlMs;
  const payload = `${userId}:${exp}`;
  return b64u(`${payload}:${mac(tokenKey, payload)}`);
}

async function verifyMcpToken(token) {
  if (!token) return null;
  const { tokenKey } = await loadKeys();
  let raw;
  try { raw = unb64u(token).toString('utf8'); } catch { return null; }
  const i = raw.lastIndexOf(':');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  if (!safeEq(raw.slice(i + 1), mac(tokenKey, payload))) return null;
  const j = payload.lastIndexOf(':');
  const userId = payload.slice(0, j);
  const exp = Number(payload.slice(j + 1));
  if (!userId || !Number.isFinite(exp) || Date.now() > exp) return null;
  return { userId, expiresAt: exp };
}

// ---------- /authorize 的 state ----------

async function signState(obj, ttlMs = 300 * 1000) {
  const { stateKey } = await loadKeys();
  const body = b64u(JSON.stringify({ ...obj, e: Date.now() + ttlMs }));
  return `${body}.${mac(stateKey, body)}`;
}

async function verifyState(state) {
  if (!state) return null;
  const { stateKey } = await loadKeys();
  const [body, sig] = String(state).split('.');
  if (!body || !sig || !safeEq(sig, mac(stateKey, body))) return null;
  try {
    const obj = JSON.parse(unb64u(body).toString('utf8'));
    return Date.now() > obj.e ? null : obj;
  } catch { return null; }
}

// ---------- DCR client_id ----------

/**
 * client_id 是 HMAC 自验证的不透明串，**不落库**（参考实现同样做法）。
 * 所以 /register 可以免鉴权开放：伪造不出合法 client_id。
 */
async function signClientId(payload) {
  const { dcrKey } = await loadKeys();
  const body = b64u(JSON.stringify({ ...payload, iat: Date.now() }));
  return `${body}.${mac(dcrKey, body)}`;
}

async function verifyClientId(clientId) {
  if (!clientId) return null;
  const { dcrKey } = await loadKeys();
  const [body, sig] = String(clientId).split('.');
  if (!body || !sig || !safeEq(sig, mac(dcrKey, body))) return null;
  try {
    const obj = JSON.parse(unb64u(body).toString('utf8'));
    // iat 合理性：不接受未来签发或超过一年的
    if (!Number.isFinite(obj.iat) || obj.iat > Date.now() + 60000
        || Date.now() - obj.iat > 365 * 86400 * 1000) return null;
    return obj;
  } catch { return null; }
}

// ---------- refresh token ----------

/**
 * refresh token = base64url(userId:jti:expiresAt:hmac)。
 *
 * 与 access token 的关键差别：**jti 必须落库**。
 * DCR 客户端是公开客户端（token_endpoint_auth_method = none），没有 client_secret，
 * 所以 refresh token 一旦泄露就是一张长期通行证。OAuth 2.1 对这种情况要求轮换：
 * 每次刷新签发新的 jti 并覆盖库里的旧值，于是
 *   - 旧 refresh token 立刻失效（jti 不匹配）
 *   - 拿旧的来换 = 重放，说明泄露，此时**吊销整个家族**而不是只拒这一次
 *
 * 每用户只保留一条（表以 userId 为主键），所以「轮换」就是一次 PutItem 覆盖。
 * 代价：同一用户多客户端并发刷新会互相踢掉。对内部自用够了；
 * 若将来要支持多客户端并存，需改为按 (userId, clientId) 或按家族 id 存多条。
 */
const REFRESH_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 90) * 86400 * 1000;

function newJti() {
  return crypto.randomBytes(16).toString('hex');
}

async function signRefreshToken(userId, jti, ttlMs = REFRESH_TTL_MS) {
  const { refreshKey } = await loadKeys();
  const exp = Date.now() + ttlMs;
  const payload = `${userId}:${jti}:${exp}`;
  return b64u(`${payload}:${mac(refreshKey, payload)}`);
}

async function verifyRefreshToken(token) {
  if (!token) return null;
  const { refreshKey } = await loadKeys();
  let raw;
  try { raw = unb64u(token).toString('utf8'); } catch { return null; }
  const i = raw.lastIndexOf(':');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  if (!safeEq(raw.slice(i + 1), mac(refreshKey, payload))) return null;
  // payload = userId:jti:exp —— userId 自身含冒号（u_<hex>），故从右往左切
  const parts = payload.split(':');
  if (parts.length < 3) return null;
  const exp = Number(parts.pop());
  const jti = parts.pop();
  const userId = parts.join(':');
  if (!userId || !jti || !Number.isFinite(exp) || Date.now() > exp) return null;
  return { userId, jti, expiresAt: exp };
}

// ---------- 我们自造的 userId ----------

/**
 * userId 是**我们自己的**不透明标识，与企业微信身份解耦。
 *
 * 飞书版能用 open_id 当 userId，因为 302 回调会带回身份；企业微信是扫码，
 * 我们必须在发起扫码**之前**就有一个键来存凭证 —— 所以这里随机生成。
 * 企业微信侧的真实身份由凭证自然携带（每次工具调用返回的 extra_identity_context 里有），
 * 因此参考实现的 OpenIdMap 表在这里不需要。
 *
 * 代价：同一个人重复授权会拿到不同 userId，旧凭证成为孤儿。
 * 叠加「授权时可能新建机器人」（§14），这与平台行为一致，不额外制造问题，
 * 但运维上需要一个清理孤儿 secret 的动作。
 */
function newUserId() {
  return 'u_' + crypto.randomBytes(16).toString('hex');
}

module.exports = {
  loadKeys, signMcpToken, verifyMcpToken, signState, verifyState,
  signClientId, verifyClientId, newUserId, safeEq, b64u, unb64u,
  signRefreshToken, verifyRefreshToken, newJti,
  MCP_TOKEN_TTL_MS, REFRESH_TTL_MS,
};
