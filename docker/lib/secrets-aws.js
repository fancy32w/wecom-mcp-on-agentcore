'use strict';
/**
 * 生产凭证提供者：AWS Secrets Manager。
 *
 * 沿用参考实现的形态：每用户一个 secret `${SECRET_PREFIX}/${userId}`，每应用一把 CMK，
 * 容器角色只需要 GetSecretValue / PutSecretValue（+ 首次 CreateSecret）与对应 KMS 权限。
 *
 * ⚠️ 必须补参考实现缺的一层：**跨实例条件写**。
 * 参考实现的 refreshUser() 没有分布式锁或条件写防同一 userId 并发刷新，靠
 * 「EventBridge 单次触发 + 批内 userId 唯一」。飞书那边后果是单用户 RT 失效；
 * 企业微信的 access_token 是**企业级共享凭证**，竞态影响面是全员。
 * lib/credentials.js 的 withUserLock 只覆盖单容器内，AgentCore 横向扩实例后仍会撞车。
 *
 * TODO(未实现): VersionId 乐观并发。当前只做到「读时缓存 VersionId + 写后校验是否被抢」，
 * 真正的 CAS 需要 PutSecretValue 支持条件更新（SDK 无原生条件参数），
 * 实现路径是改用 DynamoDB 存 blob（原生条件写）或在 secret 里带单调递增 seq 自行校验。
 */

const {
  SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand,
  CreateSecretCommand, DeleteSecretCommand, TagResourceCommand,
} = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = process.env.SECRET_PREFIX || 'wecom-mcp-on-agentcore/users';
const KMS_KEY = process.env.USER_SECRET_KMS_KEY_ARN;

const client = new SecretsManagerClient({ region: REGION });
const versionCache = new Map();           // userId → 上次读到的 VersionId

const secretId = (userId) => `${PREFIX}/${userId}`;

async function loadBlob(userId) {
  try {
    const r = await client.send(new GetSecretValueCommand({ SecretId: secretId(userId) }));
    versionCache.set(userId, r.VersionId);
    const blob = JSON.parse(r.SecretString);
    return (blob.credentials_enc && blob.encryption_key) ? blob : null;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return null;
    throw e;
  }
}

/**
 * 写入凭证。`who` 是扫码真人的稳定企业微信身份（可为 null）。
 *
 * 身份存两处，各有用途：
 *   - SecretString 里的 wecom_identity —— 供 Lambda 读出来做同人去重
 *   - Secret 的 Tag —— 让 list-secrets 直接按人筛，不必逐条 GetSecretValue
 *     （GetSecretValue 会解密，运维列名册时不该顺手把凭证全捞出来）
 * Tag 值不接受任意字符，这里只放 ASCII 的 wo_ 开头 id，不放中文姓名。
 */
/**
 * 打标签，失败只告警不抛。
 *
 * 标签纯粹是运维便利（让 list-secrets 能按人筛，不必逐条 GetSecretValue 解密），
 * 所以它**绝不能**影响凭证是否存住。但也不能像原先那样 `.catch(() => {})` 静默吞掉：
 * 那会让「权限缺失」这类问题永远看不见。缺权限时打 WARN，一眼能查。
 */
async function tagQuietly(secretId, tags) {
  if (!tags) return;
  try {
    await client.send(new TagResourceCommand({ SecretId: secretId, Tags: tags }));
  } catch (e) {
    console.error(JSON.stringify({
      level: 'WARN', event: 'secret_tag_failed', secretId,
      error: String(e.name || e),
      note: '凭证已存住，只是少了按人筛的标签；若为权限问题请给执行角色加 secretsmanager:TagResource',
    }));
  }
}

async function saveBlob(userId, blob, who = null) {
  const seenVersion = versionCache.get(userId);
  const SecretString = JSON.stringify({
    ...blob,
    updated_at: new Date().toISOString(),
    wecom_identity: who || null,
  });
  const id = secretId(userId);
  const tags = who && /^[\w.:/=+@-]{1,256}$/.test(who.userId || '')
    ? [{ Key: 'WecomUserId', Value: who.userId }]
    : null;
  try {
    const r = await client.send(new PutSecretValueCommand({ SecretId: id, SecretString }));
    versionCache.set(userId, r.VersionId);
    await tagQuietly(id, tags);
    return true;
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
    // ⚠️ 刻意**不把 Tags 内联进 CreateSecret**。
    // 带 Tags 的 CreateSecret 需要 secretsmanager:TagResource 权限，缺这条权限时
    // 整个调用失败 —— 于是「打个运维标签」这件小事把凭证落库整条路堵死。
    // 2026-08-31 真实踩到：②身份去重上线后首次新用户授权全部失败，
    // CRITICAL auth_writeback_failed = TagResource is not authorized，
    // 用户连扫数次码、每次都新建了机器人，却一条凭证都没存进来。
    // 现在先无标签建 secret（凭证优先落地），再单独打标签且失败只告警。
    const r = await client.send(new CreateSecretCommand({
      Name: id, SecretString, KmsKeyId: KMS_KEY,
    }));
    versionCache.set(userId, r.VersionId);
    await tagQuietly(id, tags);
    return true;
  } finally {
    // 检测是否被其他实例抢写。只告警不阻断：这一层要靠上面的 TODO 才能真正串行化。
    if (seenVersion) {
      client.send(new GetSecretValueCommand({ SecretId: id }))
        .then((cur) => {
          if (cur.VersionId !== versionCache.get(userId)) {
            console.error(JSON.stringify({
              level: 'WARN', event: 'concurrent_blob_write_detected', userId,
            }));
          }
        })
        .catch(() => {});
    }
  }
}

/** 撤权时删凭证，让下次调用走引导重新授权。7 天恢复窗口，不 ForceDelete。 */
async function revoke(userId) {
  await client.send(new DeleteSecretCommand({
    SecretId: secretId(userId), RecoveryWindowInDays: 7,
  }));
  versionCache.delete(userId);
  return true;
}

module.exports = { loadBlob, saveBlob, revoke, secretId };
