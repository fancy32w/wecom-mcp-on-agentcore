'use strict';
/**
 * 授权流测试。用一个假 CLI 桩脚本模拟三条分支，不需要真的 wecom-cli 也不碰网络。
 *
 * 覆盖 §15 末列出的 5 个缺陷修复：
 *   1. startAuth 幂等   2. 按 userId 查询   3. 推送式落库
 *   4. 893202 判过期    5. 失败原因用 extractCliError 解析
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 必须在 require('../lib/auth') 之前设好：cli.js 在加载时读取 WECOM_CLI_BIN
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wcstub-'));
const STUB = path.join(STUB_DIR, 'fake-wecom-cli');
process.env.WECOM_CLI_BIN = STUB;

const LINK = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=TESTSCODE';

/** mode=ok 写凭证并 exit 0；mode=qrtimeout 吐 893202 JSON 并 exit 1 */
function writeStub(mode) {
  fs.writeFileSync(STUB, `#!/bin/sh
# 身份探针分支：auth.js 在落库前会调一次 contact users search 读真人身份。
# 真 CLI 把身份塞在 extra_identity_context 里，这里照原样式伪造。
if [ "$1" = "contact" ]; then
  cat <<'IDJSON'
{
  "users": [],
  "extra_identity_context": "当前机器人身份：\\n  名字： 桩机器人\\n  ID： aibSTUB000\\n授权真人用户身份：\\n  名字： 桩用户\\n  ID： wo_STUB000\\n"
}
IDJSON
  exit 0
fi
echo "2026-08-27T00:00:00Z  INFO proc:cli.run: execute start"
echo "请打开二维码链接扫码: "
echo "${LINK}"
echo "2026-08-27T00:00:00Z DEBUG proc:cli.run: qr session created"
# 真 CLI 会按 --output-qrcode 写 PNG 到 cwd；桩也写一个，否则 readQrPng 会白等 2.4s。
# 必须 >100 字节：readQrPng 有个 length>100 的门槛，用来防读到半写状态的文件。
printf 'PNGFAKE0' > qr.png
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf '0123456789' >> qr.png; done
sleep 1
if [ "${mode}" = "ok" ]; then
  printf 'FAKECRED' > "$WECOM_CLI_CONFIG_DIR/credentials.enc"
  printf 'FAKEKEY'  > "$WECOM_CLI_CONFIG_DIR/.encryption_key"
  echo "credentials saved"
  exit 0
fi
cat <<'JSON'
{
  "error": {
    "type": "ValidationError",
    "code": 893202,
    "message": "QrTimeout: 扫码超时（5 分钟），请重试 [code=893202]"
  }
}
JSON
exit 1
`, { mode: 0o755 });
}

writeStub('ok');
const auth = require('../lib/auth');
const { extractCliError } = require('../lib/cli');

test('extractCliError 能从混杂日志行的输出里抽出错误', () => {
  const noisy = [
    '2026-08-27T09:00:00+08:00  INFO proc:cli.run: execute start',
    '2026-08-27T09:00:00+08:00 DEBUG proc:cli.run: connecting to 1.2.3.4:443',
    '{',
    '  "error": {',
    '    "type": "ValidationError",',
    '    "code": 893202,',
    '    "message": "QrTimeout: 扫码超时（5 分钟），请重试 [code=893202]"',
    '  }',
    '}',
  ].join('\n');
  const e = extractCliError(noisy);
  assert.strictEqual(e.code, 893202);
  assert.strictEqual(e.type, 'ValidationError');
  assert.match(e.message, /扫码超时/);
});

test('extractCliError 退路：只有 [code=N] 也能抽出', () => {
  const e = extractCliError('some log\n"message": "boom [code=850016]"\n');
  assert.strictEqual(e.code, 850016);
});

test('推送式落库：CLI 成功退出即刻写入，无需轮询', async () => {
  writeStub('ok');
  const saved = [];
  auth.configure({ onAuthorized: async (uid, blob, who) => { saved.push({ uid, blob, who }); } });

  const r = await auth.startAuth('u-push');
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.authorizeUrl, LINK);
  // 二维码要随 pending 视图一起返回，页面才能就地显示、不必跳新标签
  assert.ok(r.qrPngBase64, 'pending 视图应带出 qrPngBase64');
  assert.strictEqual(Buffer.from(r.qrPngBase64, 'base64').toString().slice(0, 8), 'PNGFAKE0');

  // 不调用任何 getStatus，等 CLI 自己退出
  await auth.sessions.get(r.sessionId).settled;

  assert.strictEqual(saved.length, 1, '凭证应在无人轮询的情况下已落库');
  assert.strictEqual(saved[0].uid, 'u-push');
  assert.strictEqual(Buffer.from(saved[0].blob.credentials_enc, 'base64').toString(), 'FAKECRED');
  assert.strictEqual(Buffer.from(saved[0].blob.encryption_key, 'base64').toString(), 'FAKEKEY');

  // 真人身份必须在清理会话目录**之前**读出来并随落库回调一起给出 ——
  // Lambda 侧靠它做「同一人只占一个凭证槽位」的去重
  assert.ok(saved[0].who, 'onAuthorized 第三参应带出真人身份');
  assert.strictEqual(saved[0].who.userId, 'wo_STUB000');
  assert.strictEqual(saved[0].who.userName, '桩用户');
  assert.strictEqual(saved[0].who.botId, 'aibSTUB000');

  const st = await auth.getStatus(r.sessionId);
  assert.strictEqual(st.status, 'authorized');
  assert.strictEqual(st.wecomIdentity.userId, 'wo_STUB000', 'authorized 视图应带出身份');
});

test('startAuth 幂等：同一用户重复调用返回同一会话', async () => {
  writeStub('ok');
  auth.configure({ onAuthorized: async () => {} });
  const a = await auth.startAuth('u-idem');
  const b = await auth.startAuth('u-idem');
  assert.strictEqual(b.sessionId, a.sessionId);
  assert.strictEqual(b.reused, true);
  assert.strictEqual(b.authorizeUrl, a.authorizeUrl);
  await auth.sessions.get(a.sessionId).settled;
});

test('按 userId 查询：sessionId 丢了也能拿到状态', async () => {
  writeStub('ok');
  auth.configure({ onAuthorized: async () => {} });
  const r = await auth.startAuth('u-lookup');
  const pending = await auth.getStatusByUser('u-lookup');
  assert.strictEqual(pending.status, 'pending');
  assert.strictEqual(pending.sessionId, r.sessionId);

  await auth.sessions.get(r.sessionId).settled;
  const done = await auth.getStatusByUser('u-lookup');
  assert.strictEqual(done.status, 'authorized', '终态也应能按 userId 倒查到');
});

test('893202 判为 expired，且 reason 是解析出的结构化信息不是 JSON 残片', async () => {
  writeStub('qrtimeout');
  auth.configure({ onAuthorized: async () => { throw new Error('不该被调用'); } });
  const r = await auth.startAuth('u-expire');
  await auth.sessions.get(r.sessionId).settled;

  const st = await auth.getStatus(r.sessionId);
  assert.strictEqual(st.status, 'expired');
  assert.match(st.reason, /ValidationError\(893202\)/);
  assert.match(st.reason, /扫码超时/);
  assert.ok(!st.reason.includes('|  } | }'), 'reason 不应是拼出来的 JSON 残片');
});

test('落库失败 → 标 failed 而非 authorized（不能让用户以为成功了）', async () => {
  writeStub('ok');
  auth.configure({ onAuthorized: async () => { throw new Error('secrets manager down'); } });
  const r = await auth.startAuth('u-fail');
  await auth.sessions.get(r.sessionId).settled;
  const st = await auth.getStatus(r.sessionId);
  assert.strictEqual(st.status, 'failed');
  assert.match(st.reason, /writeback_failed/);
});

test('终态后临时目录被清理', async () => {
  writeStub('ok');
  auth.configure({ onAuthorized: async () => {} });
  const r = await auth.startAuth('u-clean');
  const dir = auth.sessions.get(r.sessionId).dir;
  await auth.sessions.get(r.sessionId).settled;
  assert.strictEqual(fs.existsSync(dir), false);
});

test('shutdown 清空所有会话', async () => {
  writeStub('ok');
  auth.configure({ onAuthorized: async () => {} });
  await auth.startAuth('u-sd');
  await auth.shutdown();
  assert.strictEqual(auth.sessions.size, 0);
  assert.strictEqual(auth.byUser.size, 0);
});

test.after(() => fs.rmSync(STUB_DIR, { recursive: true, force: true }));
