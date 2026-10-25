# 卸载

先在设置页“常驻启动”移除 launchd 服务，并停止 Agent Forge 的开发服务或 tmux 会话。删除项目目录即可移除代码、SQLite 与任务产物：

```bash
rm -rf /path/to/agent-forge
```

如通过设置页保存过 Gitea token，还可在 macOS“钥匙串访问”中删除当前兼容存储条目（服务为 `autofix-console`、账户为 `gitea-token`）。飞书登录态属于 `lark-cli`，只有在不再使用该 CLI 时才应按其自身文档退出或清理。

删除前如需保留历史，可备份 `apps/api/data/autofix.sqlite` 与 `data/tasks/`。
