# 本地运行与运维

## 启动与认证

运行 `npm ci && npm run build` 后用 `npm start`，再用 `npm run open` 打开。服务器只监听127.0.0.1，认证会话24小时过期；启动令牌在私有 `session.json`。Host 和 Origin 必须是同一端口的 localhost/127.0.0.1，写入需要 CSRF token。没有远程访问入口。

`npm run service:install` 生成用户级 LaunchAgent，`service:start` 加载，`service:stop` 卸载运行实例，`service:uninstall` 移除启动项。plist 中只有 Node 路径、代码路径和数据目录，没有 API Key。安装时从项目 `.env.local` 将已配置 Key 保存到 macOS Keychain；后台使用 `Application Support/Finance/runtime/` 的构建与依赖，不复制环境文件，不再从桌面仓库读取。直接 `npm start` 仍可使用原项目环境变量。使用 Keychain 时首次读取可能需要 macOS 本地授权。

后台默认不开启付费任务。用户在界面打开监控后：核验交易时段内检查股票/ETF（目标60秒），基金正式净值缓存1小时；市场关闭时每小时检查最新公开数据。新闻元数据缓存15分钟。程序根据预算使用率将检查间隔放宽120/300/900秒；真正没有新证据时复用原分析时间，不假造新结果。场外基金目前以正式净值/公开报告变化为决策证据，**没有可验证的分钟级估值或完整底层实时持仓**。

交易日历和基金渠道规则由用户在设置页核验；支持时区、夏令时、周末、假日和午间休市。半日市、特殊停牌、境外底层休市导致的个别 QDII 暂停申赎，仍须依据产品公告禁用可购/规则验证；当前无完整自动规则数据库。

## 备份恢复

`npm run backup` 使用 SQLite 一致性备份 API，可在服务运行时执行，随后 `integrity_check`。备份默认进入私有数据目录的 `backups/`，也可传入绝对路径。

恢复步骤：

1. `npm run service:stop`，或结束手动服务。
2. `npm run restore -- /absolute/path/backup.sqlite`。
3. 检查成功后重新启动；核对资产、风险、Credit 有效期和监控开关。

恢复先保存原数据库，再检查备份 schema 和完整性；更高 schema 不能被旧版本打开。环境密钥和 Keychain 不随数据库复制。JSON 导出适合查看及迁移有效流水；完整审计/已冲销记录与费用预留应通过 SQLite 备份保存。JSON 导入的错误批次整体回滚。

## ChatGPT 通知

当前主程序保存本地告警，独立通知组件提供认证订阅、签名挑战、续期、去重、过期和重试测试。**没有把本地告警自动推送到你的 iPhone**。

`npm run notification:bridge` 是独立 stdio 适配入口，仅访问独立通知 SQLite。可信外部身份适配器须提供短期签名主体声明与固定公钥；没有该配置时关闭订阅/投递。不能让普通 MCP 请求自行声称为资产所有者。

后续需要验证个人 Platform 组织与 ChatGPT workspace 的隧道资格、官方连接方式与身份透传，再连接独立桥。必须依次验证本地告警、回调接受、ChatGPT展示、iPhone推送。HTTP回调成功不等于手机收到。当前没有启用第三方隧道，没有公开匿名端点，也不使用其它通知渠道。

## 故障定位

运行 `npm run doctor` 查看版本、构建、数据库完整性和服务状态，不显示密钥或启动令牌。数据源失败会保留上次数据及原始日期；OpenAI 网络结果不确定会占用费用预留，不能通过无限重试恢复。收费模型目录可独立刷新，模型目录查询不发起推理。

免费数据采集遵循缓存、限速和退避；不绕过登录、验证码、TLS证书验证或付费墙。付费接口不会在测试或 GitHub CI 中自动调用。
