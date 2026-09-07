#!/usr/bin/env python3
"""
AgentCore Runtime 的创建 / 更新 / endpoint 生命周期。

为什么不走 CDK：AgentCore Runtime 当时没有成熟的 CFN/CDK 构造，且
「create → 冲突则 update → 版本递增 → endpoint 跟着换版本」这套流程是命令式的。
参考实现（sample-lark-mcp-on-agentcore/scripts/deploy.sh:1573-1690）用 inline heredoc 做，
这里抽成独立脚本，便于单独重跑和排错。

相比参考实现的三处改进：
  1. 用 client.exceptions.ConflictException 而非 `'Conflict' in str(e)` 字符串匹配
  2. 先按名字查一遍再决定 create/update，不依赖异常做控制流
  3. --dry-run 可只打印将要提交的配置

用法：
  python3 agentcore.py --name wecom_mcp --role-arn arn:... --image-uri ...:tag \\
      --region us-east-1 --authorize-base https://xxx.cloudfront.net [--dry-run]

成功时向 stdout 打印一行 JSON：{"runtimeId":..., "runtimeArn":..., "version":..., "endpoint":"ep"}
"""
import argparse
import json
import sys
import time

# boto3 刻意**不在模块顶层导入**：--help 和 --dry-run 不该因为环境里没装 boto3 就不可用。
# （第一版就是顶层导入，结果在没装 boto3 的机器上连帮助都看不到。）


def _boto3():
    try:
        import boto3                      # noqa: PLC0415
    except ImportError:
        sys.exit('缺少 boto3：pip3 install boto3')
    return boto3

ENDPOINT_NAME = 'ep'
READY_TIMEOUT_S = 300
POLL_INTERVAL_S = 5

# 身份注入通道。**漏配这个 header 的表现是容器永远拿不到身份、且没有任何报错** ——
# AgentCore 会静默丢弃不在允许清单里的自定义 header。
# 飞书版还有 X-User-Access-Token / X-Incr-Auth-Token；企业微信只需要 userId，
# 凭证由容器自己从 Secrets Manager 取（docker/lib/credentials.js）。
REQUEST_HEADER_ALLOWLIST = ['X-Runtime-User-Id']


def build_config(a):
    return {
        'roleArn': a.role_arn,
        'agentRuntimeArtifact': {'containerConfiguration': {'containerUri': a.image_uri}},
        'networkConfiguration': {'networkMode': 'PUBLIC'},
        'protocolConfiguration': {'serverProtocol': 'MCP'},
        'lifecycleConfiguration': {'idleRuntimeSessionTimeout': a.idle_timeout},
        'requestHeaderConfiguration': {'requestHeaderAllowlist': REQUEST_HEADER_ALLOWLIST},
        'environmentVariables': {
            'AWS_REGION': a.region,
            'AUTHORIZE_BASE': a.authorize_base,
            'SECRET_PREFIX': a.secret_prefix,
            'USER_SECRET_KMS_KEY_ARN': a.kms_key_arn,
            'WECOM_SECRETS_PROVIDER': 'aws',
            'WECOM_TMP_ROOT': '/tmp/wc',
            'WECOM_SCHEMA_DIR': '/app/schemas',
        },
    }


def find_by_name(c, name):
    """分页找同名 runtime。不靠异常做控制流。"""
    token = None
    while True:
        kw = {'nextToken': token} if token else {}
        page = c.list_agent_runtimes(**kw)
        for r in page.get('agentRuntimes', []):
            if r.get('agentRuntimeName') == name:
                return r['agentRuntimeId']
        token = page.get('nextToken')
        if not token:
            return None


def wait_ready(get, describe_kw, label):
    deadline = time.time() + READY_TIMEOUT_S
    last = None
    while time.time() < deadline:
        r = get(**describe_kw)
        s = r.get('status')
        if s != last:
            print(f'  {label}: {s}', file=sys.stderr)
            last = s
        if s == 'READY':
            return r
        if s and ('FAILED' in s):
            reason = r.get('failureReason') or r.get('statusReason') or '未提供原因'
            sys.exit(f'  {label} 失败: {s} — {reason}')
        time.sleep(POLL_INTERVAL_S)
    sys.exit(f'  {label} 在 {READY_TIMEOUT_S}s 内未就绪（最后状态 {last}）')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--name', required=True, help='agentRuntimeName（只能字母数字下划线）')
    p.add_argument('--role-arn', required=True)
    p.add_argument('--image-uri', required=True)
    p.add_argument('--region', required=True)
    p.add_argument('--authorize-base', required=True, help='CloudFront 端点，容器用它拼授权链接')
    p.add_argument('--secret-prefix', default='wecom-mcp-on-agentcore/users')
    p.add_argument('--kms-key-arn', default='')
    p.add_argument('--idle-timeout', type=int, default=1800,
                   help='空闲会话超时秒数。扫码轮询最长 300s，留足余量')
    p.add_argument('--app-tag', default='default')
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args()

    cfg = build_config(a)
    if a.dry_run:
        print(json.dumps({'agentRuntimeName': a.name, **cfg}, ensure_ascii=False, indent=2))
        return

    boto3 = _boto3()
    c = boto3.client('bedrock-agentcore-control', region_name=a.region)

    rid = find_by_name(c, a.name)
    if rid:
        print(f'  已存在 {a.name}（{rid}），执行更新', file=sys.stderr)
        # update_agent_runtime 不接受 tags —— tags 在 create 时打上后一直保留
        c.update_agent_runtime(agentRuntimeId=rid, **cfg)
    else:
        print(f'  创建 {a.name}', file=sys.stderr)
        try:
            resp = c.create_agent_runtime(
                agentRuntimeName=a.name,
                description='WeCom MCP Server (wecom-cli)',
                tags={'project': 'wecom-mcp-on-agentcore', 'app': a.app_tag},
                **cfg,
            )
            rid = resp['agentRuntimeId']
        except c.exceptions.ConflictException:
            # 与另一个部署撞车：重查一次再更新
            rid = find_by_name(c, a.name)
            if not rid:
                sys.exit('  ConflictException 但按名字查不到 runtime，请手动检查')
            c.update_agent_runtime(agentRuntimeId=rid, **cfg)

    rt = wait_ready(c.get_agent_runtime, {'agentRuntimeId': rid}, 'runtime')
    version = str(rt.get('agentRuntimeVersion', '1'))

    # endpoint 必须跟着 runtime 的当前版本走：update 会让版本递增，
    # endpoint 若还指向旧版本，流量就打不到新镜像上。
    # 注意 API 本身参数名不一致：create 用 name=，update 用 endpointName=
    try:
        c.create_agent_runtime_endpoint(
            agentRuntimeId=rid, name=ENDPOINT_NAME, agentRuntimeVersion=version)
        print(f'  创建 endpoint {ENDPOINT_NAME} → v{version}', file=sys.stderr)
    except c.exceptions.ConflictException:
        c.update_agent_runtime_endpoint(
            agentRuntimeId=rid, endpointName=ENDPOINT_NAME, agentRuntimeVersion=version)
        print(f'  更新 endpoint {ENDPOINT_NAME} → v{version}', file=sys.stderr)

    wait_ready(c.get_agent_runtime_endpoint,
               {'agentRuntimeId': rid, 'endpointName': ENDPOINT_NAME}, 'endpoint')

    account = boto3.client('sts', region_name=a.region).get_caller_identity()['Account']
    arn = f'arn:aws:bedrock-agentcore:{a.region}:{account}:runtime/{rid}'
    print(json.dumps({
        'runtimeId': rid, 'runtimeArn': arn, 'version': version, 'endpoint': ENDPOINT_NAME,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
