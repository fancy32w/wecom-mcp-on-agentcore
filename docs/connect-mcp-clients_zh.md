# 企业微信 MCP 接入说明

用 AI 助手直接操作你的企业微信：查日程、搜文档、找同事、建日程/文档、发消息。

> **管理员发放本文档前**：把下面所有 `<MCP_ENDPOINT>` 替换成你部署后拿到的实际端点
> （`bash scripts/run-deploy.sh` 结束时会打印，形如 `https://xxxxx.cloudfront.net`）。
> **不要**沿用示例或别人的端点 —— 那会让员工的企业微信凭证存进别人的 AWS 账号。

**MCP 端点**

```
<MCP_ENDPOINT>/mcp
```

---

## 按你的客户端选一种

### Kiro / Claude Code / Codex — 填个地址就行

1. 在客户端里添加 MCP server，类型选 **remote / http**，URL 填上面那个端点
2. 保存后客户端会自动弹出浏览器
3. **用企业微信扫码**，完成

<details>
<summary>为什么不用配密钥</summary>

这些客户端支持 OAuth 动态注册（DCR），会自己去 `/register` 注册、自己走授权流程。
你只需要在浏览器里扫一次码。令牌 30 天有效，到期后客户端会自动再走一次。
</details>

### Amazon Quick（云端与 Desktop）— 两条路径，选一条

Quick 云端和 Quick Desktop 是同一个 Quick 账号。**管理员在云端建好的连接器会自动出现在 Desktop 里**，
所以多数情况下你什么都不用配。

#### 路径 A：管理员在云端建一次，全员共用（推荐）

由管理员在 Quick console 操作一次：

**Connectors** → **Create for your team** → **Model Context Protocol (MCP)**

| 字段 | 填什么 |
|---|---|
| Name | `企业微信` |
| MCP server endpoint | `<MCP_ENDPOINT>/mcp` |
| Connection type | **Public network** |
| 认证方式 | **User authentication**（OAuth） |
| Client ID / Secret | **留空** —— 本服务支持 DCR，Quick 会自动注册 |

建好后共享给使用者。使用者这边**不需要任何配置**：在云端或 Desktop 里第一次用到企业微信工具时，
Quick 会弹出授权页，**用企业微信扫码**即可。令牌到期客户端自动续，不用重新扫。

> 需要 Quick Suite **Enterprise** 订阅。

#### 路径 B：自己在 Desktop 里加，自助取令牌

管理员没建、或你只想给自己用时走这条。

1. 浏览器打开 **<<MCP_ENDPOINT>/authorize/self>**
2. 点页面上的绿色按钮，**用企业微信扫码**
3. 页面会显示一行 `Bearer eyJ...`，复制它
4. Quick Desktop → Settings → **Capabilities** → **Connectors** → `+ Create` → **MCP server** → **Remote**

   | 字段 | 填什么 |
   |---|---|
   | Name | `企业微信` |
   | URL | `<MCP_ENDPOINT>/mcp` |
   | Token | 粘贴第 3 步复制的令牌 |
   | Timeout | `60` |

5. 应显示加载了 37 个工具

> ⚠️ **只在你自己打开的页面上扫码。** 别人发给你的二维码不要扫 —— 扫了对方就能拿到以你身份操作企业微信的令牌。

<details>
<summary>两条路径差在哪，为什么 B 要手动取令牌</summary>

差别只在**谁来建这个连接器**：

- 路径 A 由管理员在 Quick console 建的是**账号级 MCP 集成**，支持完整 OAuth（含 DCR 自注册），
  所以能自己弹浏览器、自己续期。它对整个 Quick 账号生效，Desktop 也能看到。
- 路径 B 用的是 Desktop 自己的 **MCP Servers → Remote** 表单。按 AWS 官方文档，这个表单只有
  `Name / URL / Token / Description / Timeout` 五个字段，**没有 OAuth 流程** —— 它不会弹浏览器，
  只能发一个固定的 Bearer token。所以必须你手动取一次。

`Token` 字段和在 Headers 里加一个 `Authorization` 是等效的，本服务两种都接受。

**关于「云端建的会自动同步到 Desktop」**：AWS 官方文档在 Web Connectors 一节明确写了
「Connectors added on the web appear automatically in the desktop application」，
并在 Desktop FAQ 里写了 Spaces / dashboards / settings 会从 web 带过来；
但**没有针对 MCP 集成单独写这句话**。实际同步行为已在真实环境观察到，
如果你的 Desktop 里没看到，刷新一下连接器列表，或确认管理员是否已把集成共享给你。

</details>

<details>
<summary>页面关掉了没复制到令牌怎么办</summary>

**不要重新扫码。** 找管理员用 `scripts/mint-token.js` 补发一个。

重新扫码要重走一遍授权，就多了一次选错机器人的机会 —— 如果在企业微信的选择页上选了
「新建机器人」而不是绑定原有的那个，你会**永久失去**对旧机器人建过的文档、表格、日程的修改权。
补发令牌不碰授权流程，没有这个风险。
</details>

<details>
<summary>万一 Quick 没能自动注册（DCR 失败）</summary>

正常情况下路径 A 的凭证字段留空即可 —— 本服务支持 DCR，Quick 会自己去 `/register` 注册。
如果 Quick 报注册失败，可以退回共享密钥模式，由管理员取出密钥手工填：

```bash
aws ssm get-parameter --name /wecom-mcp-on-agentcore/oauth-client-secret \
  --with-decryption --region <区域> --query Parameter.Value --output text
```

| 字段 | 值 |
|---|---|
| Client Secret | 上面命令取出的值 |
| Authorization URL | `<MCP_ENDPOINT>/authorize` |
| Token URL | `<MCP_ENDPOINT>/token` |

这个密钥是全账号共享的，**不要发给普通使用者**。

</details>

---

## 能做什么

| 类型 | 例子 |
|---|---|
| 查 | 「我今天有什么会」「搜一下提到 XX 的文档」「谭上的 userid 是什么」「最近的邮件」 |
| 建 | 「明天下午三点约个评审会，邀请研发组」「建个智能文档记录这次讨论」「加个待办」 |
| 发 | 「给测试群发条消息」「把这段发给谭上」 |
| 读表 | 「读一下那张智能表格的数据」「按 SQL 查一下仪表盘」 |

## 做不到什么（先看这个，能省你半小时）

| 场景 | 结果 | 原因 |
|---|---|---|
| **改你自己以前建的文档 / 表格** | ❌ 失败 | AI 用的是机器人身份，只能改机器人自己建的东西 |
| 上传本地文件到微盘 / 导入 xlsx | ❌ 失败 | AI 拿不到你电脑上的文件 |
| 智能表格写入（企业可见范围 > 10 人） | ❌ 报 `851003` | 企业微信对 CLI 写接口的规模限制 |
| 让机器人主动给某人发消息 | ❌ 报 `853008` | 对方需要先跟这个机器人说过一句话 |
| 让 AI 定时/无人值守地推送 | ❌ | 不支持事件订阅与主动推送 |
| 往 7 天内没人说话的群发消息 | ❌ 群搜不到 | 群要有近期活跃记录才可见；先在群里发一句即可 |

<details>
<summary>「发消息」到底是以谁的身份发出的</summary>

默认是**以你本人身份**发送，对方看到的发送者是你。
如果要以机器人身份发（对方看到机器人头像），需要明确说「用机器人身份发」，
但受上面 `853008` 的限制。
</details>

<details>
<summary>为什么"新建可以、修改不行"</summary>

企业微信的权限模型是**读写非对称**的：读取按你本人的权限收敛（你看不到的 AI 也看不到），
但写入只认「机器人是不是这个对象的所有者」。所以 AI 新建的东西它能继续改，
你以前建的东西它只能读。
</details>

---

## 常见问题

**第一次调用报"未授权"** — 正常。按上面你那类客户端的步骤扫一次码即可。

**令牌多久过期** — 30 天。走 OAuth 的客户端（Kiro / Claude Code / Codex，以及路径 A 的 Quick）
**会自动续期，你什么都不用做**。只有路径 B（在 Desktop 里手填 Token）需要到期后重新走一次
`/authorize/self`：那时企业微信会再问一次机器人 —— **选「绑定已有机器人」并选中原来那个**，
就不会多出机器人、也不会丢写权限。

**换电脑了** — 令牌可以复制过去用，不用重新扫码。

**查文档 / 邮件时提示需要审批** — 企业微信要求管理员批准这类读取权限。找管理员把你加进免审名单。

**AI 说找不到某个群** — 那个群 7 天内没有消息。你在群里随便发一句，再让 AI 试。

**响应比较慢** — 首次调用约 5-7 秒（跨境 + 容器冷启动），之后 2-3 秒。

---

## 管理员部分

**取 OAuth client secret**（给 Quick 云端用）

```bash
aws ssm get-parameter --name /wecom-mcp-on-agentcore/oauth-client-secret \
  --with-decryption --query Parameter.Value --output text --region us-east-1
```

**补发令牌**（用户没复制到、又不该让他重扫时）

```bash
cd <项目根>
NODE_PATH=lambda/node_modules node scripts/mint-token.js --list
NODE_PATH=lambda/node_modules node scripts/mint-token.js --user u_xxx --out /tmp/t.tok
```

**企业微信侧要做的事**

- 管理后台 → 安全与管理 → 管理工具 → 智能机器人 → 管理 → 把使用者加进
  「获取数据访问权限无需审批」名单（否则查邮件/文档/会议/微盘/通讯录会卡在审批）
- 预期每个使用者名下**一个**智能机器人（叫「某某的机器人」）。10 人用就是 10 个。
  如果某人名下多于一个，说明他重新授权时选了「新建机器人」而不是绑定原有的 ——
  旧机器人建过的东西他已经改不了了。

**订阅告警**（凭证回写失败等）

```bash
aws sns list-topics --region us-east-1 \
  --query 'Topics[?contains(TopicArn,`WecomMcp`)].TopicArn' --output text
aws sns subscribe --topic-arn <上一步的 ARN> --protocol email \
  --notification-endpoint you@example.com --region us-east-1
```

**撤销某个用户**

```bash
aws secretsmanager delete-secret \
  --secret-id wecom-mcp-on-agentcore/users/u_xxx \
  --recovery-window-in-days 7 --region us-east-1
```

删除凭证后该用户下次调用会被要求重新授权。**告诉他授权时选「绑定已有机器人」** ——
选新建会失去对旧产物的写权限。不要把删除当成"重置"手段。

---

技术细节、设计取舍与全部实测记录见 `docs/改造评估.md`。
