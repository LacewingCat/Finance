# OpenAI 实际接口验收

日期：2026-11-01，Asia/Shanghai。本轮只发送明确标注的合成资产数据，没有读取生产账本、修改生产设置或执行金融交易。验收脚本使用既有服务模块，真实调用前保存费用预留；预算硬上限为已用加未决预留合计 **$0.20**。

## 已观察结果

| 用例 | 模型与接口 | 实际结果 | 输入 / 输出 tokens | 本地核算费用 USD |
| --- | --- | --- | --- | --- |
| 简短简报 | gpt-6.1-sol / medium，Responses | HTTP 200，completed；返回中文合成数据与资料不足说明 | 559 / 62 | 0.001738 |
| 原投资 Prompt 的 Decisions | gpt-6-luna，Decisions | HTTP 200；action 返回有效三项概率及 confidence，quality 返回 refusal；应用整体标记 refused，并停止触发链 | 1195 / 0 | 0.000120 |
| 分析对话 | gpt-6-luna / none，Responses | HTTP 200，completed；说明行动选择概率不等于盈利概率 | 603 / 32 | 0.000077 |
| 原记录 Prompt 的合成入金 | gpt-6-luna / none，Responses | HTTP 200，completed，但只有文本，没有 function_call 或记账回执；工具执行验收未通过 | 993 / 99 | 0.000149 |
| 独立 choice + score 合成契约 | gpt-6-luna，Decisions | 未取得可验证响应；无自动重试 | 未知 | 保留预留 0.002282 |
| 独立合成记账工具契约 | gpt-6-luna / none，Responses | 未取得可验证响应；无自动重试 | 未知 | 保留预留 0.002222 |
| 新 choice + score 契约 | gpt-6-luna，Decisions | HTTP 200；choice 和数值 score 同时返回，解析通过 | 1479 / 0 | 0.000148 |
| 新合成记账工具契约 | gpt-6-luna / none，Responses | HTTP 200；严格 function_call 校验通过，隔离账本新增测试入金并返回回执 | 959 / 97 | 0.000145 |

已结算估算合计 **$0.002377**，未决预留 **$0.004504**，总占用 **$0.006881**。费用由原始 usage 与已核验价格计算到微美元并向上取整，不是已核对的最终供应商账单。缓存读写 tokens 本轮均为 0；输出 usage 的 reasoning_tokens 均为 0，不另外重复计费。[官方价格](https://developers.openai.com/api/docs/pricing)

第一个 Decisions 返回 Buy 0.03、Sell 0.08、Hold 0.89、confidence 0.83。它没有有效 quality score，应用没有拼接出虚假的完整“五个数值”。后续新合成契约返回 Buy 0.02、Sell 0.01、Hold 0.97、confidence 0.96，原始 quality score 为 3.35，应用正确映射为 10 分制 3.7222。后续记账契约实际返回 `record_transaction`，只在隔离数据库登记 1.23 元合成入金，回执与幂等键已核对。所有数字均无投资意义，完整接口结构已实测，但不代表生产投资判断质量或任何提示词都必然调用工具。

简报使用方案中的默认 gpt-6.1-sol / medium。其余 Luna 是本次隔离低成本验收配置，没有替换生产用户选择的模型。额外契约用例使用专门标注的合成测试 Prompt，不代表生产投资 Prompt 效果。

## 边界与复现

[verify-api.ts](../scripts/verify-api.ts) 默认 dry-run，不读取 Key、不创建验证数据库、不联网。只有显式 `--live` 才进行付费阶段。脚本只打开固定隔离目录，不读取生产数据库；只允许官方模型目录 GET、Responses POST 和 Decisions POST，不启用收费搜索。

```sh
npm run verify:api
```

真实模式仅在明确授权后使用：

```sh
npm run verify:api -- --live
```

已经尝试过的阶段会跳过。免费模型目录最多两次有界尝试；`--retry-free-failure` 仅允许恢复没有产生任何费用或预留的失败阶段。付费 POST 没有自动重试。独立的 `--stage=decisions-contract` 和 `--stage=record-contract` 只验证合成协议契约。所有运行共用同一隔离预算账本，历史未决预留也计入 $0.20 硬限，不能通过重启或跨月绕开。

本轮起初免费模型目录连接失败；一次独立免费 GET 后取得 HTTP 200，随后恢复未发出过付费请求的阶段。之后两次付费请求未获得可验证响应，原费用预留继续保留。只读诊断时域名仅解析出一个 IPv4 地址，两次无 Key GET 均返回预期的 401，不能证实 IPv6、DNS 或 Clash 是故障原因。

在另行明确授权最多两个新契约请求后，先免费验证连接，再用进程级 `--dns-result-order=ipv4first` 运行；这两条新请求使用新 ID，均成功。没有重试原先的不确定 POST。由于原失败没有更细的传输错误日志，其根因仍未确定，不能断言 IPv4 优先解决了问题。新增审计已区分 transport、HTTP、响应 JSON、响应结构及 usage 校验阶段，只保存安全错误类型/代码和 HTTP 状态，不保存上游错误正文或 Key。全过程使用正常 TLS 校验，没有关闭证书校验或修改系统网络设置。

原始 usage、请求编号、响应分类及八条 `ai-budget` 记录保存于仓库外的私有验证目录。生产预算接入必须按原预留 ID 幂等导入八条记录，保留两条 ambiguous，不能仅导入已结算金额。公开仓库不包含 Key、账户资料、用户 Credit 配置或完整模型目录。

没有验证本轮未触发的 >90% 决策链、真实投资质量、自动交易或 ChatGPT 手机通知。没有为达到阈值而反复调用模型。
