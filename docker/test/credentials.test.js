'use strict';
/**
 * 验证凭证物化与 mtime 回写判定 —— 与飞书版差异最大、也最容易出错的一块。
 *
 * 实测依据：只读调用不触碰 credentials.enc（md5 与纳秒 mtime 均不变），
 * 所以 mtime 是可靠的「CLI 是否刷新了 token」信号。见 docs/改造评估.md §13-D。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

process.env.WECOM_TMP_ROOT = path.join(os.tmpdir(), 'wc-test-' + process.pid);
const {
  materialize, collectIfChanged, cleanup, userDir, withUserLock, withCredentials,
} = require('../lib/credentials');

// 真实字节数：实测 macOS 与 linux 容器内一致
const BLOB = {
  credentials_enc: Buffer.alloc(215, 7).toString('base64'),
  encryption_key: Buffer.alloc(44, 9).toString('base64'),
};

test('物化出 0600 文件与 0700 目录', async () => {
  const { dir } = await materialize('user-a', BLOB);
  const dst = await fs.stat(path.join(dir, 'credentials.enc'));
  const dst2 = await fs.stat(path.join(dir, '.encryption_key'));
  const dstDir = await fs.stat(dir);
  assert.strictEqual(dst.size, 215);
  assert.strictEqual(dst2.size, 44);
  assert.strictEqual(dst.mode & 0o777, 0o600);
  assert.strictEqual(dst2.mode & 0o777, 0o600);
  assert.strictEqual(dstDir.mode & 0o777, 0o700);
  await cleanup(dir);
});

test('userId 不进路径（防路径穿越）', () => {
  const d = userDir('../../etc/passwd');
  assert.ok(!d.includes('..'), `目录名不应含 ..: ${d}`);
  assert.match(path.basename(d), /^[0-9a-f]{16}$/);
});

test('不同 userId 得到不同目录（隔离前提）', () => {
  assert.notStrictEqual(userDir('u1'), userDir('u2'));
});

test('文件未变 → 不触发回写', async () => {
  const { dir, mtimeNs } = await materialize('user-b', BLOB);
  assert.strictEqual(await collectIfChanged(dir, mtimeNs), null);
  await cleanup(dir);
});

test('CLI 重写凭证 → 检出变化并收走新 blob', async () => {
  const { dir, mtimeNs } = await materialize('user-c', BLOB);
  // 模拟 CLI 刷新 token 后重写（内容变、mtime 变）
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(dir, 'credentials.enc'), Buffer.alloc(215, 42), { mode: 0o600 });
  const got = await collectIfChanged(dir, mtimeNs);
  assert.ok(got, '应检出变化');
  assert.strictEqual(Buffer.from(got.credentials_enc, 'base64')[0], 42);
  assert.strictEqual(Buffer.from(got.encryption_key, 'base64').length, 44);
  await cleanup(dir);
});

test('凭证文件消失 → 返回 null 交上层决定', async () => {
  const { dir, mtimeNs } = await materialize('user-d', BLOB);
  await fs.rm(path.join(dir, 'credentials.enc'));
  assert.strictEqual(await collectIfChanged(dir, mtimeNs), null);
  await cleanup(dir);
});

test('同一用户的并发调用被串行化', async () => {
  const order = [];
  const mk = (tag, ms) => () => new Promise((r) => setTimeout(() => { order.push(tag); r(tag); }, ms));
  // 先起的慢、后起的快；若未串行化，fast 会先完成
  const p1 = withUserLock('same-user', mk('slow', 60));
  const p2 = withUserLock('same-user', mk('fast', 5));
  await Promise.all([p1, p2]);
  assert.deepStrictEqual(order, ['slow', 'fast']);
});

test('未授权用户 → 抛 wecom_not_authorized 供上层转 403', async () => {
  const deps = { loadBlob: async () => null, saveBlob: async () => {} };
  await assert.rejects(
    withCredentials(deps, 'nobody', async () => 'unreachable'),
    (e) => e.code === 'wecom_not_authorized',
  );
});

test('调用抛错也要回写已刷新的凭证（不能丢 token）', async () => {
  let saved = null;
  const deps = {
    loadBlob: async () => BLOB,
    saveBlob: async (_u, b) => { saved = b; },
  };
  await assert.rejects(withCredentials(deps, 'user-e', async (dir) => {
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(dir, 'credentials.enc'), Buffer.alloc(215, 99), { mode: 0o600 });
    throw new Error('业务调用失败');
  }), /业务调用失败/);
  assert.ok(saved, '业务失败但凭证已刷新，必须回写');
  assert.strictEqual(Buffer.from(saved.credentials_enc, 'base64')[0], 99);
});

test('调用结束后临时目录被清理', async () => {
  const deps = { loadBlob: async () => BLOB, saveBlob: async () => {} };
  let seen;
  await withCredentials(deps, 'user-f', async (dir) => { seen = dir; return 1; });
  await assert.rejects(fs.stat(seen), { code: 'ENOENT' });
});
