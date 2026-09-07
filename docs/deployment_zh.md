# 部署手册（运维用）

全程约 **45 分钟**，其中 15 分钟在等。命令都是幂等的，失败可以直接重跑。

---

## 一、开工前核对 `10 分钟`

逐项打勾，**有一项没准备好就别开始**。

- [ ] AWS 账号，区域是这 7 个之一：`us-east-1` `us-west-2` `ap-northeast-1` `ap-southeast-2` `eu-central-1` `eu-west-1` `eu-west-2`
- [ ] Amazon Quick Suite **Enterprise** 订阅
- [ ] 本机装了 `aws` CLI 并已配置凭证
- [ ] 本机装了 Node.js **20 或更高**
- [ ] 本机有 `python3`
- [ ] 企业微信管理员已把本服务加入**读取类权限免审名单**
- [ ] 操作用的 IAM 身份能创建 IAM 角色（`iam:CreateRole` + `iam:PassRole`）

跑这一条自检，三行都要有输出：

```bash
aws sts get-caller-identity
node -v
python3 -V
```

<details>
<summary>为什么区域只能选这 7 个</summary>

Amazon Quick Suite 的完整功能（含 MCP 连接器）只在这 7 个区域提供。选了别的区，前面都能部署成功，但最后一步在 Quick 里建连接器时会发现功能不可用。

其他依赖（Bedrock AgentCore）在这 7 个区域均可用，不构成额外限制。
</details>

<details>
<summary>IAM 权限为什么要单独确认</summary>

部署会创建 CloudFormation 栈、**IAM 角色**、Lambda、DynamoDB、KMS 密钥、CloudFront、API Gateway、ECR 仓库、CodeBuild 项目、AgentCore Runtime、SSM 参数、Secrets Manager 密钥。

只有 PowerUser 而没有 IAM 创建权限时，部署会**跑十几分钟后才失败**，很浪费时间。所以提前确认。
</details>

<details>
<summary>免审名单没加会怎样</summary>

员工能扫码成功、能拿到令牌，但**每一次实际调用都被企业微信拒绝**。表现像是服务坏了，实际是权限没批。

现场很难排查，务必提前办。
</details>

---

## 二、装依赖 `5 分钟`

```bash
cd wecom-mcp-on-agentcore

cd infra && npm install && cd ..
cd lambda && npm install --omit=dev && cd ..
python3 -m venv .venv && .venv/bin/pip install boto3
```

**看到什么算对**：三条命令都没有 `ERR!` 或 `error`。

---

## 三、初始化 CDK `5 分钟`

每个账号每个区域只需做一次。已经做过的会直接跳过。

```bash
cd infra && npx cdk bootstrap && cd ..
```

**看到什么算对**：`✅  Environment aws://<账号>/<区域> bootstrapped`

---

## 四、部署 `15 分钟`

把 `<区域>` 换成第一步选定的区域。

```bash
bash scripts/run-deploy.sh --region <区域>
```

**看到什么算对**，依次出现这几行：

```
工具： aws=...  container=...  python=...
▸ ① 前置检查        账号 xxx / 区域 xxx / 架构 xxx
▸ ② 签名根密钥
▸ ③ CDK 部署        ✅  WecomMcpOnAgentCore
▸ ④ 构建并推送镜像（local 或 codebuild）
▸ ⑤ AgentCore Runtime    runtime: READY / endpoint: READY
▸ ⑥ 回填 Lambda 配置
部署完成
```

最后会打印**服务端点**，形如 `https://xxxxxxxx.cloudfront.net`。**记下来，后面每一步都要用。**

<details>
<summary>第④步显示 codebuild 是正常的</summary>

本服务的容器只能在 ARM64 架构上构建。脚本会自动探测：

- 本机是 ARM64（如 Apple Silicon Mac）且容器运行时可用 → 本机构建，显示 `local`
- 其他情况 → 自动改用云端 CodeBuild 构建，显示 `codebuild`，约 3–6 分钟

**走 codebuild 时本机完全不需要安装 Docker**，Windows 和 Intel Mac 都能部署。两种方式产出的镜像相同。
</details>

<details>
<summary>部署失败了怎么办</summary>

脚本是幂等的，**直接重跑同一条命令**即可，不会产生重复资源。

只更新代码、不重建镜像时可以加 `--skip-image` 加快速度：

```bash
bash scripts/run-deploy.sh --region <区域> --skip-image
```
</details>

---

## 五、验证 `5 分钟`

把 `<端点>` 换成第四步打印的地址。

```bash
curl -s -o /dev/null -w '%{http_code}\n' <端点>/.well-known/oauth-authorization-server
curl -s -o /dev/null -w '%{http_code}\n' -X POST <端点>/mcp -d '{}'
```

**看到什么算对**：第一条返回 `200`，第二条返回 `401`。

<details>
<summary>401 为什么是对的</summary>

第二条是故意不带凭证访问的。返回 401 说明鉴权正在生效——如果它返回 200，才是有问题。
</details>

---

## 六、订阅告警 `3 分钟`

**默认没有任何订阅者，不做这一步告警发不出来。**

```bash
aws sns list-topics --region <区域> --query 'Topics[?contains(TopicArn,`WecomMcp`)]'
aws sns subscribe --topic-arn <上一条查到的ARN> \
  --protocol email --notification-endpoint <运维邮箱> --region <区域>
```

**看到什么算对**：邮箱收到 AWS 的确认邮件，点确认。

---

## 七、发放给员工 `2 分钟`

1. 打开 `docs/connect-mcp-clients_zh.md`
2. 把里面**全部 5 处** `<MCP_ENDPOINT>` 替换成第四步的实际端点
3. 发给员工

> ⚠️ 必须替换。沿用文档里的占位符或别人的端点，会导致员工的企业微信凭证存进**别人的** AWS 账号。

---

## 八、告诉员工这一件事

**扫码后企业微信会问：新建一个「机器人」，还是绑定一个已有的。**

首次授权名下没有机器人，只能新建。**之后每次重新授权，都要选「绑定已有机器人」并选中原来那个。**

原因：写操作只认机器人所有权。选了新建，就**永久失去**对旧机器人所建文档 / 表格 / 日程的编辑权限。

所以员工须知只有两句：

1. 令牌到期客户端会自动续，**正常情况下不需要重新授权**。
2. 万一要重新授权，**选绑定原有机器人，不要新建**。

完整的平台行为说明见 `docs/limitations_zh.md`。

---

## 日常运维

```bash
# 查有哪些用户已授权
node scripts/mint-token.js --list --region <区域>

# 给某用户补发访问令牌（他把页面关了没复制到时用）
node scripts/mint-token.js --user <userId> --region <区域> --out token.txt

# 检查每个用户的凭证是否还有效
bash scripts/probe-creds.sh <端点> <区域>
```

<details>
<summary>凭证为什么会失效</summary>

最常见的原因是**有人在企业微信里删掉了对应的机器人**。密钥还在，但调用会返回 `errcode 853005 cli token invalid`。

`probe-creds.sh` 会把每条凭证标为「✓ 有效」或「✗ 失效」并给出错误码。失效的用户需要重新授权。
</details>

<details>
<summary>撤销某个用户的访问</summary>

删除该用户在 Secrets Manager 里的密钥即可（路径 `wecom-mcp-on-agentcore/users/<userId>`），有 7 天恢复窗口。

注意这是**撤销**而不是重置：该用户之后需要重新授权。提醒他授权时选「绑定已有机器人」，
否则会多一个机器人并失去对旧产物的写权限。
</details>

---

## 卸载

```bash
cd infra && npx cdk destroy
```

以下资源**不会**被一起删掉，需要手动清理：

| 资源 | 位置 |
|---|---|
| 用户凭证的 KMS 密钥 | KMS 控制台（策略为保留） |
| 容器镜像仓库 | ECR，仓库名 `wecom-mcp` |
| AgentCore Runtime 与其执行角色 | Bedrock AgentCore / IAM |
| 两个 SSM 参数 | Parameter Store，路径 `/wecom-mcp-on-agentcore/*` |
| 用户凭证 | Secrets Manager，路径 `wecom-mcp-on-agentcore/users/*` |

> ⚠️ SSM 里的 `state-secret` 是所有令牌的签名根密钥。**删掉或重建它会让已发出的全部令牌立即失效**，所有用户都要重新授权（须逐一提醒他们选「绑定已有机器人」，否则集体丢写权限）。除非确定要彻底废弃，不要动它。

---

## 出问题时先看这里

| 现象 | 原因 | 处置 |
|---|---|---|
| 部署跑十几分钟后报 IAM 错误 | 操作身份缺 `CreateRole` / `PassRole` | 补权限后重跑 |
| 第三步报找不到 bootstrap 资源 | 该区域没初始化过 CDK | 回到第三步 |
| 员工扫码成功但调用全被拒 | 免审名单没加 | 找企业微信管理员加 |
| Quick 里建连接器失败 | 失败的连接器**不能原地重试** | 删掉重新创建 |
| 授权页一直停在「等待扫码」 | 扫码超时（5 分钟）或页面已过期 | 重新打开授权页 |
| `--build local` 报架构不对 | 本机不是 ARM64 | 去掉该参数，让它自动走 CodeBuild |
