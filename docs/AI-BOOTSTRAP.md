# AI 从零部署与配置指南

本文供 AI 在一位新用户的电脑上安装、配置和验收 Agent Forge 使用。
目标是个人自部署，不是把开发者现有数据库、登录态和权限复制给其他人。
按顺序执行，遇到授权步骤交由用户完成；不得把“进程已启动”当作全部配置成功。
面向人工操作的完整双仓步骤见 [本机安装](INSTALL.md#full-suite)；本文补充 AI 的权限边界与验收标准。

## 1. 明确范围

开始前确认以下信息，已有答案不重复询问：

| 参数 | 含义 |
| --- | --- |
| `FORGE_ROOT` | Forge 仓库的绝对路径 |
| `AGENT_ROOT` | 可选的 Lark Agent 仓库绝对路径 |
| `WORKSPACE_ROOT` | Codex 实际工作的目录，包含用户自己的规则、技能和知识 |
| 功能范围 | 待办/本机任务、Git 同步与评审、飞书机器人，可分别启用 |
| 飞书身份 | 部署者自己的应用、审批接收人的 open_id、是否启用可信执行 |
| Git 范围 | 可选的 Gitea 地址、用户名与授权仓库 |

不要使用本文编写者的个人路径、open_id、群聊白名单或已有密钥。
不要默认授予同事完整本机权限。真实发消息、发 PR、上线部署必须另有明确授权。
安装验收不以生产部署或发送真实 PR 评论作为探针。

### 服务边界

| 服务 | 端口 | 职责 |
| --- | --- | --- |
| Forge API | 4731 | 设置、Issue/PR、Todo、宿主能力与飞书 API 代理 |
| Forge Web | 4732 | 用户控制台 |
| Codex companion | 4734 | 可选的 Codex 窗口集成，由统一 Forge 服务启动 |
| Lark Agent | 4780 | 飞书监听、Codex 会话、审批、联系人、媒体与消息投递 |

只要启用独立飞书模式，Forge 必须获得 `LARK_AGENT_URL`，不能再启动旧飞书 worker。
统一启动命令会自动发现同级 `lark-agent/data/runtime.env`；非标准目录通过
`AGENT_FORGE_RUNTIME_ENV` 指定。
只用 Forge 的 Git/Todo 功能可以不安装 Lark Agent；只用飞书不要求配置 Gitea。

## 2. 检查环境和已有实例

当前主要支持 macOS；不要把 Keychain、launchd 步骤直接照搬到 Linux/Windows。
需要 Git、Node.js **24.x**、npm；使用下文常驻方式还需要 tmux。
启用 Codex 任务需要已登录的 Codex CLI；启用飞书需要 `lark-cli`。

```bash
node --version
npm --version
git --version
command -v tmux
command -v codex
codex --version
codex login status
codex app-server --help
command -v lark-cli
lark-cli --version
```

缺少工具时，先核对该工具当前官方安装说明或本机技能，不猜 npm 包名。
Codex 未登录时由用户完成 `codex login`；不要读取、展示或复制其认证文件。
使用 nvm 时，在 Forge 根目录执行 `nvm use`，缺少版本则先 `nvm install`。
服务启动器的 PATH 也必须指向同一 Node 24，不能只在交互终端切换版本。

```bash
tmux list-sessions
lsof -nP -iTCP:4731 -sTCP:LISTEN
lsof -nP -iTCP:4732 -sTCP:LISTEN
lsof -nP -iTCP:4734 -sTCP:LISTEN
lsof -nP -iTCP:4780 -sTCP:LISTEN
```

不存在 tmux server 或无监听进程是正常的首次安装状态。
端口有占用时查明进程命令与工作目录，复用已有实例，不杀未知 Node/tmux 进程。
遵守仓库 AGENTS.md：Forge 只运行一个统一服务，已有 checkout 应复用原会话，新安装可用 `agent-forge-dev`。

## 3. 获取代码并检查版本

先由用户选择安装父目录，再执行：

```bash
git clone https://github.com/One-h/agent-forge.git
# 只有需要飞书时才克隆：
git clone https://github.com/One-h/lark-agent.git
```

上面是公开仓库的实际 HTTPS 地址。使用自己选择的其他远端时，先确认其来源和访问权限，不改成未知镜像。
若目录已存在，先检查 `git status --short`、当前分支和 remote，禁止覆盖或重置。
默认使用远端 main；如用户指定版本，记录实际 commit。
本机开发服务可能使用未合并分支，新机器 main 不一定包含相同功能：
尤其检查会话人设、随机插话白名单等入口是否存在，不能凭旧截图宣布具备。

两个仓库分别执行：

```bash
npm ci
npm run build
npm test
git rev-parse HEAD
```

必须在各自仓库根目录运行，不在工作区根目录安装依赖。
若 better-sqlite3 报 `NODE_MODULE_VERSION` 不匹配，切回 Node 24 后重新 `npm ci`；
不要对正在使用的服务随意执行 `npm rebuild` 或改动锁文件。
新安装 Forge 再执行 `npm run migrate`。Lark Agent 启动时建立并迁移自己的数据库。

## 4. 飞书前置授权（可选）

### 4.1 检查 CLI 是否安装

在准备启动 Lark Agent 的同一个用户、同一个终端环境中执行：

```bash
node --version
npm --version
command -v lark-cli
type -a lark-cli
lark-cli --version
```

判定规则：命令不存在才进入安装；已安装则记录实际版本与路径，不因新部署自动重装。
`type -a` 出现多份安装时，确认服务实际使用哪一份，不直接删除其他版本。
本项目使用 Node 24；nvm 不同 Node 版本的全局包彼此独立，切换版本后可能找不到 CLI。

### 4.2 安装与更新

当前官方推荐安装入口如下，来源为
[larksuite/cli 官方安装说明](https://github.com/larksuite/cli#installation--quick-start)。
执行前核对当前官方说明；不要误装其他同名 `lark-cli` 包或使用第三方安装镜像。

```bash
# 在 Node 24 环境安装，不改 Forge/Lark Agent 的 package.json 或锁文件。
npx @larksuite/cli@latest install
lark-cli --version
lark-cli --help
```

安装器输出需要用户确认时如实交接，不静默绕过。安装后检查 CLI 配套 AI Skills
是否可被当前 Agent 发现（例如 `lark-shared`、`lark-im`、`lark-event`），按官方安装器
提示完成；不要复制另一台机器的技能缓存或凭据。Skills 可发现与 CLI 可执行分别验收。

已有安装只检查更新，不自动改动：

```bash
lark-cli update --check --json
```

确实需要升级且用户同意后，使用 `lark-cli update` 同步更新 CLI 与 Skills。
升级前记录版本、确认没有执行中的任务，升级后重新验证命令与事件监听。
若 CLI 出现高风险确认门禁，按提示取得用户确认，不自动追加强制参数。

### 4.3 核对服务环境与命令兼容性

```bash
lark-cli config --help
lark-cli auth status --help
lark-cli event consume --help
lark-cli im --help
lark-cli contact +search-user --help
```

应能找到 `event consume`、`--as bot`、`--timeout`、`--max-events` 等运行器依赖的入口。
旧版不支持时先报告版本差异，再按上一节升级；不能把 help 失败解释成权限不足。

若终端可用、tmux/launchd 报 `command not found`：

1. 对照终端和启动脚本中的 `command -v node`、`command -v lark-cli`。
2. 在服务启动脚本里显式配置实际 Node 24/CLI 所在目录的 PATH，保留系统 PATH。
3. 从 `$AGENT_ROOT` 运行，核对同一 macOS 用户、HOME 与工作区绑定的应用。
4. 仅重启确认归属的服务，再检查监听日志。不要修改全局 PATH 来碰运气，
   也不要为解决 Keychain 访问问题自动降级到明文凭据存储。

### 4.4 配置应用与用户授权

先执行 `lark-cli config --help`、`lark-cli auth --help` 核对当前 CLI。
在 **Lark Agent 仓库目录** 检查/配置正确的应用，避免命中其他工作区绑定的机器人。
不要为已有机器人无意创建第二个应用，也不要覆盖用户已有 profile。

- 已有应用：查看 `lark-cli config init --help`，按当前版本设置 app_id。
  App Secret 使用 `--app-secret-stdin` 输入，不放到命令参数、聊天或 Git。
- 没有应用：用户明确同意后，按 CLI 的 `config init --new` 引导创建。
- 用户身份能力按需授权，例如联系人查询使用 `auth login --domain contact`；
  不默认申请 `--domain all`。用户 OAuth 与应用身份权限是两回事。
- `auth status`/`auth scopes` 用于核对状态。只报告应用与身份、缺失权限，不输出 token。
- 登录流程返回验证 URL 时交由用户打开，支持二维码的工具同时展示二维码。

在飞书应用后台确认并发布对应配置：

1. 机器人已启用、加入目标群，且应用可用范围包含部署者、审批接收人及测试对象。
2. 长连接订阅 `im.message.receive_v1`。
3. 长连接卡片回调 `card.action.trigger`，手机审批不依赖 localhost 链接。
4. 具备本次所需的接收、回复、reaction、图片/文件等权限；以当前平台提示为准。

群全量消息接收与“仅响应 @ 自己的机器人”是两个层面。前者取决于平台投递权限，
后者由运行器过滤。@ 别人不应该触发本机器人回复。
应用权限修改、版本发布和管理员授权可能需要用户介入，AI 不得声称代办成功。

### 4.5 登录和事件接收验收

```bash
lark-cli auth status --json
# 需要联网验证时再执行；只汇报脱敏后的状态。
lark-cli auth status --verify --json
lark-cli auth scopes --help
```

本地“已登录”不等于应用范围、用户 scope、卡片回调全部可用。
用户 OAuth 失败也不能直接认定 bot 身份不可用，要分别核对应用身份与用户身份。
遇到 `EOF`、网络超时先检查网络与代理，不用反复 logout/login 覆盖正常授权。

在生产监听器尚未启动、且用户同意接收测试事件时，可做一次有界探测：

```bash
lark-cli event consume im.message.receive_v1 --as bot --max-events 1 --timeout 60s
```

让部署者在这一分钟内私聊机器人，或在测试群 @ 该机器人。成功依据是实际收到
符合目标 chat_id 的事件；该命令不负责回复。超时退出码 0 **不代表收到事件**。
保留 stderr 的 ready/timeout/错误信息，不用 `--quiet` 隐藏诊断；不要保存无关群聊正文。
探测结束后才交给正式 Lark Agent 监听，避免留下一条无限 `tail -f /dev/null` 测试管道。
最终仍需第 8 节的完整回复与手机审批验收。

## 5. 配置独立 Lark Agent

### 数据目录与配置

在 Lark Agent 根目录准备 `data/`，权限建议 700。
用文件编辑工具创建 `data/lark-agent.toml`，权限 600；替换占位值后才启动：

```toml
mode = "shadow"
database = "./data/lark-agent.sqlite"
port = 4780
listen = true
approver_id = "<部署者在该应用下的 open_id>"
trusted_senders = ""
host_url = "http://127.0.0.1:4731"
```

初始不加入额外可信人。`shadow` 记录消息但不自动回答；真实问答验收前才改为 `active`。
CLI 当前只实现简单的平面 TOML 读取，不支持复杂 TOML；会移除配置值中的空白。
因此带空格的 `WORKSPACE_ROOT` 通过下面的环境变量传入，数据库相对路径相对于
**服务工作目录**，不是 TOML 所在目录。

### 服务间凭据

生成一个新的随机运行时 token（例如 32 字节随机值），只写入权限为 600 的本地文件，
不要打印到终端或放入启动命令参数。不得复用 Gitea token、飞书 App Secret 或 Codex 凭据。

| 进程 | 启动环境变量 | 值 |
| --- | --- | --- |
| Lark Agent | `LARK_AGENT_RUNTIME_TOKEN` | 新生成的运行时 token |
| Lark Agent | `LARK_AGENT_WORKSPACE_ROOT` | 用户工作区绝对路径 |
| Forge | `LARK_AGENT_TOKEN` | 与上述运行时 token 完全一致 |
| Forge | `LARK_AGENT_URL` | `http://127.0.0.1:4780` |
| Lark Agent 和 Forge | `LARK_AGENT_HOST_TOKEN` | 另一个新生成的随机宿主 token，两进程完全一致 |

建议 Lark Agent 将凭据保存在 `data/runtime.env`，内容为 shell 的 `export NAME='value'`，
用安全引用处理路径；不得覆盖已有文件。Forge 的统一启动命令会自动读取同级 Lark Agent 的
该文件，也可通过 `AGENT_FORGE_RUNTIME_ENV` 显式指定路径。
环境变量优先于 TOML：切换 active 前检查是否残留 `LARK_AGENT_MODE=shadow`。
连接 Forge 宿主工具时，`host_token`/`LARK_AGENT_HOST_TOKEN` 必须在两进程中配置为相同的随机值；只使用独立聊天、不连接宿主时才可省略。宿主工具注册和调用同样必须携带运行时 token。它们不是面向多租户或公网的控制面；保持所有服务只绑定 loopback，不暴露公网或局域网。

确认 `git check-ignore data/runtime.env data/lark-agent.toml` 命中忽略规则。
不要把含密钥的 TOML 放在仓库根目录，当前 `.gitignore` 不会忽略所有 TOML。

### 检查和启动

在 Lark Agent 根目录、加载上述启动环境后执行：

```bash
./node_modules/.bin/tsx apps/cli/src/index.ts doctor --config ./data/lark-agent.toml
./node_modules/.bin/tsx apps/cli/src/index.ts serve --config ./data/lark-agent.toml
```

`doctor` 只检查部分工具可用性、路径和模式，不验证所有授权、审批人与回复链路。
长期运行时将 source、Node 24 PATH 和 serve 命令写入 `data/start-runtime.sh`，
保证脚本从 Lark Agent 根目录运行，随后用唯一的 tmux 服务承载：

```bash
tmux new-session -d -s lark-agent-runtime -c "$AGENT_ROOT" 'exec ./data/start-runtime.sh'
curl -fsS http://127.0.0.1:4780/v1/health
```

不要在前台 serve 尚未退出时再次执行 tmux 启动。已有同名服务时先检查，不重复创建。
首次先启动 Lark Agent，再启动 Forge，确保 Forge 的宿主能力注册请求有接收端。

## 6. 启动 Forge 并完成向导

在 Forge 根目录运行 `npm run dev`。仅飞书集成需要启动器读取同级
`lark-agent/data/runtime.env`；非标准目录通过 `AGENT_FORGE_RUNTIME_ENV` 指定，
不要求把含密钥的文件复制到 Forge。常驻时创建本地启动脚本，负责 Node 24 PATH、
可选的 `AGENT_FORGE_RUNTIME_ENV` 和 `exec npm run dev`：

```bash
tmux new-session -d -s agent-forge-dev -c "$FORGE_ROOT" 'exec ./data/start-dev.sh'
curl -fsS http://127.0.0.1:4731/api/health
```

这一个服务同时拥有 4731、4732、4734，不能再单独后台启动 API/Web/companion。
也可以在构建后使用 `npm run start:local`，但不要与 dev 同时运行。

打开 `http://localhost:4732/settings`：

1. 保存 `WORKSPACE_ROOT`。它不是必须等于 Forge 或 Lark Agent 仓库路径。
2. 不使用 Git 时跳过 Gitea/token/选仓库步骤；后端完成向导只要求工作区已配置。
3. 使用 Git 时填写 Gitea 地址、用户名，将 token 存入本机钥匙串，或使用已有 tea 登录态。
   多地址按当前页面能力填写；逐一自检，不假设不同站点凭据自动通用。
4. 从本机发现并选择授权仓库，先手动同步，确认 Issue/PR 和当前评审人正确，再启用自动评审。
5. 飞书设置填写固定审批接收人的 open_id，核对与 CLI 所用应用对应。
6. 明确确认后才启用可信执行。可信发送人具备部署者本机的完整执行权限；
   不能把“填了可信 ID”当作所有权限开关都已启用。保存后回读实际运行器配置。
7. 完成环境自检，再按需开启消息回复、自动任务等功能。

飞书 Codex 模型可在“自动化 → 飞书消息 → 新建会话模型”配置。该值只在
创建新的 Codex thread 时传给 App Server；已有会话在恢复和追加 turn 时继续使用
创建时的模型。修改配置不会迁移、删除或强制重建已有会话。
“发送执行回执卡片”默认开启。关闭后仍保留本地执行审计，但未发送的回执会被
标记为已抑制，重新开启时不补发，只对后续新回执恢复投递。

设置数据保存在 SQLite；不要手工维护 `.env` 中的仓库长名单。
独立运行器地址、服务间 token 等启动参数仍需要启动环境，和数据库业务配置不是一回事。
Lark Agent 的可信人、审批人等持久设置会覆盖初始部署默认值，后续应通过设置页修改。

### 公司资料范围：必须让部署者选择

群聊隐私保护默认关闭，必须由部署者自行选择是否开启；不能在安装时自动启用。下面的公司目录仅适用于开启后的隔离模式，不会取代普通助手的工作区与执行审批。开关在设置页及群聊隐私审批页，保存于 Lark Agent 的 `groupPrivacy.enabled`。已有隐私记录在关闭后保留，不自动重跑、发送或执行。

在首次配置页向用户展示公司资料范围表单。默认空列表；用户可暂不配置，助手仍可处理本群内容及公开常识。询问用户哪些明确的公司项目/业务资料目录可以提供给当前模型服务研究，按用户给出的绝对路径配置并回读核对。不得把安装目录、Forge 工作区、个人 HOME 或维护者路径当作自动授权；不得扫描整台电脑替用户决定。可以把用户已选的工作区作为待确认候选，但必须明确它只是候选，选择更小的公司子目录更合适。用户确认范围后才保存，遇到拒绝路径不要扩大到父目录绕过校验。已有安装只展示并核对现有授权，不自动覆盖。详情见 [安装步骤 6.1](INSTALL.md#61-选择助手可研究的公司资料目录)。

## 7. 按需补齐工作区能力

- 用户工作区应有真实的 `AGENTS.md`、技能目录与知识入口，禁止复制他人的个人知识和凭据。
- PR 评审需要用户自己的仓库权限；优先复用工作区的评审技能，未安装时可使用已配置的 Git/Gitea 工具回退，不依赖维护者的私有技能脚本。
- 发布能力使用设置页中配置的本机部署适配脚本及部署者自己的认证，默认不启用。适配协议见 `docs/DEPLOYMENT-ADAPTER.md`。
  缺少这些时只能报告能力未配置，不能伪造文件或复用原部署者的线上权限。
- 联系人在设置页更新；`--has-chatted` 不是全量公司通讯录，不保证覆盖所有同事。
- 新安装贴纸库可以为空。通过表情包库上传或导入授权素材，验证文件与元数据一起存在；
  模型通过本地 `lark_stickers` MCP 按需搜索并选择素材，文字成功送达后再发送。
  旧 `<lark-sticker>` 标签仅保留兼容，不是触发检索的必需方式；不保证每次回复都发图。
- 自定义人设通过“飞书消息 → 会话 → 人设”设置。配置后替换默认风格，下一轮生效，
  不改变权限，不需要删除原 Codex 会话。若 main 尚无此入口，先报告版本差异。
- 随机插话默认关闭；启用时逐个添加授权群白名单，空名单不插话。
  设置页“自动化 → 随机插话概率”支持 0–100%，默认 8%，保存后对后续消息生效。
  这是通过白名单、消息类型和冷却过滤后的抽签概率，不是所有群消息的最终回复比例。
  “随机插话冷却”支持 0–10080 分钟，默认 10 分钟；0 表示关闭冷却。

## 8. 验收与交付

先将 Lark Agent 的 `mode` 改为 `active`，检查没有正在执行的 turn，再重启其唯一服务。
不要用无差别 kill 或清库解决问题。重启后重新核对健康状态：

```bash
curl -fsS http://127.0.0.1:4780/v1/health
curl -fsS http://127.0.0.1:4731/api/health
```

随后逐项记录“通过 / 未启用 / 待用户操作 / 失败”，而不是笼统声称全部可用：

| 检查 | 通过依据 |
| --- | --- |
| 本地服务 | 端口仅 loopback、实例唯一、Web 可打开，API 健康 |
| 事件与审批监听 | active 且 listenerRunning、approvalListenerRunning 为 true |
| 宿主注册 | 日志无注册错误，运行器能力列表包含所需 Forge 能力；仅注册不代表业务依赖齐全 |
| 私聊 | 用户发送一条测试消息，记录唯一且有实际回复；启用 reaction 时先有表情回应 |
| 群聊 | @ 本机器人有回复；只 @ 别人不自动回复；随机插话遵守开关与白名单 |
| 会话连续性 | 连续两条消息能引用上一条内容，记录正确的 thread/turn，而非无故每条新建会话 |
| 人设 | 新 turn 的实际输入使用正确 persona 版本；另行评价回复风格，不能只查数据库 |
| 媒体 | 用户明确同意后，在测试聊天发一张无敏感内容的图片或文档并验证回执 |
| 审批 | 用户许可的无害测试操作触发审批，手机点击拒绝后不执行；另一次允许后只执行授权范围 |
| Git | 仅已选择仓库成功同步；真实发起 CR 会产生外部评论，需用户单独同意 |

不要为验收让其他同事收到意外消息。不能完成真实点击或发送时明确列为未验收。
结束时交付：两个仓库 commit、服务名/URL、数据与配置路径（无密钥）、启用功能、
逐项验收结果、未完成授权和重启方式。

## 9. 常见失败

| 现象 | 优先检查 |
| --- | --- |
| 页面无数据/飞书未监听 | Forge 的 LARK_AGENT_URL、4780 健康、token 是否一致、是否仍为 shadow |
| HTTP 401 | runtime_token 与 LARK_AGENT_TOKEN 是否一致；不要误当成 Codex 登录失败 |
| Bot has NO availability / 230013 | 应用可用范围、版本是否已发布、目标人是否对该机器人可用 |
| 群聊没有消息 | 应用事件权限、机器人是否在群、实际投递；不是先取消 @ 过滤 |
| 审批无卡片/点击无响应 | 固定审批人、应用可用范围、card.action.trigger 回调和监听状态 |
| invalid cwd / EPERM | 服务进程访问工作区的 macOS 权限、启动来源和 PATH；不靠 chmod 777 绕过 |
| Codex 401 | 在服务相同用户/环境检查登录状态，保存诊断后处理认证；不删会话数据库 |
| 配置了技能仍不能用 | workspace_root 是否指向技能所在目录、实际文件与工具是否存在 |
| 元数据有表情包但图片缺失 | 是否只迁移 SQLite 而没迁移 stickers 文件目录 |
| 重启后像丢数据 | 数据库绝对路径和启动 cwd 是否变化；先定位旧文件，不新建或覆盖恢复 |

## 10. 数据与升级边界

Forge 默认数据库是 `apps/api/data/autofix.sqlite`，任务在 `data/tasks/`。
按本文配置的 Lark Agent 数据库是 `data/lark-agent.sqlite`，素材在 `data/stickers/`，
会话产物在 `data/tasks/`。两套数据库不互相替代。

设置页导出不等于完整灾备，不能假设包含独立运行器数据库、媒体、登录态或 Codex 历史。
完整备份需先停止对应服务或使用 SQLite 一致性备份，并包含所需素材/附件文件；
禁止只拷贝活跃 WAL 数据库的主文件。新用户部署不导入原用户的生产数据。

首次验收通过前不安装登录自启。后续使用 Forge 的 launchd 功能时，需核对服务环境
是否保留 LARK_AGENT_URL/TOKEN，并单独管理 Lark Agent 生命周期，不能假设一键托管两者。

相关入口：[安装](INSTALL.md)、[排障](TROUBLESHOOTING.md)、[卸载](UNINSTALL.md)、
[飞书迁移职责](lark-agent-migration-guide.md)。若文档与代码冲突，以当前 checkout 的
`apps/api/src/config.ts`、Lark Agent 的 `apps/cli/src/index.ts` 和 `apps/runtime/src/index.ts`
为依据修正文档，不能绕过失败继续执行。
