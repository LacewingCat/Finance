# 开发与版本管理

`main` 保存已检查的版本，功能分支使用 `codex/<功能>`。通过 PR 审查变更与测试结果，提交中不携带真实资产或账号资料。首次版本的分支为 `codex/local-workbench`。

```sh
git switch main
git pull --ff-only
git switch -c codex/my-feature
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run security:scan
git add <reviewed-files>
git commit -m "Describe the resulting behavior"
git push -u origin codex/my-feature
```

修改账本需增加资金守恒和反例测试；调整数据解析需保留来源契约及明确失败状态；接口不确定时先使用小额受预算控制的探针。CI 禁止使用个人密钥及真实个人账本，不消耗 API Credit。只有显式 `FINANCE_LIVE_DATA=1` 的本地浏览器检查才访问免费来源。

数据库当前 schema 1。升级前使用 SQLite 一致性备份，迁移必须在事务中完成，并增加升级/恢复测试；拒绝打开更高版本数据库。不存在升级路径时不得直接修改 `user_version` 冒充迁移。

使用 `npm audit` 检查依赖。当前对 `glob`、`minimatch` 设置补丁覆盖以规避已披露漏洞；升级静态资源插件时复核该覆盖。依赖锁文件必须一起提交。

不把 `.env.local`、截图、卡号片段、API Key、运行数据库、调试日志、原始报告或完整抓取数据集加入 Git。README 示例与自动化测试只使用合成资产。
