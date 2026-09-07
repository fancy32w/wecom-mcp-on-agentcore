#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WecomMcpStack } from '../lib/wecom-mcp-stack';

const app = new cdk.App();

// 多应用隔离：-c slug=<name> 派生所有物理名（与参考实现的 slug 约定一致）
const slug = app.node.tryGetContext('slug') || '';
const sfx = slug ? `-${slug}` : '';

new WecomMcpStack(app, `WecomMcpOnAgentCore${sfx}`, {
  slug,
  // Quick Desktop 的 redirect 走 loopback（代码里恒许）；Quick 云端的回调是
  // https://{region}.quicksight.aws.amazon.com/sn/oauthcallback —— **带 region 前缀**，
  // 见 quick/latest/userguide/zapier-integration.html。host 是精确比对，写裸域名会被拒。
  // deploy.sh 在 CDK 之后还会用 update-function-configuration 覆盖这个值，两处要一致。
  allowedRedirectHosts: (app.node.tryGetContext('redirectHosts')
    || `${process.env.CDK_DEFAULT_REGION || 'us-east-1'}.quicksight.aws.amazon.com,quicksight.aws.amazon.com`)
    .split(',').map((s: string) => s.trim()).filter(Boolean),
  webAclArn: app.node.tryGetContext('webAclArn') || undefined,
  runtimeRoleArn: app.node.tryGetContext('runtimeRoleArn') || undefined,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  tags: { project: 'wecom-mcp-on-agentcore', app: slug || 'default' },
});
