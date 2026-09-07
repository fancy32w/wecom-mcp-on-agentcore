'use strict';
/**
 * 企业微信 MCP 服务容器主入口。
 *
 * 协议层照搬参考实现（aws-samples/sample-lark-mcp-on-agentcore docker/server.js）的形态：
 * 手写 http + JSON-RPC 2.0、POST 请求回单帧 SSE、完全无状态零 session、GET /ping 健康检查。
 * 身份 100% 来自每请求 header，绝不写进程级共享状态。
 *
 * 与参考实现的三处结构性差异：
 *   1. header 传的是 userId 而非令牌 —— 凭证由 Secrets Manager 取、物化成 CONFIG_DIR（lib/credentials.js）
 *   2. 多了 /auth/* 两个端点 —— 扫码需长活进程，Lambda 撑不住（lib/auth.js）
 *   3. 工具返回值要剥离 extra_identity_context（lib/cli.js）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { withCredentials } = require('./lib/credentials');
const { invokeMethod } = require('./lib/cli');
const authFlow = require('./lib/auth');
const secrets = require('./lib/secrets');          // { loadBlob, saveBlob }

// 推送式收单：CLI 授权成功的那一刻就落库，不依赖有人来轮询 /auth/status。
// 早期是纯拉取式，导致「用户扫完码、体验上授权成功，但凭证从未入库」。
authFlow.configure({
  onAuthorized: async (userId, blob, who) => {
    // who = { userId: 'wo_…', userName, botId }，即扫码那个真人的稳定企业微信身份。
    // 与凭证一起存：Lambda 侧据此把同一个人的多次授权收敛到一个槽位，
    // 也让凭证列表从「授权次数记录」变成真实用户名册。
    // 拿不到（探针失败）时照样落库 —— 少了去重能力，但凭证不能丢。
    await secrets.saveBlob(userId, blob, who || null);
  },
});

// ⚠️ AgentCore Runtime 探的是 **8000**，不是 8080。
// 用错端口的表现极具误导性：容器日志里只有一行 "listening"，然后 AgentCore 因为
// 健康检查不通而反复拉起新实例（实测几十个），请求一次都进不到 handler，
// 调用方只能看到 Lambda 30s 超时。参考实现的 Dockerfile 里 EXPOSE 8000 并在
// 注释里点明了这一点。留成 env 可覆盖，本地测试可以用别的端口。
const PORT = Number(process.env.PORT || 8000);
const MAX_BODY = 1024 * 1024;                       // 与参考实现一致
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);
const MAX_QUEUE = Number(process.env.MAX_QUEUE_DEPTH || 20);
const SCHEMA_DIR = process.env.WECOM_SCHEMA_DIR || '/app/schemas';

// ---------- 工具目录（构建期由 tools/extract-schemas.py + tools/to_mcp_schema.py 生成） ----------

const allTools = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'mcp-tools.json'), 'utf8'));
const tier1Names = fs.readFileSync(path.join(SCHEMA_DIR, 'tier1.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const toolByName = new Map();                       // wecom_xxx → { method, def }
for (const [method, def] of Object.entries(allTools)) toolByName.set(def.name, { method, def });

// Tier1 常驻：34 个约 34KB ≈ 8K tokens（实测，见 docs/改造评估.md §11）
const tier1Defs = tier1Names.map((m) => allTools[m]).filter(Boolean);

const META_TOOLS = [
  {
    name: 'wecom_discover',
    description: '按关键词搜索其余企业微信方法，返回方法名与完整参数 schema。94 个方法中 Tier1 已直接注册，其余走本工具发现。',
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '关键词或服务名，如 智能表格 / smartsheet' } },
      required: ['keyword'], additionalProperties: false,
    },
  },
  {
    name: 'wecom_invoke',
    description: '执行 wecom_discover 找到的方法。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: '点分方法名，如 smartsheet.records.list' },
        args: { type: 'object', description: '请求体' },
      },
      required: ['method'], additionalProperties: false,
    },
  },
  // TODO: wecom_list_skills / wecom_get_skill —— Skill 引擎可整段复用参考实现的
  //       skill-sections.js + skill-description.js；素材来自 wecom-unified 的 94 个 reference。
  //       注意 chat / message 两域官方 skill 无覆盖，需自写（§13-E）。
];

// ---------- 并发信号量 ----------

let inFlight = 0;
const queue = [];

function withSemaphore(signal, fn) {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;
    return fn().finally(release);
  }
  if (queue.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error('server_busy'), { code: 'server_busy' }));
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, fn };
    queue.push(entry);
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(entry);
      if (i >= 0) { queue.splice(i, 1); reject(Object.assign(new Error('client_aborted'), { code: 'client_aborted' })); }
    }, { once: true });
  }).then((f) => f().finally(release));
}

function release() {
  inFlight -= 1;
  const next = queue.shift();
  if (next) { inFlight += 1; next.resolve(next.fn); }
}

// ---------- 身份解析 ----------

/**
 * 三条身份来源，按优先级：
 *
 *  1. Authorization: Bearer <token> → userId   （标准形式）
 *  2. Token: <token> → userId
 *     Quick Desktop 的 Remote MCP 配置里有完整的 Headers 区域（可 + Add header），
 *     默认引导用户填的 header 名就是 `Token`。实测（2026-08-27 截图）：它能发任意自定义
 *     header，并非只能发 Bearer —— 所以 Desktop 上 per-user 身份是可行的，
 *     不必退化成全员共享一个 token。
 *  3. X-Runtime-User-Id header
 *     AgentCore 路径：middleware Lambda 验完 MCP token 后注入。注意 AgentCore 侧必须把该 header
 *     放进 requestHeaderAllowlist，否则会被静默丢弃。
 *
 * ⚠️ 生产形态下 MCP token 的验签在 middleware Lambda 完成，容器只信它注入的 header。
 * token 这两条路是给「客户端直连容器」的 PoC 用的 —— 它把鉴权责任放在了容器里，
 * token 一泄漏就等于把该用户的企业微信读权限交出去，因此只能配合 loopback 绑定使用。
 */
let BEARER_MAP = {};
try {
  BEARER_MAP = JSON.parse(process.env.WECOM_BEARER_TOKENS || '{}');
} catch {
  console.error(JSON.stringify({ level: 'ERROR', event: 'bad_bearer_token_map' }));
}

function resolveUser(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const raw = m ? m[1] : (req.headers.token || '').trim();
  if (raw) {
    return BEARER_MAP[raw] || null;        // token 给了但无效 → 不要回落到 header
  }
  return req.headers['x-runtime-user-id'] || null;
}

// ---------- JSON-RPC 处理 ----------

async function handleToolCall(name, args, userId, signal) {
  if (name === 'wecom_discover') {
    const kw = String(args?.keyword || '').toLowerCase();
    const hits = Object.entries(allTools)
      .filter(([m, d]) => m.toLowerCase().includes(kw) || (d.description || '').toLowerCase().includes(kw))
      .slice(0, 20)
      .map(([m, d]) => ({ method: m, description: d.description, inputSchema: d.inputSchema }));
    // 注意：94 个方法里只有 74 个唯一 request schema，9 组是同一底层 API 的多个入口（§11）。
    // TODO: 按 schema 指纹去重展示，否则模型会看到 6 个参数完全相同的工具。
    return { content: [{ type: 'text', text: JSON.stringify({ matches: hits }, null, 2) }] };
  }

  let method; let callArgs;
  if (name === 'wecom_invoke') {
    method = String(args?.method || '');
    callArgs = args?.args ?? {};
    if (!allTools[method]) throw Object.assign(new Error(`未知方法 ${method}`), { code: 'unknown_method' });
  } else {
    const entry = toolByName.get(name);
    if (!entry) throw Object.assign(new Error(`未知工具 ${name}`), { code: 'unknown_tool' });
    method = entry.method;
    callArgs = args ?? {};
  }

  const result = await withCredentials(secrets, userId, (configDir) =>
    invokeMethod(method, callArgs, { configDir, signal }));

  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
    };
  }
  return {
    content: [{ type: 'text', text: result.text ?? JSON.stringify(result.data, null, 2) }],
    // identity 作为结构化元数据回传，不混进对话文本（§12 提示注入面）
    _meta: result.identity ? { wecom_identity: result.identity } : undefined,
  };
}

async function handleRpc(req, userId, signal) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wecom-mcp', version: '0.1.0' },
      };
    case 'tools/list':
      return { tools: [...tier1Defs, ...META_TOOLS] };
    case 'tools/call':
      return withSemaphore(signal, () =>
        handleToolCall(req.params?.name, req.params?.arguments, userId, signal));

    // 授权端点也以 JSON-RPC 暴露。
    //
    // 为什么必须这样：AgentCore Runtime 只有单一 /invocations 入口，
    // 容器侧按 URL 路径分发的 /auth/start、/auth/status 从 Lambda 走不通。
    // 所以同一套 handler 提供两个入口 —— HTTP 路径（本地直连 / PoC 用）
    // 与 JSON-RPC 方法（经 AgentCore 从 oauth Lambda 调用）。
    //
    // 这两个方法不进 tools/list：它们是控制面，不该让客户端模型自己调。
    case 'wecom/auth.start': {
      if (await secrets.loadBlob(userId)) return { status: 'already_authorized' };
      return authFlow.startAuth(userId);
    }
    case 'wecom/auth.status': {
      const sid = req.params?.sessionId;
      return sid ? authFlow.getStatus(sid) : authFlow.getStatusByUser(userId);
    }

    default:
      throw Object.assign(new Error(`Method not found: ${req.method}`), { rpcCode: -32601 });
  }
}

// ---------- HTTP ----------

function sse(res, payload) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return reject(new Error('body_too_large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // AgentCore 健康检查
  if (req.method === 'GET' && req.url.startsWith('/ping')) {
    return json(res, 200, { status: 'Healthy' });
  }

  // 身份：Bearer token（Quick Desktop 直连）或 X-Runtime-User-Id（AgentCore 经 middleware）
  const userId = resolveUser(req);

  if (req.method === 'POST' && req.url.startsWith('/auth/start')) {
    if (!userId) return json(res, 401, { error: 'unauthenticated' });
    // CLI 不会拒绝重复授权，而重复授权会让用户面对「新建还是绑定机器人」的选择，
    // 选错就丢写权限（§14）—— 已有凭证就别再发码，从源头避免这个选择

    if (await secrets.loadBlob(userId)) return json(res, 409, { error: 'already_authorized' });
    try {
      // startAuth 幂等：同一用户已有 pending 会话会原样返回（带 reused: true）
      return json(res, 200, await authFlow.startAuth(userId));
    } catch (e) {
      return json(res, 502, { error: 'auth_start_failed', message: String(e.message || e) });
    }
  }

  if (req.method === 'GET' && req.url.startsWith('/auth/status')) {
    if (!userId) return json(res, 401, { error: 'unauthenticated' });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const sid = q.get('session');
    // 凭证在 CLI 退出时已推送落库，这里只报状态；sessionId 丢了可按 userId 查
    const st = sid ? await authFlow.getStatus(sid) : await authFlow.getStatusByUser(userId);
    return json(res, 200, st);
  }

  if (req.method !== 'POST') return res.writeHead(405).end();

  // MCP 数据面要求身份。无身份直接 401 —— 客户端配错 token 时能立刻看到，
  // 而不是连上后每次 tools/call 才失败。
  if (!userId) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="wecom-mcp"',
    });
    return res.end(JSON.stringify({ error: 'unauthenticated' }));
  }

  let body;
  try { body = await readBody(req, res); } catch { return; }

  let rpc;
  try { rpc = JSON.parse(body); } catch {
    return sse(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  // 无 id 的通知（notifications/initialized 等）不回错误帧
  if (rpc.id === undefined || rpc.id === null) return res.writeHead(202).end();

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  try {
    const result = await handleRpc(rpc, userId, ac.signal);
    return sse(res, { jsonrpc: '2.0', id: rpc.id, result });
  } catch (e) {
    if (e.code === 'wecom_not_authorized') {
      // 与参考实现对齐：有 MCP token 但缺 SaaS 凭证 → 引导授权，不是 401
      return sse(res, {
        jsonrpc: '2.0', id: rpc.id,
        error: { code: -32001, message: 'wecom_not_authorized', data: { needs_authorization: true } },
      });
    }
    return sse(res, {
      jsonrpc: '2.0', id: rpc.id,
      error: { code: e.rpcCode || -32603, message: String(e.message || e) },
    });
  }
});

// ---------- 优雅关闭 ----------

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await authFlow.shutdown();               // 杀掉在飞的扫码进程并清 tmpfs
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 显式绑 0.0.0.0：容器里不能只听 loopback，否则 AgentCore 连不上
server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'INFO', event: 'listening', port: PORT,
    tier1: tier1Defs.length, total: Object.keys(allTools).length, meta: META_TOOLS.length,
  }));
});

module.exports = { server, handleRpc, handleToolCall };
