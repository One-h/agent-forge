# Lark Agent 迁移指南

## Agent 契约

任何 Agent 在 Agent Forge 中修改飞书会话相关行为前，必须先阅读本指南。

```yaml
职责归属:
  运行时: lark-agent
  Forge: 宿主能力与控制台代理
Forge 中禁止:
  - 启动飞书事件监听器
  - 持久化新的飞书会话状态
  - 为飞书消息启动 Codex turn
  - 发送飞书回复或审批卡片
修改 Forge 时必须:
  - 保持 LARK_AGENT_URL 已配置
  - 只注册结构化宿主能力
  - 返回经过验证的能力结果
  - 让外部写操作经过 Lark Agent 审批
```

## 运行时边界

`lark-agent` 拥有以下持久化资源与运行职责：

- 飞书事件监听：`im.message.receive_v1`、`card.action.trigger`
- SQLite 状态：会话、消息、审批、出站队列、联系人、贴纸、附件和执行事件
- Codex App Server 的 thread、turn、Dynamic Tools、心跳与恢复
- 文本与媒体投递、执行审批卡片以及向请求人的结果通知

Lark Agent 的正式代码边界：

```text
packages/conversation-runtime       会话、上下文、worker、审批和 Codex turn 编排
packages/adapter-lark-cli           飞书事件解析、回复、媒体、reaction 和卡片
packages/adapter-codex-app-server   唯一的 App Server Client
packages/adapter-sqlite             权威 lark_* 数据表与迁移
apps/runtime                        HTTP API 和模块装配
```

不得重新创建 `forge-migration`、第二套 App Server adapter 或独立 MCP 消息运行链路。

Agent Forge 只拥有业务工作流，通过下列接口暴露：

```text
POST /api/lark-agent/capabilities/:id
```

当前私有能力：

```text
forge.gitea.review-pr
forge.gitea.triage-issue
forge.todo.create
forge.deploy.inspect
forge.deploy.production
```

`forge.deploy.production` 属于外部写操作。它必须使用
`forge.deploy.inspect` 返回的精确 `expectedRevision`；Lark Agent 审批通过后，
Forge 才能执行部署辅助脚本。

## 配置与启动

Forge 启动时必须配置独立运行时地址：

```bash
LARK_AGENT_URL=http://127.0.0.1:4780 npm run dev
```

Lark Agent 使用自己的 TOML 配置启动：

```bash
npx tsx apps/cli/src/index.ts serve --config ./lark-agent.toml
```

不得将密钥提交到仓库。`host_token`、`runtime_token` 应只存在于部署者的本地
TOML 文件或进程环境变量中。

配置 `LARK_AGENT_URL` 后，Forge 不得启动旧飞书 worker 或旧 Codex responder；
设置页与控制台 API 只代理 Lark Agent 的状态。

## Codex 与宿主能力

Lark Agent 使用同一个 Codex App Server 进程，并按 `chat_id + trust_scope` 复用
thread。新消息到来时：

1. 当前 thread 没有运行中的 turn：启动新 turn。
2. 当前 thread 正在运行：通过 `turn/steer` 追加增量消息，不重复注入完整会话说明。
3. App Server 通过 `dynamicTools` 暴露 Lark Agent 当前已注册的能力。
4. `item/tool/call` 回调携带 `threadId` 和 `turnId`，Lark Agent 据此定位当前
   飞书消息，再校验 `chat_id`、发送人和信任范围。
5. Lark Agent 完成审批后调用 Forge 的本地 HTTP 能力接口，并将结构化结果
   返回给同一个 Codex turn。

写能力应在返回对象中附带 `_receipt`：

```json
{
  "status": "verified",
  "summary": "动作与后置验证结果",
  "evidence": ["revision: ...", "health: healthy"]
}
```

`executed` 只表示动作已执行，`verified` 表示宿主完成了后置验证，`queried`
表示只读取状态。Lark Agent 会隐藏 `_receipt` 不让其干扰模型回答，并独立发送
执行回执卡。

能力名称在 App Server 中会把点号转成双下划线，例如
`forge.todo.create` 显示为 `forge__todo__create`；调用宿主时仍使用原始能力 ID。
不得在提示词中伪造能力结果，也不得用 shell 绕过能力审批。

## 数据与界面映射

| 控制台功能 | 唯一权威服务 |
| --- | --- |
| 飞书消息与详情 | Lark Agent `/v1/messages` |
| 执行记录 | Lark Agent 的消息事件和附件 |
| 审批记录 | Lark Agent `/v1/approvals` |
| 联系人与同步 | Lark Agent `/v1/contacts` |
| 贴纸库与媒体 | Lark Agent `/v1/stickers` |
| 飞书助手提示词 | Lark Agent `/v1/prompts` |
| PR、Issue、Todo、部署等业务动作 | Forge 宿主能力接口 |

Forge 可以将数据转换为既有前端 DTO，但不得再写入第二份飞书会话状态。
消息搜索、发送人/群聊筛选统计和历史详情也必须由 Lark Agent 的 SQLite 查询，
不得只拉最近一页后在 Forge 内存中筛选。

文本回复使用消息行中的持久投递字段；图片、文件和贴纸使用
`lark_delivery_outbox`。两者都必须使用幂等键并按退避时间重试，投递记录通过
消息详情接口返回给控制台。

## 宿主能力调用规则

1. 每个能力必须声明收窄的 JSON 输入 Schema 与风险等级。
2. 只读能力可以直接执行。
3. 本地写操作服从 Lark Agent 的可信人策略。
4. 外部写操作必须等待审批结果。
5. 返回结构化证据。不能仅因命令已尝试执行，就宣称部署、评审或写入成功。

## 验收清单

每次迁移或运行时改动后执行：

```bash
curl http://127.0.0.1:4780/v1/health
curl http://127.0.0.1:4731/api/settings
```

预期结果：

- Lark Agent 返回 `mode: active`，消息监听和审批监听均为运行中。
- Forge 将 `Lark Agent Runtime` 显示为监听来源。
- Forge 的旧监听器未运行。
- 一条 P2P 验收消息只收到一次回复，且只产生一条消息记录。
- 例如 `forge.todo.create` 的宿主能力验收，只创建一条 Forge Todo，并将验证后的结果回复到飞书。
- 外部写能力验收只生成一张审批卡，在审批前不得执行实际操作。

## 旧代码规则

不得重新启用提取前的 Forge 飞书 worker/responder。旧文件只用于未迁移部署的
兼容与迁移参考。所有新飞书行为必须放入 `lark-agent`；所有新的 Forge 业务行为
必须放在已注册的宿主能力之后。
