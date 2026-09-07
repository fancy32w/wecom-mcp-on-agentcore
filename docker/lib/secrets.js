'use strict';
/**
 * 凭证提供者调度。
 *
 *   WECOM_SECRETS_PROVIDER=aws  （默认）Secrets Manager，生产用
 *   WECOM_SECRETS_PROVIDER=env  单用户环境变量注入，**仅本地/CI 端到端验证用**
 *
 * 拆开的理由：AWS 实现在 require 时就会加载 @aws-sdk，本地跑 e2e 不该被迫装 SDK
 * 或配凭证。这里延迟到首次调用才加载具体实现。
 */

const PROVIDER = process.env.WECOM_SECRETS_PROVIDER || 'aws';

let impl = null;
function get() {
  if (impl) return impl;
  if (PROVIDER === 'env') {
    impl = require('./secrets-env');
  } else {
    impl = require('./secrets-aws');
  }
  return impl;
}

module.exports = {
  loadBlob: (userId) => get().loadBlob(userId),
  saveBlob: (userId, blob, who) => get().saveBlob(userId, blob, who),
  revoke: (userId) => get().revoke(userId),
  provider: PROVIDER,
};
