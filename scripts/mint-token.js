#!/usr/bin/env node
'use strict';
/**
 * 为已授权用户补发 MCP token（运维工具）。
 *
 * 什么时候需要：自助页面 /authorize/self 是**浏览器绑定 + 一次性**的 —— 发起页面的
 * 浏览器才能取到 token，且只能取一次。如果用户关掉页面才想起要复制、或者发起和取回
 * 发生在不同浏览器，凭证已经存进 Secrets Manager 了但 token 拿不到。
 *
 * 这时候不要让用户重新扫码：重扫要重走一遍授权，而授权时企业微信会让他选新建机器人还是
 * 绑定已有的 —— 一旦选了新建，新机器人无法修改旧机器人创建的对象（见 docs/改造评估.md §14），
 * 代价是永久失去对旧产物的写权限。用这个脚本补发即可，完全不碰授权流程。
 *
 * 签名逻辑必须与 lambda/shared/tokens.js 完全一致：SSM 根密钥派生 mcp-token-v1 子密钥，
 * token = base64url(userId:expiresAt:hmac)。
 *
 * 用法：
 *   node scripts/mint-token.js --user u_xxx --region us-east-1 [--out /path/token.txt]
 *   node scripts/mint-token.js --list --region us-east-1     # 列出已授权用户
 *
 * 默认写入文件而不是打印，避免 token 落进终端记录 / 会话日志。
 */

const crypto = require('crypto');
const fs = require('fs');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SecretsManagerClient, ListSecretsCommand } = require('@aws-sdk/client-secrets-manager');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes('--' + name);

const REGION = arg('region', process.env.AWS_REGION || 'us-east-1');
const PREFIX = arg('prefix', 'wecom-mcp-on-agentcore');
const TTL_DAYS = Number(arg('days', 30));

async function listUsers() {
  const c = new SecretsManagerClient({ region: REGION });
  const r = await c.send(new ListSecretsCommand({
    Filters: [{ Key: 'name', Values: [`${PREFIX}/users`] }],
  }));
  const rows = (r.SecretList || []).map((s) => ({
    userId: s.Name.split('/').pop(),
    created: s.CreatedDate,
    changed: s.LastChangedDate,
  }));
  if (!rows.length) return console.log('没有已授权用户');
  console.log('已授权用户：');
  for (const x of rows) {
    console.log(`  ${x.userId}  创建 ${x.created?.toISOString?.() || x.created}`
      + `  最后更新 ${x.changed?.toISOString?.() || x.changed}`);
  }
}

async function mint(userId) {
  const ssm = new SSMClient({ region: REGION });
  const p = await ssm.send(new GetParameterCommand({
    Name: `/${PREFIX}/state-secret`, WithDecryption: true,
  }));
  const root = Buffer.from(p.Parameter.Value, 'utf8');
  // 与 lambda/shared/tokens.js 的 derive() 一致
  const tokenKey = crypto.createHmac('sha256', root).update('mcp-token-v1').digest();

  const exp = Date.now() + TTL_DAYS * 86400 * 1000;
  const payload = `${userId}:${exp}`;
  const mac = crypto.createHmac('sha256', tokenKey).update(payload).digest('base64url').slice(0, 43);
  return Buffer.from(`${payload}:${mac}`).toString('base64url');
}

(async () => {
  if (has('list')) return listUsers();

  const userId = arg('user');
  if (!userId) {
    console.error('用法: node scripts/mint-token.js --user <userId> [--out <file>] [--days 30]');
    console.error('      node scripts/mint-token.js --list');
    process.exit(1);
  }

  const token = await mint(userId);
  const out = arg('out');
  if (out) {
    fs.writeFileSync(out, `Bearer ${token}`, { mode: 0o600 });
    console.log(`已写入 ${out}（含 Bearer 前缀，权限 0600）。有效期 ${TTL_DAYS} 天。`);
    console.log('把文件内容整行贴进客户端的 Authorization header。用完请删除该文件。');
  } else {
    // 默认也不直接打印完整 token，避免落进会话记录
    console.log(`token 已生成（长度 ${token.length}）。加 --out <file> 写入文件后再取用。`);
  }
})().catch((e) => {
  console.error('失败:', e.name, String(e.message || e).slice(0, 200));
  process.exit(1);
});
