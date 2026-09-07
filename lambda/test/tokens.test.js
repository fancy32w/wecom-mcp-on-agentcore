'use strict';
/**
 * refresh token 签名与校验的单元测试。
 *
 * 用假的 SSM 桩：tokens.js 只在 loadKeys 里碰 SSM，把 GetParameter 拦掉即可离线跑。
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// 在 require('../shared/tokens') 之前拦掉 SSM 客户端
const origResolve = Module._resolveFilename;
const FAKE_ROOT = 'unit-test-root-secret-0123456789';
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@aws-sdk/client-ssm') {
    return {
      SSMClient: class { async send() { return { Parameter: { Value: FAKE_ROOT } }; } },
      GetParameterCommand: class { constructor(a) { this.a = a; } },
    };
  }
  return origLoad.apply(this, arguments);
};

process.env.STATE_SECRET_PARAM = '/unit-test/state-secret';
const T = require('../shared/tokens');
Module._load = origLoad;
Module._resolveFilename = origResolve;

const USER = 'u_deadbeefdeadbeefdeadbeefdeadbeef';

test('refresh token 往返：能取回 userId 与 jti', async () => {
  const jti = T.newJti();
  const tok = await T.signRefreshToken(USER, jti);
  const got = await T.verifyRefreshToken(tok);
  assert.ok(got, '应校验通过');
  assert.strictEqual(got.userId, USER);
  assert.strictEqual(got.jti, jti);
  assert.ok(got.expiresAt > Date.now());
});

test('jti 每次不同 —— 轮换才有意义', () => {
  assert.notStrictEqual(T.newJti(), T.newJti());
});

test('篡改签名必须被拒', async () => {
  const tok = await T.signRefreshToken(USER, T.newJti());
  const raw = Buffer.from(tok, 'base64url').toString('utf8');
  const bad = Buffer.from(raw.slice(0, -1) + 'X').toString('base64url');
  assert.strictEqual(await T.verifyRefreshToken(bad), null);
});

test('过期必须被拒', async () => {
  const tok = await T.signRefreshToken(USER, T.newJti(), -1000);
  assert.strictEqual(await T.verifyRefreshToken(tok), null);
});

test('access token 的签名不能当 refresh token 用（域分离）', async () => {
  const access = await T.signMcpToken(USER);
  assert.strictEqual(await T.verifyRefreshToken(access), null);
});

test('refresh token 也不能当 access token 用', async () => {
  const refresh = await T.signRefreshToken(USER, T.newJti());
  assert.strictEqual(await T.verifyMcpToken(refresh), null);
});

test('userId 含冒号时仍能正确切分', async () => {
  // payload 是 userId:jti:exp，从右往左切才对。若来日 userId 形态变了，这条会先炸。
  const weird = 'u_with:colon:inside';
  const jti = T.newJti();
  const got = await T.verifyRefreshToken(await T.signRefreshToken(weird, jti));
  assert.strictEqual(got.userId, weird);
  assert.strictEqual(got.jti, jti);
});

test('空值与垃圾输入返回 null 而不抛', async () => {
  for (const bad of [null, undefined, '', 'not-base64!!', 'YWJj']) {
    assert.strictEqual(await T.verifyRefreshToken(bad), null, `输入 ${bad}`);
  }
});
