# 本机安装

Agent Forge 面向个人电脑使用。每个用户在自己的工作区中运行一份服务，不需要共享数据库或中心服务器。

## 前置条件

- macOS，已安装 Node.js、支持 `codex app-server` 的 Codex CLI、Git 和 tmux。
- 如需同步仓库，安装并登录 `tea`，或准备 Gitea 地址和个人 token。
- 如需飞书能力，安装并登录 `lark-cli`。

## 安装与启动

将下面的仓库 URL 占位符替换为维护者提供的地址。双远端维护方式见 [仓库同步](REPOSITORY-SYNC.md)。

```bash
git clone https://github.com/One-h/agent-forge.git
cd agent-forge
npm install
npm run migrate
npm run dev
```

默认只监听 `127.0.0.1:4731`，网页在 `http://localhost:4732`。无需创建或编辑 `.env`。
如果同级目录存在 `lark-agent/data/runtime.env`，统一启动命令会自动读取其中的运行时 token，
并连接 `http://127.0.0.1:4780`。Lark Agent 位于其他目录时，可通过
`AGENT_FORGE_RUNTIME_ENV` 指向它的 `runtime.env`；显式设置的 `LARK_AGENT_URL` 和
`LARK_AGENT_TOKEN` 始终优先。

## 首次配置

1. 打开设置页的四步“首次配置”。
2. 保存工作区绝对路径、Gitea 地址、用户名、执行审批接收人和可选的额外可信飞书 ID。
3. 保存 Gitea token 到 macOS 钥匙串，或确认已有 tea 登录态可用。
4. 选择本机发现的仓库，完成环境检查后结束引导。
5. 按需开启自动 PR 评审、Issue 修复、飞书监听与 Codex 回复。
6. 设置页主动开启高权限执行后，执行审批接收人的 `open_id` 默认获得完整本机权限；可额外配置可信飞书 ID。可信发送人可使用部署者本机已有的文件、Git/Gitea、网络、技能和凭据能力，其他发送人仍以只读方式执行，并在需要受限操作时请求审批。
7. 如需登录后自动运行，在设置页“常驻启动”安装 launchd 服务。安装会构建 API、Web 和 Codex companion；如果开发服务正在占用 4731、4732 或 4734，会先登记服务。停止开发服务后点击“重启”，或在下次登录时启动。companion 默认附着已有的专用 Codex 窗口，不会自动弹出新窗口。

## 本机数据与凭据

- SQLite 默认位置：`apps/api/data/autofix.sqlite`。
- 任务产物默认位置：`data/tasks/`。
- Gitea token：macOS Keychain 中当前兼容存储条目 `autofix-console / gitea-token`。
- 飞书登录态由 `lark-cli` 自己管理；Agent Forge 不复制或导出它。
- 设置页“本地数据”可查看数据库、任务产物、飞书附件与常驻日志占用，并只清理指定保留期以前的已结束任务产物或日志。
- 设置页“备份与迁移”可导出或导入配置、仓库选择、待办和审计记录。备份不包含 token、飞书登录态、任务产物或同步的 Issue/PR 内容。

首次同步前，设置页的 Gitea 自检会验证 token 能读取当前用户。它是只读检查，不能替代对每个仓库实际权限的确认。

旧版本升级时，首次启动会将 `.env` 中的工作区、Gitea 地址、用户名、可信飞书 ID 和仓库列表导入 SQLite 一次；token 不会被导入。确认设置页内容正确后，可自行删除旧 `.env`。
