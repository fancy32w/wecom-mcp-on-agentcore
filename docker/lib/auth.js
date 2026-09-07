'use strict';
/**
 * 扫码授权会话。
 *
 * 为什么这块在容器里而不在 Lambda：`auth init` 是**阻塞式扫码轮询**，CLI 进程必须在
 * 用户扫码期间持续存活。实测 CLI 内部轮询超时硬编码 300 秒
 * （日志 {"message":"polling qr scan status","timeout_secs":300}），
 * 而 API Gateway 上限 29s / Lambda 120s —— 撑不住。AgentCore Runtime 是长活容器，
 * 且有 idleRuntimeSessionTimeout 可配，是唯一合适的落点。
 *
 * 实测要点（docs/改造评估.md §5.2 §12 §15）：
 *   - 授权链接直接打在 stdout：https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=…
 *     不需要 --output-qrcode 回传图片（该 flag 只吃当前目录相对路径）
 *   - 凭证只在授权成功后写入 CONFIG_DIR，且**授权时用户要选新建机器人还是绑定已有的**
 *     （早期平台只能新建，实测同一人三次授权三个 bot_id；现在可以绑定原有机器人）。
 *     叠加「写只认机器人所有权」→ 用户若选新建，就丢失对旧产物的写权限。
 *     选择权在用户手上、我们无法从代码里强制，所以凭证仍必须可靠保存，
 *     不能靠「丢了让用户重扫」。
 *   - 扫码超时错误码 893202（QrTimeout），CLI 自己会先超时退出
 *
 * 本文件修掉的 5 个早期缺陷（见 §15 末）：
 *   1. startAuth 幂等：同一用户已有 pending 会话时返回现有会话，不再重复起进程发新码
 *   2. 支持按 userId 查询：sessionId 丢了不再让凭证搁死
 *   3. 收单改为**推送式**：CLI 成功退出即刻落库，不再依赖有人来轮询
 *   4. 用 893202 判过期，而非墙上时钟
 *   5. 失败原因用 extractCliError 解析，不再拼 stdout 末三行拼出 JSON 残片
 */

const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { CLI, extractCliError, ANSI_RE, invokeMethod } = require('./cli');

const POLL_TIMEOUT_MS = 300 * 1000;       // 与 CLI 内部 timeout_secs=300 对齐，不要放大
const GRACE_MS = 20 * 1000;               // 墙上时钟兜底（正常路径由 893202 判定）
const TERMINAL_RETAIN_MS = 120 * 1000;    // 终态保留时长，让迟到的轮询也能拿到真实结果
const URL_WAIT_MS = 20 * 1000;
const QR_TIMEOUT_CODE = 893202;           // 实测：QrTimeout 扫码超时（5 分钟）
const QR_FILE = 'qr.png';                 // --output-qrcode 只吃当前目录相对路径

// 身份探针的关键词：刻意选一个查不到人的串。
// 身份挂在响应信封（extra_identity_context）上，与命中数无关 —— 零结果时身份照样
// 带回来，而负载只有几十字节（实测 56 字节）。别改成会命中的词，那会白拉一大坨通讯录。
const IDENTITY_PROBE_KEYWORD = '__wecom_mcp_identity_probe__';

const URL_RE = /https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?\S+/;

/** sessionId → session */
const sessions = new Map();
/** userId → sessionId（只索引未进入终态的会话） */
const byUser = new Map();

/**
 * 凭证落库回调，由 server.js 注入。
 * 推送式收单的关键：CLI 成功退出的那一刻就落库，而不是等 /auth/status 被调用。
 * 早期设计是纯拉取式，导致「用户扫完码、体验上授权成功，但凭证从未入库」。
 */
let onAuthorized = async () => {
  throw new Error('auth.configure({ onAuthorized }) 未调用');
};

function configure(opts) {
  if (typeof opts.onAuthorized === 'function') onAuthorized = opts.onAuthorized;
}

function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function isPending(s) {
  return s && (s.state === 'starting' || s.state === 'pending');
}

function publicView(s, sessionId) {
  if (isPending(s)) {
    return {
      status: 'pending',
      sessionId,
      authorizeUrl: s.url,
      qrPngBase64: s.qrPng || null,      // 页面内嵌用，缺失时调用方退化为只显示链接
      expiresAt: s.startedAt + POLL_TIMEOUT_MS,
    };
  }
  if (s.state === 'authorized') {
    return {
      status: 'authorized',
      sessionId,
      userId: s.userId,
      // 真人身份：Lambda 侧据此做「同一人只占一个凭证槽位」的去重
      wecomIdentity: s.identity || null,
    };
  }
  if (s.state === 'expired') return { status: 'expired', sessionId, reason: s.reason };
  return { status: 'failed', sessionId, reason: s.reason };
}

/**
 * 读取「扫码这个真人」的稳定企业微信身份。
 *
 * 为什么必须走一次业务调用：
 *   - `auth show` 只给 `Bot ID`，而 bot_id **不保证稳定**：用户在授权时可以选新建机器人，
 *     选了就换一个值。不能当人的稳定键
 *   - 真人身份只出现在业务响应的 extra_identity_context 里（cli.js 会解析成结构化 identity）
 *
 * 用一个**查不到结果**的关键词做探针：身份挂在响应信封上，与命中数无关，
 * 所以零结果时身份照样带回来而负载只有几十字节（实测 56 字节）。
 *
 * 必须在 s.dir 被清理**之前**调用 —— 凭证还在那个目录里。
 * 失败不阻断授权：拿不到身份只是少了去重能力，凭证本身已经存好了。
 */
async function readIdentity(dir) {
  try {
    const r = await invokeMethod('contact.users.search',
      { keyword: IDENTITY_PROBE_KEYWORD }, { configDir: dir });
    const id = r && r.identity;
    if (id && id.authorized_user_id) {
      return {
        userId: id.authorized_user_id,
        userName: id.authorized_user_name || null,
        botId: id.bot_id || null,
      };
    }
    log('WARN', 'identity_probe_empty', { ok: r && r.ok });
  } catch (e) {
    log('WARN', 'identity_probe_failed', { error: String(e && e.message || e) });
  }
  return null;
}

/**
 * 发起授权。同一用户已有 pending 会话时**返回现有会话**，不再重复起进程。
 */
async function startAuth(userId) {
  const existingId = byUser.get(userId);
  const existing = existingId && sessions.get(existingId);
  if (isPending(existing) && Date.now() - existing.startedAt < POLL_TIMEOUT_MS) {
    return { ...publicView(existing, existingId), reused: true };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wcauth-'));
  await fs.chmod(dir, 0o700);
  const logDir = path.join(dir, 'logs');
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });

  const child = spawn(CLI, [
    'auth', 'init', '--noninteractive', '--no-browser',
    // 导出 PNG 供页面内嵌。**这个 flag 只接受当前目录的相对路径**，所以 cwd 必须是 dir。
    // 为什么要内嵌：早期版本只给一个跳转链接（target="_blank"），用户点进企业微信的
    // 授权页后就盯着**那个新标签**看，而会变的是原标签 —— 结果是扫码成功了却以为失败，
    // 且轮询已把一次性的 token 取走。任何人都会这么用，是设计错误而非用户操作错误。
    '--output-qrcode', QR_FILE,
  ], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'C.UTF-8',
      WECOM_CLI_CONFIG_DIR: dir,
      WECOM_CLI_LOG_DIR: logDir,
      WECOM_CLI_LOG_LEVEL: 'debug',
    },
  });

  const sessionId = newSessionId();
  const s = {
    userId, child, dir, url: null,
    startedAt: Date.now(), state: 'starting',
    out: '', exitCode: null, reason: null, terminalAt: null,
  };
  sessions.set(sessionId, s);
  byUser.set(userId, sessionId);

  child.stdout.on('data', (b) => { s.out += b.toString(); });
  child.stderr.on('data', (b) => { s.out += b.toString(); });

  // 关键：settled 在 exit 时立即执行落库，getStatus 只是读结果
  s.settled = new Promise((resolve) => {
    child.on('exit', async (code) => {
      s.exitCode = code;
      try {
        if (code === 0) {
          const blob = await readBlob(s.dir);
          if (!blob) {
            s.state = 'failed';
            s.reason = 'credentials_missing_after_success';
          } else {
            // 身份要在清目录前读；拿不到不阻断落库
            const who = await readIdentity(s.dir);
            s.identity = who;
            await onAuthorized(s.userId, blob, who);      // ← 推送式落库
            s.state = 'authorized';
            log('INFO', 'auth_completed', {
              userId: s.userId, sessionId,
              wecomUserId: who && who.userId, botId: who && who.botId,
            });
          }
        } else {
          const e = extractCliError(s.out);
          s.reason = e ? `${e.type}(${e.code}): ${e.message}` : tail(s.out);
          s.state = (e && e.code === QR_TIMEOUT_CODE) ? 'expired' : 'failed';
          log('INFO', 'auth_' + s.state, { userId: s.userId, sessionId, code: e && e.code });
        }
      } catch (err) {
        s.state = 'failed';
        s.reason = 'writeback_failed: ' + String(err && err.message || err);
        // 落库失败必须显式告警：凭证已经产生但没存住，用户会以为授权成功了
        log('CRITICAL', 'auth_writeback_failed', { userId: s.userId, sessionId, error: s.reason });
      } finally {
        s.terminalAt = Date.now();
        if (byUser.get(s.userId) === sessionId) byUser.delete(s.userId);
        s.out = '';                                  // 不留日志残留
        await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
        resolve();
      }
    });
  });

  const url = await waitForUrl(s);
  if (!url) {
    await abort(sessionId);
    throw new Error('auth_start_failed: 未能在 20s 内取到授权链接');
  }
  s.url = url;
  s.qrPng = await readQrPng(dir);        // 拿不到就退化为只给链接，不阻断流程
  if (s.state === 'starting') s.state = 'pending';
  return publicView(s, sessionId);
}

/** 读二维码 PNG 转 base64。CLI 写文件与打印链接的时序不保证，短轮询几次。 */
async function readQrPng(dir) {
  const p = path.join(dir, QR_FILE);
  for (let i = 0; i < 12; i += 1) {
    try {
      const b = await fs.readFile(p);
      if (b.length > 100) return b.toString('base64');
    } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  log('WARN', 'qr_png_unavailable', { dir });
  return null;
}

function waitForUrl(s) {
  return new Promise((resolve) => {
    const deadline = Date.now() + URL_WAIT_MS;
    const tick = () => {
      const m = URL_RE.exec(s.out.replace(ANSI_RE, ''));
      if (m) return resolve(m[0]);
      if (s.exitCode !== null || Date.now() > deadline) return resolve(null);
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** 查询状态。凭证已在 exit 时落库，这里只报状态，不再回传 blob。 */
async function getStatus(sessionId) {
  gc();
  const s = sessions.get(sessionId);
  if (!s) return { status: 'unknown' };
  // 墙上时钟兜底：CLI 该退出却没退（卡住），主动收掉
  if (isPending(s) && Date.now() - s.startedAt > POLL_TIMEOUT_MS + GRACE_MS) {
    await abort(sessionId);
    return { status: 'expired', reason: 'wall_clock_timeout' };
  }
  return publicView(s, sessionId);
}

/** 按 userId 查询 —— sessionId 丢了也不至于让凭证搁死。 */
async function getStatusByUser(userId) {
  const sid = byUser.get(userId);
  if (sid) return getStatus(sid);
  // 终态会话已从 byUser 摘掉，倒查一遍保留期内的
  gc();
  for (const [id, s] of sessions) {
    if (s.userId === userId) return publicView(s, id);
  }
  return { status: 'unknown' };
}

async function readBlob(dir) {
  try {
    const [cred, key] = await Promise.all([
      fs.readFile(path.join(dir, 'credentials.enc')),
      fs.readFile(path.join(dir, '.encryption_key')),
    ]);
    return {
      credentials_enc: cred.toString('base64'),
      encryption_key: key.toString('base64'),
    };
  } catch {
    return null;
  }
}

function tail(text) {
  return (text || '').replace(ANSI_RE, '').trim().split('\n').slice(-2).join(' | ').slice(0, 300);
}

function log(level, event, fields) {
  console[level === 'INFO' ? 'log' : 'error'](JSON.stringify({ level, event, ...fields }));
}

/** 回收保留期已过的终态会话 */
function gc() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.terminalAt && now - s.terminalAt > TERMINAL_RETAIN_MS) sessions.delete(id);
  }
}

async function abort(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.exitCode === null) {
    try { s.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    await s.settled.catch(() => {});     // 等 exit 处理跑完（含清理）
  }
  if (byUser.get(s.userId) === sessionId) byUser.delete(s.userId);
}

/** 容器优雅关闭：杀掉在飞的授权进程并清 tmpfs */
async function shutdown() {
  await Promise.all([...sessions.keys()].map(abort));
  sessions.clear();
  byUser.clear();
}

module.exports = {
  configure, startAuth, getStatus, getStatusByUser, abort, shutdown,
  POLL_TIMEOUT_MS, QR_TIMEOUT_CODE, sessions, byUser,
};
