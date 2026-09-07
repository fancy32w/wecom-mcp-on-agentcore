# 合规与数据流


## 一句话结论

企业微信数据（通讯录、文档、日程、待办、微盘、邮件）以及等同于员工企业微信读取权限的凭证，
**会离开中国境内，存放并处理于你所选择的海外 AWS 区域**。

原因：本服务依赖的 Amazon Bedrock AgentCore 与 Amazon Quick Suite **均无中国区**。
这不是配置选项，改不掉。

---

## 数据流

```
企业微信员工
    │  ① 扫码授权（在企业微信 App 内完成，凭证不经浏览器）
    ▼
CloudFront ──► API Gateway (HTTP API) ──► Lambda ──► AgentCore Runtime（容器）
                                            │              │
                                            │              └─► ② wecom-cli ──► qyapi.weixin.qq.com
                                            │                                   （企业微信开放接口）
                                            ├─► ③ Secrets Manager（凭证，专用 CMK 加密）
                                            ├─► DynamoDB（授权流程状态、授权码、refresh token 的 jti）
                                            └─► SSM Parameter Store（签名根密钥，SecureString）

MCP 客户端（Quick Suite / Kiro / Claude Code 等）──► CloudFront /mcp
```

**出境点只有一个方向**：上图中除了 ② 是回连企业微信境内接口外，其余所有存储与计算都在你选定的海外区域。

## 具体存了什么、在哪、多久

| 数据 | 位置 | 加密 | 保留 |
|---|---|---|---|
| 企业微信凭证 blob | Secrets Manager `<prefix>/users/<userId>` | 客户托管 CMK | 直到管理员撤销（`DeleteSecret` 留 7 天恢复窗口） |
| 真人身份标识（`wo_…`） | 同上，SecretString 内 + Secret 标签 | 同上 | 同上 |
| 授权流程状态 | DynamoDB | AWS 托管 | TTL 300 秒 |
| authorization_code | DynamoDB | AWS 托管 | TTL 300 秒 |
| refresh token 的 jti | DynamoDB | AWS 托管 | TTL 90 天，每次续期重置 |
| 签名根密钥 | SSM SecureString | AWS 托管 KMS | 长期，**不可轮换**（轮换会让所有已发令牌失效） |
| 业务数据（通讯录/文档内容等） | **不落盘** | — | 仅在单次调用的内存与 tmpfs 中，调用结束即删 |
| 调用日志 | CloudWatch Logs | AWS 托管 | 默认不过期，**建议自行设置保留期** |

**业务数据不落盘**是设计上的选择：容器每次调用把凭证物化到独立 tmpfs 目录，调完即删，
企业微信返回的内容只经过内存转发给客户端，不写入任何持久化存储。

## 谁能看到

- **员工本人**：只能通过自己的令牌访问自己的凭证。跨人隔离已实测验证（两个真实员工各自凭证互不可见）。
- **AWS 账号管理员**：拥有 `secretsmanager:GetSecretValue` 与 CMK 解密权限的人**可以读取任意员工的凭证**。
  这是必须向员工说明的事实，也是应当收紧账号权限的理由。
- **MCP 客户端厂商**：业务数据会进入客户端（如 Quick Suite）的模型上下文，遵循该产品自身的数据条款。
- **实施方 / 本服务作者**：部署在贵司账号内，实施方无任何访问路径。

## 需要贵司确认的四件事

1. **数据出境评估**是否已完成、结论是否允许上述范围的数据流出。
2. **告知员工**：授权后该 MCP 客户端可以他本人身份读取其企业微信数据；凭证存放于海外。
3. **权限收敛**：谁有权读取 Secrets Manager 与解密 CMK，是否需要单独的审计与告警。
4. **日志保留期**：CloudWatch Logs 默认不过期，是否需要按贵司留存策略设置。

## 企业微信侧的前置动作

- 读取类权限（邮件 / 文档 / 会议 / 微盘 / 通讯录）**默认需要管理员逐条审批**。
  批量接入前请由企业微信管理员把本服务加入**免审名单**，否则员工授权后调用会被拒。
- **授权时须绑定一个企业微信「机器人」**：首次授权只能新建，之后可选择绑定已有的那个。
  选新建会失去对旧机器人所建对象的写权限，所以重新授权时应选绑定。详见 `docs/limitations_zh.md`。

## 许可

本项目移植自 `aws-samples/sample-lark-mcp-on-agentcore`，其许可为
**MIT No Attribution (MIT-0)** —— 最宽松的许可之一，无署名义务、无传染性。
