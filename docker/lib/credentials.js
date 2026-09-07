'use strict';
/**
 * 每用户凭证物化 / 回写。
 *
 * 这是与飞书版的本质差异点。飞书靠 LARKSUITE_CLI_USER_ACCESS_TOKEN 环境变量传令牌，
 * 隔离粒度就是单次 execFile 的进程边界，无任何落盘。企业微信没有等价的令牌环境变量，
 * 只有 WECOM_CLI_CONFIG_DIR —— 凭证是目录里的两个文件：
 *
 *   .encryption_key   44 字节   0600   （keyring 不可用时 CLI 自动降级为纯文件，已实测）
 *   credentials.enc  215 字节   0600
 *   cache/                             （CLI 自建，可丢弃）
 *
 * 所以隔离粒度从「进程 env」下移到「每用户 CONFIG_DIR」：
 *   Secrets Manager 里的 blob → tmpfs 目录 → execFile → 按 mtime 判断是否回写 → 清理
 *
 * 实测依据（见 docs/改造评估.md §12 §13）：
 *   - 三个不同 CONFIG_DIR 下 auth show --status 互不影响；真凭证不会渗到其他目录
 *   - 只读调用不触碰 credentials.enc（md5 与纳秒 mtime 均不变）→ mtime 即可靠回写信号
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP_ROOT = process.env.WECOM_TMP_ROOT || path.join(os.tmpdir(), 'wc');
const CRED_FILE = 'credentials.enc';
const KEY_FILE = '.encryption_key';

/**
 * 同一用户的并发调用必须串行化。
 *
 * CLI 自身有进程内单飞（日志字面量 "token already refreshed by a concurrent request,
 * reusing it"），但那不跨进程。两个并发请求共享同一个 CONFIG_DIR 时，双方都可能触发
 * token 刷新并各自重写 credentials.enc —— 后写的赢，先写的那次刷新丢失。
 *
 * 注意：这只解决单容器内的竞态。AgentCore 会横向扩多个实例，跨实例仍需在
 * Secrets Manager 回写时做条件写（版本号 CAS）。参考实现的 refreshUser() 恰好缺这一层，
 * 而企业微信 access_token 是企业级共享凭证，竞态影响面比飞书大 —— 不能照抄它的省略。
 */
const userChains = new Map();

function withUserLock(userId, fn) {
  const prev = userChains.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn);          // 前一个失败也要放行后一个
  // 链尾自清理，避免 Map 无界增长
  userChains.set(userId, next.then(() => {}, () => {}).finally(() => {
    if (userChains.get(userId) === next) userChains.delete(userId);
  }));
  return next;
}

function userDir(userId) {
  // 不把 userId 直接当路径，避免路径穿越
  const h = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  return path.join(TMP_ROOT, h);
}

/**
 * 把 blob 展开成 CONFIG_DIR。
 * blob 形如 { credentials_enc: <base64>, encryption_key: <base64> }
 */
async function materialize(userId, blob) {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);            // mkdir 的 mode 受 umask 影响，显式收紧
  await Promise.all([
    fs.writeFile(path.join(dir, CRED_FILE), Buffer.from(blob.credentials_enc, 'base64'), { mode: 0o600 }),
    fs.writeFile(path.join(dir, KEY_FILE), Buffer.from(blob.encryption_key, 'base64'), { mode: 0o600 }),
  ]);
  // ⚠️ mtimeNs 只存在于 BigIntStats —— 普通 fs.stat() 返回的 Stats 没有这个字段。
  // 漏掉 { bigint: true } 会让两边都是 undefined，比较恒为「未变化」，回写永不触发：
  // 每次调用都从旧 blob 起步、反复触发刷新，且刷新结果全部丢失。静默失败，必须防住。
  const st = await fs.stat(path.join(dir, CRED_FILE), { bigint: true });
  return { dir, mtimeNs: st.mtimeNs };   // 纳秒精度：实测 CLI 写入时间戳到纳秒
}

/** 调用后判断 CLI 是否刷新过 token；变了才需要回写 */
async function collectIfChanged(dir, mtimeNs) {
  let st;
  try {
    st = await fs.stat(path.join(dir, CRED_FILE), { bigint: true });
  } catch {
    return null;                          // 文件消失（授权被撤销等）——交由上层决定
  }
  // 兜底：若拿不到 mtimeNs（不该发生），宁可误判为「变了」也不要静默丢 token
  if (typeof mtimeNs !== 'bigint' || typeof st.mtimeNs !== 'bigint') {
    console.error(JSON.stringify({ level: 'WARN', event: 'mtime_ns_unavailable', dir }));
  } else if (st.mtimeNs === mtimeNs) {
    return null;
  }
  const [cred, key] = await Promise.all([
    fs.readFile(path.join(dir, CRED_FILE)),
    fs.readFile(path.join(dir, KEY_FILE)),
  ]);
  return {
    credentials_enc: cred.toString('base64'),
    encryption_key: key.toString('base64'),
  };
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 主入口：为一次（或一组）CLI 调用准备凭证目录，结束后按需回写并清理。
 *
 * @param {object}   deps            { loadBlob(userId), saveBlob(userId, blob) } —— 由 Secrets Manager 层注入
 * @param {string}   userId
 * @param {function} fn              (configDir) => Promise<any>
 */
async function withCredentials(deps, userId, fn) {
  return withUserLock(userId, async () => {
    const blob = await deps.loadBlob(userId);
    if (!blob) {
      const e = new Error('wecom_not_authorized');
      e.code = 'wecom_not_authorized';    // 上层据此返回 403 + authorize_url
      throw e;
    }
    const { dir, mtimeNs } = await materialize(userId, blob);
    try {
      return await fn(dir);
    } finally {
      // 回写在 finally 里做：调用失败也可能已经刷新过 token，丢了就得让用户重新授权
      try {
        const updated = await collectIfChanged(dir, mtimeNs);
        if (updated) await deps.saveBlob(userId, updated);
      } catch (err) {
        // 回写失败不能静默 —— 参考实现为此专门有 CRITICAL store_token_lost 告警
        console.error(JSON.stringify({
          level: 'CRITICAL', event: 'credential_writeback_failed',
          userId, error: String(err && err.message || err),
        }));
      }
      await cleanup(dir).catch(() => {});
    }
  });
}

module.exports = { withCredentials, withUserLock, userDir, materialize, collectIfChanged, cleanup };
