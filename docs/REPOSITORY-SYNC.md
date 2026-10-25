# 同一主线同步两个远端

内网和 GitHub 使用同一份已脱敏的 `main` 历史，不在每次发布时转换代码或重新生成提交。公司数据源、人员配置、凭据和运行数据保留在部署者本机，不进入源码。此工作流不改变现有许可证或代替公开发布授权。

## 首次配置

先检查已有远端，不覆盖未知配置：

```bash
git remote -v
```

确认 `origin` 是内部仓库，并在维护者提供 GitHub URL 后创建一个双推送远端。以下占位符必须替换；若已存在 `sync`，先检查其配置，不重复添加。

```bash
git remote add sync "$(git remote get-url origin)"
git remote set-url --add --push sync "$(git remote get-url origin)"
git remote set-url --add --push sync "<GITHUB_REPOSITORY_URL>"
git config remote.sync.push refs/heads/main:refs/heads/main
```

远端 URL 是每个本地 clone 的 Git 配置，不写入已跟踪文件。

## 日常同步

在 `main` 完成代码提交和测试后，只运行：

```bash
git -c push.followTags=false push sync main
```

Git 顺序推送两个站点，不是跨站点事务。如果某站失败，修复权限或网络后重试同一条命令；另一站已经存在的提交不会重复创建。确认两个站点 `refs/heads/main` 都等于本机 `main` 才算同步完成。

只推送 `main`。禁止使用 `--mirror`、`--all` 或 `--tags` 向公开远端推送，避免把内部归档历史、旧标签或未脱敏分支公开。旧 clone 和旧工作树不要将旧历史合回新主线；协作者应保留个人未提交改动后重新克隆，或人工迁移必要补丁。

接收 GitHub 贡献时，在共同历史上进行正常评审、测试和合入，再同步两个远端；不会自动绕过公司评审或部署流程。
