# Finance · 本地个人投资工作台

在自己的 Mac 上查看持仓、维护账本、研究基金与股票。代码开源，个人数据库留在本机。OpenAI 提供分析和决策辅助，证券交易由使用者在银行或券商自行执行。

## 开始使用

需要 macOS、Node **26.12.1**（见 `.nvmrc`）及 npm。初次使用：

```sh
npm ci
npm run build
npm start
```

在另一个终端运行 `npm run open`。它从仅当前用户可读的本地会话文件取得启动令牌，打开 `http://127.0.0.1:4318`；令牌交换成会话后从地址栏移除。直接输入地址可能要求通过启动入口重新打开。

无需 API Key 即可记账、搜索产品、读取免费行情、查看净值和公开披露。最初账本为空，六只参考基金只加入观察列表。

### OpenAI 配置

本项目接受项目根目录 `.env.local` 中的 `OPENAI_API_KEY`，只由后端读取。也可通过设置页保存至 macOS Keychain；项目环境变量优先。**不要把密钥贴进对话、仓库或截图。** `.env.local` 已被 Git 忽略。

在设置页确认实际可分配 Credit、有效期、月预算和模型，再启用 API。默认自动调用关闭；未设置风险参数、产品规则与交易日历时，自动买卖提醒保持关闭。Pro 订阅和 Platform API 账单是不同的计费范围，赠额是否到账以个人 Platform 账户为准。

默认主模型 `gpt-6.1-sol` / `medium`；Decisions 使用 `gpt-6-luna`，没有 reasoning 选项。全部分析模板可查看、版本化编辑和恢复；来源/权限边界固定。API 已知价格表具有复核期限，到期或选择未知价格模型时停止付费调用。

### 日常操作

- **记一笔**：登记资金转入、成交、申购申请、确认、赎回到账、分红、费用或换汇。金额是本金/成交总额，费用单列；申请不等于成交。可冲销历史记录，依赖关系不成立时会拒绝冲销。
- **产品与持仓**：同步全市场基金目录，按代码/名称搜索；手动添加 A/HK/US 股票或场内 ETF，填写市场和原币。指数底层成份不自动成为账户可购买标的。
- **研究助手**：分析模式只读；切换“记账模式”后可直接登记明确的事实。记录回执才代表本地账本更新。对话仅留在当前浏览器页面状态，关闭后不建立长期用户记忆。
- **监控中心**：查看数据质量、有效期、预算与本地告警。ChatGPT 手机推送仍需独立接入验收，界面明确显示“待完成”。
- **偏好设置**：配置最低现金、单笔上限、最大仓位、模型权限、Prompt、日历与汇率。产品的交易账户/渠道名称须与账本账户一致；费用填入已核实的最高适用费率。

账户、数量、资金金额由本地 Decimal 和账本校验。API 输出无法绕过现金、交易单位、预算或写入权限。Buy/Sell/Hold 及 confidence 是模型输出，不是已经校准的盈利概率。所有提醒绑定资产快照；记账或配置改变会使旧提醒失效。

## 后台、备份与开发

```sh
npm run doctor
npm run service:install
npm run service:start
npm run open
npm run service:stop
npm run service:uninstall

npm run backup
# 恢复前先停止服务；恢复会先保存原数据库
npm run restore -- /absolute/path/finance-backup.sqlite

npm run typecheck
npm test
npm run test:e2e
npm run security:scan
npm run test:contracts -- --quick
# 可恢复的广样本验证，访问免费公开数据，需要较长时间
npm run test:contracts -- --full
```

后台安装会把构建和依赖复制至私有数据目录的 `runtime/`，并把项目环境 Key 保存到 macOS Keychain；不会复制 `.env.local`。这样 launchd 不依赖桌面目录权限。升级时先停止后台，重新 build、install、start。

后台仅在 Mac 开机、唤醒、联网时运行。关闭浏览器不会停止 launchd；休眠后恢复时读取当前数据，不补发过期机会。不要同时运行手动服务与 launchd 服务。

个人数据默认在 `~/Library/Application Support/Finance/`，与代码目录分离。备份包含账本、设置、Prompt、行情缓存与费用记录，不含环境密钥或 Keychain。目录权限 0700，数据库/备份权限 0600。环境变量 `FINANCE_DATA_DIR` 可指定独立测试目录。

开发时可用 `npm run build && npm run dev` 获得同源、带认证的完整界面。修改前端后重新 build。分离的 Vite 开发服务器只用于组件开发；生产工作台使用 Fastify 同源入口。

## 文档与交付状态

- [架构图与模块边界](docs/architecture.md)
- [资金口径和 API 预算](docs/accounting-and-budget.md)
- [数据来源与覆盖边界](docs/data-sources.md)
- [真实数据验证报告](docs/data-validation.md)
- [本地运行与通知接入](docs/operations.md)
- [版本工作流和开发约定](CONTRIBUTING.md)
- [验证状态与已知限制](docs/validation.md)

这是一套可运行、可测试的研究工具。产品成立、可购、净值、持仓披露和盘中时延分别验证；不能把软件测试或历史回放通过解释成策略有效。免费源不可用时保留原日期并显示原因，不补造净值、完整持仓或决策数字。详见逐项验收记录。

MIT 许可证仅适用于本仓库代码，不授予第三方行情和报告数据的再分发权。
