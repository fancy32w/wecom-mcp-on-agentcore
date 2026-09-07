'use strict';
/**
 * 环境变量凭证提供者 —— **仅本地 / CI 端到端验证用，不要在生产启用**。
 *
 * 生产必须用 secrets-aws.js：凭证加密存 Secrets Manager、专用 KMS 密钥、按用户隔离。
 * 这里把单个用户的 blob 放在环境变量里，纯粹为了在没有 AWS 凭证的机器上验证
 * 「物化 → 调用 → mtime 判回写」这条链路真的能跑通。
 *
 *   WECOM_TEST_USER_ID    要匹配的 userId
 *   WECOM_TEST_BLOB       JSON: {"credentials_enc":"<b64>","encryption_key":"<b64>"}
 *   WECOM_TEST_BLOB_FILE  同上但从文件读（优先）——避免凭证出现在进程环境或命令行里
 *   WECOM_TEST_BLOB_OUT   可选：回写时把新 blob 写到这个文件路径，便于观察刷新
 */

const fs = require('fs');

const USER = process.env.WECOM_TEST_USER_ID || 'test-user';
let cached = null;

function parse() {
  if (cached !== null) return cached;
  let raw = null;
  const file = process.env.WECOM_TEST_BLOB_FILE;
  if (file) {
    try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = null; }
  }
  if (!raw) raw = process.env.WECOM_TEST_BLOB;
  if (!raw) { cached = false; return cached; }
  try {
    const b = JSON.parse(raw);
    cached = (b.credentials_enc && b.encryption_key) ? b : false;
  } catch {
    cached = false;
  }
  return cached;
}

async function loadBlob(userId) {
  if (userId !== USER) return null;
  return parse() || null;
}

async function saveBlob(userId, blob) {
  cached = blob;                          // 让后续调用看到刷新后的凭证
  const out = process.env.WECOM_TEST_BLOB_OUT;
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ userId, ...blob, saved_at: new Date().toISOString() }));
  }
  console.log(JSON.stringify({ level: 'INFO', event: 'blob_written_back', userId, provider: 'env' }));
  return true;
}

async function revoke() { cached = false; return true; }

module.exports = { loadBlob, saveBlob, revoke };
