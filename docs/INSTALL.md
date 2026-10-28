# 本机安装

Agent Forge 和 [Lark Agent](https://github.com/One-h/lark-agent) 是两个独立仓库，
不是一个仓库中的两个 npm 包。每个人使用自己的工作区、数据库和账号，不需要中心服务器。

| 安装范围 | 所需项目 | 提供的功能 |
| --- | --- | --- |
| 仅控制台 | Agent Forge | Todo、可选 Git/Gitea 同步、Issue/PR 与 Codex Job |
| 仅飞书机器人 | Lark Agent | 飞书问答、Codex 会话、审批、媒体与消息投递；见其 README |
| 完整套件 | 两个仓库 | 上述功能，加网页管理飞书设置/会话、机器人调用 Forge 宿主能力 |

Forge 的 `npm run dev` 只启动 API/Web/companion，**不会安装或启动 Lark Agent**。
启用两仓集成后，飞书功能由独立 Lark Agent 承担，Forge 不再启动旧飞书监听器。
两个进程通过 loopback HTTP 和共享 token 连接，各自保留 SQLite 数据，不共用数据库文件。

## 前置条件

- 当前主要支持 macOS；需要 Git、Node.js **24.x** 和 npm。Forge 可用 `nvm install` / `nvm use` 安装并切换版本。
- 使用 Codex 任务需要支持 `codex app-server` 的 Codex CLI，且 `codex login status` 显示已登录。
- 飞书功能需要安装并配置 `lark-cli`、用户自己的飞书应用和机器人。
  安装、登录及权限步骤见 [CLI 与飞书授权](AI-BOOTSTRAP.md#4-飞书前置授权可选)，按当前官方说明操作。
- tmux 用于后台常驻；下面的双终端前台启动不要求 tmux。如需 Git 功能，另准备 tea 登录态或 Gitea token。
- 先检查 4731、4732、4734、4780 的占用；已有安装应复用，不能重复启动或杀掉未知进程。

## 仅安装控制台

在自己选择的父目录执行，已有目录时先检查而不是覆盖：

```bash
git clone https://github.com/One-h/agent-forge.git
cd agent-forge
nvm use
npm ci
npm run migrate
npm run dev
```

打开 `http://localhost:4732/settings` 保存工作区路径。不使用 Git 时跳过 Gitea/token/选仓库。
需要 Git 时再填写地址、用户名、凭据并选仓库。凭据保存在本机 Keychain，不需要 `.env`。
如安装父目录中已有配置好的 Lark Agent，Forge 会自动连接它；纯控制台安装不要沿用他人的启动配置。

<a id="full-suite"></a>

## 完整套件安装

以下是**全新安装**流程；只在空闲、未占用的本机环境执行。已有安装先备份并确认配置和数据路径，
不要重复执行配置生成、覆盖文件、清库或复制别人的数据库。AI 代装还需遵守 [完整 AI 安装规范](AI-BOOTSTRAP.md)。

### 1. 获取两个仓库并安装依赖

将两个仓库放在同一个父目录，例如：

```text
your-tools/
  agent-forge/
  lark-agent/
```

```bash
git clone https://github.com/One-h/agent-forge.git
git clone https://github.com/One-h/lark-agent.git
cd agent-forge
nvm use
npm ci
npm run migrate
cd ../lark-agent
# 本终端继续使用 Node 24；新终端也需切换到该版本。
npm ci
npm run build
```

### 2. 配置自己的飞书应用

在 `lark-agent` 目录核对 CLI 所用的应用和用户身份；登录、App Secret 输入由用户完成，
不要把密钥放到聊天、命令参数或 Git 中。按 [飞书授权步骤](AI-BOOTSTRAP.md#4-飞书前置授权可选) 确认：

- 机器人已启用，应用可用范围覆盖部署者、审批接收人与测试对象，机器人已加入测试群。
- 事件使用长连接，订阅 `im.message.receive_v1`。
- 卡片回调使用长连接，订阅 `card.action.trigger`，以支持手机直接审批。
- 接收/发送消息、reaction、图片/文件等所需权限已获批并发布；不是只在未发布版本中勾选。
- 已取得**该应用下**部署者的 `open_id`，用作固定审批接收人。最初不额外添加可信发送人。

### 3. 生成本地配置和共享凭据

仍在 `lark-agent` 根目录执行。先将下面两个示例值换成自己的真实值：

```bash
export WORKSPACE_ROOT="/absolute/path/to/your/workspace"
export LARK_APPROVER_ID="ou_your_open_id"
```

工作区是 Codex 实际工作的目录，不一定是这两个仓库之一。应包含自己的 `AGENTS.md`、技能与知识。
下面命令生成两个不同的 32 字节随机 token，仅写入权限为 600 的本地文件，不打印值；
发现配置已存在就退出，不覆盖。token 不是飞书 App Secret，也不是 Gitea/Codex 登录凭据。

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const workspace = process.env.WORKSPACE_ROOT;
const approver = process.env.LARK_APPROVER_ID;
if (!workspace || !path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) {
  throw new Error('WORKSPACE_ROOT must be an existing absolute directory');
}
if (!approver || approver === 'ou_your_open_id' || !/^ou_[A-Za-z0-9]+$/.test(approver)) {
  throw new Error('Set your own application-scoped LARK_APPROVER_ID first');
}
for (const file of ['data/runtime.env', 'data/lark-agent.toml']) {
  if (fs.existsSync(file)) throw new Error(`Existing configuration: ${file}; do not overwrite it`);
}
fs.mkdirSync('data', { recursive: true, mode: 0o700 });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const values = {
  LARK_AGENT_WORKSPACE_ROOT: workspace,
  LARK_AGENT_APPROVER_ID: approver,
  LARK_AGENT_RUNTIME_TOKEN: randomBytes(32).toString('hex'),
  LARK_AGENT_HOST_TOKEN: randomBytes(32).toString('hex')
};
fs.writeFileSync('data/runtime.env', Object.entries(values).map(([key, value]) =>
  `export ${key}=${quote(value)}\n`).join(''), { flag: 'wx', mode: 0o600 });
fs.writeFileSync('data/lark-agent.toml', [
  'mode = "shadow"',
  'database = "./data/lark-agent.sqlite"',
  'port = 4780',
  'listen = true',
  'trusted_senders = ""',
  'host_url = "http://127.0.0.1:4731"',
  ''
].join('\n'), { flag: 'wx', mode: 0o600 });
console.log('Created protected local configuration; no token values printed.');
NODE
git check-ignore data/runtime.env data/lark-agent.toml
```

`runtime.env` 是仅供自己加载的本地 shell 配置，不要提交、上传或分享。工作区及审批人通过环境变量传入，
避免简单 TOML 读取器移除路径中的空白。数据库相对路径以**启动工作目录**为基准；升级时保持同一路径。

两进程使用同一运行时 token：Agent 的 `LARK_AGENT_RUNTIME_TOKEN` 对应 Forge 的 `LARK_AGENT_TOKEN`。
宿主回调使用另一个 token：两边的 `LARK_AGENT_HOST_TOKEN` 相同。下文 Forge 启动器会自动完成读取和映射。

### 4. 终端 A：先启动 Lark Agent

```bash
# 从 lark-agent 根目录执行，使用 Node 24。
source ./data/runtime.env
./node_modules/.bin/tsx apps/cli/src/index.ts doctor --config ./data/lark-agent.toml
./node_modules/.bin/tsx apps/cli/src/index.ts serve --config ./data/lark-agent.toml
```

保持此终端运行。`doctor` 不验证完整飞书权限；必须检查其输出中的工具、工作区和数据库路径。
首次使用 `shadow`，只记录消息，不自动回复或执行宿主能力；健康不代表机器人已激活。

### 5. 终端 B：再启动 Forge

```bash
cd /absolute/path/to/your-tools/agent-forge
nvm use
npm run dev
```

将示例路径替换为第 1 步的实际目录。Forge 自动读取同级 `lark-agent/data/runtime.env`，
连接 `http://127.0.0.1:4780`。非同级安装时，启动前设置：

```bash
export AGENT_FORGE_RUNTIME_ENV="/absolute/path/to/lark-agent/data/runtime.env"
```

显式设置的 `LARK_AGENT_URL`、`LARK_AGENT_TOKEN` 和 `LARK_AGENT_HOST_TOKEN` 优先，
因此升级时要检查是否残留旧值。出现注册失败时检查 Agent 是否先启动、两个 token 是否对应；
修正后重启空闲的 Forge，不能把 API 健康当作宿主注册成功。

### 6. 完成向导并激活

打开 `http://localhost:4732/settings`：

1. 保存自己的工作区，未使用 Git 时跳过 Git 配置；使用时再配置 Gitea 并手动同步验证。
2. 核对固定审批人、飞书监听与回复开关、会话模型。可信执行最初保持关闭，需明确知晓其完整本机权限后才启用。
3. 在终端 A 按 Ctrl+C 停止自己的 shadow 进程，将 `data/lark-agent.toml` 的 `mode` 改为 `"active"`。
4. 确认启动环境中没有覆盖它的 `LARK_AGENT_MODE=shadow`，然后在同一目录重新执行第 4 步的 source/serve 命令。
5. 后续通过设置页修改持久配置；数据库中已保存的配置可能优先于初始环境默认值。

### 6.1 选择助手可研究的公司资料目录

群聊隐私保护是可选模式，默认关闭。可在设置页或群聊隐私审批页开启；开启后，群聊回复和操作先由你审核，隔离助手只使用本群内容及单独授权的公司资料。关闭时使用普通助手的工作区、可信人和执行审批规则。

首次配置的“基础配置”和后续设置页均提供隐私模式的公司资料范围配置，隐私审批页也可修改。**Forge 工作区路径与隐私模式的资料授权是两项独立配置**；选择公司目录不会自动开启隐私保护，也不会调整普通助手权限。

- 默认目录列表为空，可以暂时跳过；开启隐私保护且目录为空时，隔离助手只能使用本群内容和公开常识，不能读取本机公司资料。
- 用户选择明确的公司项目/业务资料文件夹，填写绝对路径（每行一个）。macOS 可在 Finder 选中文件夹后按 ⌥⌘C 复制路径。
- “填入当前工作区作为候选”只填表单，不保存或授权。用户应检查或改成更小的公司子目录，勾选确认后再保存。不要选择整个磁盘、个人主目录或包含个人资料的混合目录。
- 保存时由 Lark Agent 验证目录真实存在且不通过符号链接扩大范围；个人、凭据和会话文件仍受过滤。研究内容会提供给当前模型服务，不能仅因目录用于工作就假定其中全部内容都适合提供给模型。
- 范围只存本机 Lark Agent SQLite，不写 Git、不复制安装者目录，也不从 Forge 配置备份自动授予另一台电脑。迁移后重新选择；已有运行器的授权会继续显示，不自动覆盖。
- 随时可修改列表；清空并保存即撤销全部目录授权。未连接 Lark Agent 时提示先连接，不会退回使用整个工作区。

公司资料研究结果发群和执行操作仍需单独审批。选择目录不是自动发送、执行或访问个人资料的授权。

### 7. 验收整套功能

在第三个终端检查（不会发送消息或执行部署）：

```bash
curl -fsS http://127.0.0.1:4780/v1/health
curl -fsS http://127.0.0.1:4731/api/health
```

- Agent 应为 `mode=active`，`listenerRunning` 和 `approvalListenerRunning` 为 true；日志没有宿主能力注册错误。
- 网页可打开并加载飞书会话/设置；控制台端口为 4731/4732/4734，Agent 为 4780，均只监听 loopback。
- 部署者私聊机器人一条无敏感测试消息，确认收到回复；在测试群 @ 本机器人有回复，只 @ 别人不触发回复。
- 连续两条消息核对会话上下文；用获准的无害操作验证手机审批拒绝/允许路径。仅收到 reaction 不是任务完成证明。
- 如启用 Git，再验收授权仓库同步；不要为安装验收默认发真实 PR 评论或执行生产部署。

### 8. 按需启用功能与常驻

- 表情包素材库初始可以为空：通过网页表情包库导入自己的授权素材，再配置使用策略。MCP 按需搜索/选择，文字成功投递后才发选中的表情；不要求手写旧标签，也不保证每次都有合适素材。
- 群随机插话、额外可信人、自动审批等初始保持关闭；需要时逐项配置开关及群白名单。
- PR/Issue 需要自己的仓库权限；工作区评审技能可选，缺少时可使用已配置的 Git/Gitea 工具回退。
- 部署不是安装后自带的业务能力：另配置 [本机部署适配器](DEPLOYMENT-ADAPTER.md) 和自己的凭据。两个仓库不附带其他用户的公司知识、数据或生产权限。
- 前台验收通过后再使用 tmux/launchd；见 [AI 指南的启动与常驻步骤](AI-BOOTSTRAP.md#5-配置独立-lark-agent) 及其第 6、10 节。
  Forge 的登录自启不等于托管 Agent；两者生命周期需分别管理。只运行一个 Forge 组合服务、一个 Agent 实例。

## 本机数据与凭据

- Forge SQLite：`apps/api/data/autofix.sqlite`；任务产物：`data/tasks/`。
- 按本文配置的 Agent SQLite：`lark-agent/data/lark-agent.sqlite`；素材和任务位于该仓库 `data/` 下。
- Gitea token：macOS Keychain 兼容存储条目 `autofix-console / gitea-token`；飞书登录态由 `lark-cli` 管理。
- 设置页备份不等于完整灾备，不包含凭据、独立 Agent 数据库、全部媒体与 Codex 历史。
- 升级禁止删除/覆盖数据库及 WAL 文件；备份应停止对应服务或使用 SQLite 一致性备份，不只复制活跃主文件。
- 旧版本首次启动可导入 `.env` 中的非敏感配置一次；核对实际生效设置后再处理旧文件。

后续参考：[排障](TROUBLESHOOTING.md)、[卸载](UNINSTALL.md)、[双远端同步](REPOSITORY-SYNC.md)、
[AI 从零配置与验收](AI-BOOTSTRAP.md)。
