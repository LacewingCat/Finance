# 离线历史回放与概率诊断

此工具读取离线记录，不调用 OpenAI，不生成历史决策，不访问行情接口。当前项目没有已验证的真实决策历史，因此**不能宣称策略有效或概率已经校准**。无输入时返回 `unavailable`；合成单元测试只证明计算和拒绝规则按约定执行。

```sh
npm run replay
npm run replay -- /absolute/path/recorded-decisions.json
```

完整报告写入 `~/Library/Application Support/Finance/replay-*.json`，可由 `FINANCE_DATA_DIR` 指定仓库外私有目录。拒绝把报告写进仓库或指向仓库的符号链接，输出权限为 0600；终端仅打印状态、样本数和路径。不要提交包含真实决策、持仓或账户余额的输入/输出。

## 输入契约

完整机器校验结构为 [`replayInputSchema`](../src/server/backtest.ts)。所有字段严格校验，不接受多余字段；金额、价格和数量使用非负十进制字符串，概率使用 0–1 数字。必填字段如下：

| 层级 | 字段与意义 |
| --- | --- |
| 顶层 | `schemaVersion: 1`、`asOf`（回放截止时间）、`source`（`kind: recorded/synthetic` 与说明）、固定 `horizonSeconds`、可选 `horizonToleranceSeconds`（默认 0）、`maxQuoteAgeSeconds`（默认 120）和 `episodes` |
| episode | 唯一 `id`、`instrument`、`currency`、`generatedAt`、`requestedNotional` 及以下五组记录 |
| quote | `observedAt`、`publishedAt`、`price`、`priceKind`；当前只接受 `trade` |
| portfolio | `observedAt`、`publishedAt`、`cash`、`quantity`、`sellableQuantity`；必须是决策时账户事实 |
| rules | `observedAt`、`publishedAt`、`tradingAllowed`、`buyAllowed`、`lotSize`、`minBuyAmount`、`maxTradeAmount`、`minimumCash`、`maxPositionPct`、`feeRate`、`fixedFee`、`slippageBps` |
| decision | 原始 `buy/sell/hold` 概率及复核模型的 `reviewConfidence`；概率之和为 1，不能用评级或四舍五入显示值替代 |
| outcome | 后续 `observedAt`、`publishedAt`、`price`、`priceKind: trade`；必须在预先声明的期限及容差内 |

时间必须为带时区的 ISO 8601。`generatedAt` 指该次完整信号与复核结果形成、可用于操作的时点。前三组证据必须满足 `observedAt <= publishedAt <= generatedAt`；事后价格必须晚于决策、已在回放截止前公布。不能把抓取日期冒充未知的历史发布日期，也不能用后修订的数据假装当时已经可见。工具只能检查输入时间的一致性，不能认证用户提供的时间戳或历史模型当时是否看到了未来信息。

`source.kind = recorded` 是使用者对原始记录来源的声明，不是工具颁发的真实性认证。默认拒绝以 `synthetic` 数据做验收；测试才使用内部 `allowSynthetic` 选项，输出仍明确为 `synthetic`。

## 交易与 Hold 对照

每条 episode 从其自己的现金和数量状态开始。只有 **Buy/Sell 原始概率严格大于 0.9，且复核置信度严格大于 0.9** 才模拟操作，其他情况为 Hold。决定操作时不读取 `outcome`。

模拟成交价为决策前可得报价加声明的方向性滑点；请求金额按模拟价格和 `lotSize` 向下取整为数量。费用按 `notional × feeRate + fixedFee` 向上取整到分；本金加费用不得超过单笔限额。买入还检查可购、现金、最低现金、最小购买额、最大仓位；卖出检查决策当时可卖数量，不使用未来到账或未来解冻份额。违反规则的触发样本会被拒绝并保留原因，不擅自缩单或补资金。

期末以同类型的事后价格盯市，比较操作方案与同起点 Hold：

`excessVsHold = 模拟操作后现金 + 模拟数量 × 事后价格 −（起始现金 + 起始数量 × 事后价格）`

这里只扣本次操作费用，没有假设期末额外清仓。期末盯市不是已经实现的收益；旧成交报价加滑点也不是实际成交回报，无法验证市场深度、成交排队或冲击成本。

当前不支持以场外基金上一日 NAV 或日内估值假装当时能够成交。基金需另行建立包含真实申赎申请、确认价格、费用和到账时点的记录适配，当前此类样本拒绝。ETF 的日净值历史也不能代替成交价历史。

## 输出和拒绝规则

- 至少 30 条有效、同一资产标签窗口不重叠的样本才输出描述性汇总；不足时为 `insufficient`，不输出收益汇总和校准数字。30 只是工具门槛，不意味着统计证据足够。
- 未来才公布的行情/账户/规则、错误期限、未发布的事后数据、过旧报价、重复 ID、重叠窗口、无效概率或不可执行触发都会被拒绝。报告列出全部拒绝原因，不能静默剔除后宣称成功。
- `sumEpisodeExcessVsHold` 按币种分别汇总，是各独立实验差额之和，不是同一账户的累计利润或可复利的组合曲线。`meanExcessReturn` 的分母是每条的决策前资产价值。
- 误报定义为触发 Buy/Sell 但扣费后不优于 Hold；报告数量与比率。它不是“股票后来下跌”或“模型自评不确信”的替代定义。
- 稳定性报告同资产相邻有效样本的操作切换次数和比例；间隔可能不同，切换率没有自动阈值判断。

## 校准标签的含义

事后标签在相同请求金额与当时约束下，比较模拟 Buy、Sell、Hold 的扣费期末价值。只考虑按已知规则可行的操作；没有严格正超额时标签为 Hold。未来价格只在这里和期末盯市使用，不会改变触发方向、数量、当时费用或限额。

报告提供三分类 Brier 分数（各类别平方误差之和的样本均值，范围 0–2，越低越接近该标签）和按概率十分位分箱的样本数、平均概率、标签频率。**这里检查的是模型行动概率与特定事后标签的关系，不能把结果称作盈利概率校准。** 标签依赖期限、费用、滑点、金额和账户状态；变更任一项会改变问题定义。

跨资产相关性、小样本分箱、被拒绝样本的选择偏差和历史数据修订都可能影响结论。工具不自动优化阈值、不用同一批结果挑“最赚钱参数”，也不提供策略上线判定。独立样本外历史和原始记录审计仍需另行完成。

## 当前验证状态

9 项合成契约测试覆盖：无历史/合成数据拒绝、非法输入拒绝、双严格阈值、已扣费 Hold 对照、前视信息拒绝、未来价格不影响交易量/费用、交易限额及可卖规则、期限/重叠校验、跨币种与误报/稳定性。测试数据明确为虚构，不包含真实决策历史，不构成投资效果验证。
