# Finance：可审计的策略选择、概率评估与组合计算

研究日期：2026-11-02。研究票：`issues/04-quant.md`。这是公开方法研究与实现建议；代码观察对应研究当天共享工作区，不代表研究分支已经包含相应实现。没有使用个人持仓、生产数据库、密钥或付费 API。下文将“文献结论”“代码事实”和“建议方案”分开，所有新增能力均须通过实现与验收后才能标为已交付。

## 结论与实施顺序

建议先统一可追溯的数据、现金流与实验记录，再实现样本外策略选择、组合协方差及风险贡献、尾部损失、受约束再平衡、现金流目标模拟、概率评估六项能力。CPU 负责确定性计算、抽样与复验；大模型负责带来源的研究、解释及参数建议。现有数据能支撑什么计算，应由数据契约和检验决定，不能由模型补出缺失行情。

“历史结果最高”“条件模拟场景占比”“模型对操作的选择分布”“对明确定义事件的已验证预测概率”必须使用不同字段和显示文案。以下研究没有证明任何策略能保证未来收益最高。

## 一手材料及其适用边界

| 材料 | 核实到的结论 | 对 Finance 的直接含义 |
| --- | --- | --- |
| Hyndman、Athanasopoulos，*Forecasting: Principles and Practice*，时间序列交叉验证 | 滚动预测原点只使用测试点以前的数据，能按预测期限评估。 | 时间顺序必须进入验证协议；随机拆散日期不适合模拟当时可获得的信息。[作者教材](https://otexts.com/fpp3/toolbox.html#time-series-cross-validation) |
| Bailey、Borwein、López de Prado、Zhu，*The Probability of Backtest Overfitting*，2014 年作者稿 | 提出 CSCV/PBO，研究多次策略筛选产生的回测过拟合。 | 记录所有试验；CSCV 是附加筛选诊断，不能替代按时间推进的上线评估，也不能将 PBO 标作未来亏损概率。[作者机构论文](https://carmamaths.org/resources/jon/backtest2.pdf) |
| Bailey、López de Prado，*The Deflated Sharpe Ratio*，2014 | 对选择偏差、多重试验与非正态收益进行 Sharpe 显著性修正。 | 没有完整试验数量/相关性记录，不应输出伪精确 DSR；先建立实验登记，再评估该指标。[作者论文](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) |
| Guo 等，*On Calibration of Modern Neural Networks*，2017 | 在图像、文档分类实验中，温度缩放是有效的后处理方法；温度从留出验证数据拟合。 | 手动设置温度不等于学习校准；论文实验不直接证明金融操作概率可靠。[PMLR 论文](https://proceedings.mlr.press/v70/guo17a.html) |
| Gneiting、Raftery，*Strictly Proper Scoring Rules, Prediction, and Estimation*，2007 | 严格适当评分规则用实际结果评价预测分布，支持诚实报告概率；还讨论分布和区间评分。 | 同时比较 Brier、对数损失和简单基线；区间不能只报覆盖率而不报宽度。[作者论文](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf) |
| Ledoit、Wolf，*Honey, I Shrunk the Sample Covariance Matrix*，2004 | 作者报告样本协方差误差对优化的影响，并提出收缩估计。 | 不能把原始样本矩阵直接当作稳定的已知风险。这里只核实作者摘要；本轮正文地址抓取失败，不据此宣称复现论文估计器。[作者摘要](https://www.ledoit.net/honey_abstract.htm) |
| scikit-learn，`LedoitWolf` 官方文档及源码 | 明确区分按公式估计的收缩系数与用户给定系数，并给出缩向平均方差乘单位矩阵的实现。 | 如需声称 Ledoit–Wolf，应实现指定版本并与该参考实现核对；固定系数只能标作显式正则化。[官方文档](https://scikit-learn.org/stable/modules/generated/sklearn.covariance.LedoitWolf.html)、[官方源码](https://github.com/scikit-learn/scikit-learn/blob/main/sklearn/covariance/_shrunk_covariance.py) |
| Tasche，*Capital Allocation to Business Units and Sub-Portfolios: the Euler Principle*，2007/2008 | 对适当可微、一次齐次风险度量给出 Euler 分解，并讨论标准差、VaR、ES 风险贡献。 | 组合权重占比和风险贡献不同；标准差贡献可为负，不能直接塞入普通饼图。[作者预印本](https://arxiv.org/abs/0708.2542) |
| Rockafellar、Uryasev，*Optimization of Conditional Value-at-Risk*，2000 | CVaR 辅助函数可支持情景优化；线性损失与相应线性约束可构造成线性规划。 | 第一版先实现可核验的尾部测量；后续再加入 CVaR 约束优化。[作者论文](https://sites.math.washington.edu/~rtr/papers/rtr179-CVaR1.pdf) |
| Rockafellar、Uryasev，*Conditional Value-at-Risk for General Loss Distributions*，2002，链接为 2001 年作者稿 | 离散分布的 CVaR 不能通常简化为严格超过 VaR 的样本均值。 | 有限历史样本必须处理分位点处的概率质量；否则小样本和重复损失会出错。[作者论文](https://sites.math.washington.edu/~rtr/papers/rtr187-CVaR2.pdf) |
| R `boot::tsboot` 官方文档 | 支持固定块、几何随机块以及多变量时间序列重抽样。 | 现有固定区块模拟可复用；联合资产应重抽同一时间块，不能分别打乱资产关系。[官方文档](https://stat.ethz.ch/R-manual/R-patched/library/boot/html/tsboot.html) |
| Das、Ostrov、Radhakrishnan、Srivastav，*Dynamic portfolio allocation in goals-based wealth management*，2020 卷期、2019 在线发表 | 研究目标财富成功概率的动态规划，并纳入周期现金流；策略依赖财富、期限与模型假设。 | 先做明确假设的现金流目标场景；目标接近失败时单独最大化成功率可能增大风险，需要约束和下行指标。[作者论文](https://srdas.github.io/Papers/GBWM_DP2.pdf) |

## 当前代码与差距

以下是本轮直接阅读代码得到的事实，行号仅用于定位，后续编辑可能移动。

| 入口 | 已有能力 | 待补齐 |
| --- | --- | --- |
| `src/server/investment-analytics.ts:477`，`simulateStrategy` | 一次投入、定投、价值平均、回撤加码；日/周/双周/月计划；现金、交易单位、费用与税费模型 | 交易计划、决策时点、可成交价格、实际到账现金流须进入统一契约；参数选择需独立留出 |
| `src/server/investment-analytics.ts:720`，`compareStrategies` | 按同一段历史的最终假设清算价值排序，已有“不是未来最高收益”的提示 | 缺少训练/验证/测试嵌套、试验登记、相同可用现金流下的比较；不同投入不能仅按资产终值判胜 |
| `src/server/local-forecast.ts:223`，`evaluateForecast` | 前缀训练、非重叠结果窗口、Brier、训练基准、0.5 基线及覆盖率；明确提示不是校准结论 | 尚无独立校准拟合期、选择后评估、依赖样本不确定性或区间宽度评分；`horizonDays` 实际按报价索引前进，应明确为报价期/交易期 |
| `src/server/risk.ts:42`，`decisionProbabilities` | 校验 Buy/Sell/Hold 分布；可手动进行温度变换；注释已明确不是学习校准 | 缺少事件定义、政策版本、拟合样本与有效期；操作选择分布不能冒充盈利概率 |
| `src/server/backtest.ts:66`，`replayAction` | 有交易规则、费用和现金约束的离线回放 | 仍硬编码 0.9 及复核门槛；不能如实回放用户修改过的阈值和温度，需保存当时 policy snapshot |
| `src/server/investment-analytics.ts:788`、`:1133`、`:1201` | 集中度、情景冲击、目标配置差额、经济资产映射 | 没有联合协方差风险贡献、真实尾部 ES 或受约束优化；这些才可计作新增能力 |
| `src/server/returns.ts:5`、`:53` | 本轮财务票已修 XIRR 多解保守处理与不规则快照年化筛选 | 不规则估值历史仍不能等同交易日序列；日历、现金流切点、全收益口径仍须完整披露 |

## 数据契约：先确定“当时知道什么”

以下为工程设计建议，不是引用论文的既定系统规范。

每个观测至少记录：`instrumentId`、价格/净值口径、币种、市场时区、经济日期、源发布时间、抓取时间、来源链接、复权/分红方法、缺失状态。回测必须按源发布时间过滤；不能让后来发布的净值、财报或修订数据进入过去的决策。当前快照适合描述现状，缺少历史可得性证据时应阻止“严格样本外”标记。

组合风险使用同步的全收益率矩阵与同日汇率。不能用分红后的原始 NAV 当全收益，不能把停牌、未更新或跨市场休市统一填成零收益；展示保留日期数、被剔除日期和最旧数据日期。收缩不会修复错误收益口径。若仅有价格收益，应保留原始图表并明确口径，不输出伪全收益优化。

每次实验记录输入内容哈希、来源版本、价格口径、候选全集、种子、训练/校准/测试区间、标签终点、策略/费用/交易规则版本、拒绝原因与运行时。历史结果不能被重算覆盖；更新行情后产生新运行。无退市/终止产品历史时披露幸存者偏差，禁止把当前产品池回溯成当时全市场。

## 能力一：真正的样本外策略选择

建议将现有 `compareStrategies` 保留为历史比较，新增 `walkForwardStrategies`：在每个外层原点，仅用当时以前的数据训练，在其内部较晚验证段选参数，再冻结参数到下一个测试段。用于训练或选择的标签终点必须早于对应测试起点。拼接的外层曲线是选择流程的评估结果，单一候选的全历史最好结果另列。此结构由滚动原点原则推导；清除跨边界结果窗口是本项目避免标签泄漏的设计。[时间序列交叉验证](https://otexts.com/fpp3/toolbox.html#time-series-cross-validation)

比较必须使用同一初始财富与外部现金到账计划；未投入现金按显式现金利率累积。一次投入只可动用当时已经到账的现金。按日记账、按真实可成交日执行，禁止用当天收盘后的信息在该收盘价成交。显示净收益、TWR、XIRR 可用性、回撤、换手、费用、未成交/现金不足次数和基准，而不是仅排终值。

候选参数、频率和人工试验都进入登记表。只有完整候选矩阵及可解释假设齐备时才添加 PBO/DSR；未记录的试验不能假定为零。[PBO](https://carmamaths.org/resources/jon/backtest2.pdf)、[DSR](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)

验收：向历史尾部追加或修改未来价格，既有原点的参数选择和交易不得改变；构造“训练期上涨、测试期下跌”使事后赢家不再自动成为样本外赢家；相同零收益价格下两种资金日程按现金总账严格核对；手续费增加不能改善相同交易序列的净财富。历史太短、无实际成交规则或无可得时间时，返回具体不足项。

## 能力二：协方差、相关性与风险贡献

先用共同日期矩阵估计协方差，再选择明确版本的收缩估计。通用表达为

\[
\widehat\Sigma=(1-\delta)S+\delta F,\qquad 0\leq\delta\leq1.
\]

固定 \(\delta\) 可做用户情景参数，但不能标为自动 Ledoit–Wolf。采用官方实现对应的估计器时，参考目标是 \(F=\operatorname{tr}(S)I/p\)，应以同样的中心化、归一化及系数计算核对数值。[官方估计器说明](https://scikit-learn.org/stable/modules/generated/sklearn.covariance.LedoitWolf.html)

标准差及 Euler 贡献为

\[
\sigma_p=\sqrt{w^\top\widehat\Sigma w},\qquad
RC_i=\frac{w_i(\widehat\Sigma w)_i}{\sigma_p},\qquad
\sum_i RC_i=\sigma_p.
\]

要求 \(\sigma_p>0\)。负贡献表示边际对冲效果，展示带正负号的条形图与数表；不要裁零后重新归一化。[Euler 风险分解](https://arxiv.org/abs/0708.2542)

验收：两只独立等波动资产各 50% 时风险贡献相等；完全相关、负相关、单资产及零方差均有反例；贡献和等于组合标准差；矩阵对称及半正定容差明确；样本删除不能默默改变币种/口径。少量或高度异步数据应返回不足，不用缺失值零填充维持输出。

## 能力三：受约束配置与再平衡计划

建议首版做最小方差与成本约束，避免把不稳定的短样本均值自动当未来预期收益。示例目标：

\[
\min_w\; w^\top\widehat\Sigma w+\lambda\sum_i c_i|w_i-w_i^0|,
\quad \mathbf1^\top w=1,\;0\leq w_i\leq u_i.
\]

这是项目建议的凸目标：\(c_i\) 为比例交易成本，\(\lambda\) 是有单位解释的权衡系数。必须额外约束最低现金、不可卖数量、交易单位、币种、基金申赎费阶梯与预算。连续权重解只提供目标；离散订单计划须重新核算费用、残余现金及限制。固定费用/最小交易单位使最终问题不再是上述简单连续问题，不能宣称得到全局最优执行方案。

验收：不可行约束有具体说明；全资产上限总和小于 1 时不能归一化伪造可行解；最小交易单位取整后无负现金；零交易优于微小低于费用的调整；输出优化前后风险、换手、费用与规则，不触发实盘下单。输入协方差及其估计误差须一并展示。[收缩估计的优化动机](https://www.ledoit.net/honey_abstract.htm)

## 能力四：历史 VaR、ES 与尾部损失

约定 \(L=-\Delta V\)，正数表示损失。置信水平 \(\alpha\) 的历史 VaR 用公开的分位数定义；等权 \(N\) 个场景的 ES 使用

\[
\operatorname{ES}_\alpha=\min_z\left[z+\frac1{(1-\alpha)N}\sum_{j=1}^N(L_j-z)_+\right].
\]

此形式能正确处理分位点处概率质量；不能直接取 `loss > VaR` 的均值。[一般损失分布 CVaR](https://sites.math.washington.edu/~rtr/papers/rtr187-CVaR2.pdf) 若后续优化损失为线性场景函数，可引入辅助变量构成相应线性规划。[CVaR 优化](https://sites.math.washington.edu/~rtr/papers/rtr179-CVaR1.pdf)

显示货币金额、百分比、期限、估计窗口、场景条数及尾部有效样本。建议将 \(N(1-\alpha)<20\) 标为尾部样本薄弱；20 是产品可调提示阈值，绝非统计保证。多日期限通过真实聚合窗口或明确联合情景重算，不默认乘 \(\sqrt T\)。没有期权/杠杆合约定价模型时不能用简单现货线性收益表示它们。

验收：损失 `[0,0,0,10]`、\(\alpha=0.5\) 时 ES=5；严格超过 VaR 的均值会错误给 10；同值、全盈利、极端损失都覆盖；同一损失样本满足 ES 不低于相同定义的 VaR。另展示指定危机场景结果，不把历史 ES 解释为最大可能损失。

## 能力五：日历现金流目标与资金不足分析

建议先实现可复验的目标财富场景引擎，复用区块抽样并同时保留所有资产在同一日期块的收益。每日约定先到账外部净现金流 \(C_t\)，再扣明确费用 \(F_t\)，再计当日模型收益：

\[
W_{t+1}=(W_t+C_t-F_t)(1+R_{p,t+1}),\qquad
\widehat p_{goal}=\frac1B\sum_{b=1}^B\mathbf1\{W_T^{(b)}\geq G_T\}.
\]

资金不足必须按明确规则停止交易或记录目标失败，不能默许负财富继续复利。用户可配置每日、每周、双周、每月投入、指定日提款、通胀调整、现金收益、费用、币种与目标日；保存节假日处理约定。固定块与几何随机块是不同方法，应明确记录，块长做敏感性比较。[官方区块抽样接口](https://stat.ethz.ch/R-manual/R-patched/library/boot/html/tsboot.html)

输出目标达到场景占比、财富分位数、现金断供次数、短缺金额分布以及提款压力，不称为已经校准的实际成功概率。第一版不需要实现复杂动态规划；若以后添加目标优化，须保留最大风险/回撤/最低现金约束，避免仅追逐目标成功率带来的风险上升。[目标财富动态规划](https://srdas.github.io/Papers/GBWM_DP2.pdf)

验收：零收益零费用时每条路径都等于现金流算术和；相同种子与输入复现一致；闰年/月末/非交易日按指定规则到天；确定性场景下手算提款日期和费用；目标提高时同一组固定策略场景达标比例不增加。短样本、分布突变、未知未来现金流应显示模型敏感性，不能通过增加模拟次数声称消除了模型风险。

## 能力六：事件定义与概率校准实验室

先固定事件。例如：未来 \(h\) 个可交易报价期内，在相同可用资金与当时规则下，Buy/Sell/Hold 中扣费清算价值最高的操作；这是现有回放接近的标签。它与“买入后的净收益大于零”不同。设置平局规则及无法执行时的缺失处理，不得把缺失标签自动记为 Hold。

对操作分布，可在只包含过去成熟标签的独立校准段拟合一个 \(T>0\)：

\[
q_k(T)=\frac{p_k^{1/T}}{\sum_jp_j^{1/T}},\qquad
\widehat T=\arg\min_T-\sum_i\log q_{i,y_i}(T).
\]

最终检验必须在校准段之后；概率截断/数值零处理规则须版本化。当前 UI 手动温度保留为“分布变换”，与拟合温度分开。Guo 等的结果只支持这种校准方法值得验证，并没有证明本项目事件可以被可靠预测。[温度缩放论文](https://proceedings.mlr.press/v70/guo17a.html)

二分类 Brier 为 \(N^{-1}\sum_i(p_i-y_i)^2\)；多分类采用 \(N^{-1}\sum_i\sum_k(p_{ik}-y_{ik})^2\)，注明范围与归一化差异。评估原始/变换后/历史先验基线的 Brier、对数损失、可靠性分箱计数、区间宽度及覆盖率；不能只挑变好的指标。[适当评分规则](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf)

验收：校准期以后的标签变动不改变既有温度；单一类别、零样本、版本混合、未成熟结果拒绝拟合；故意反向高置信预测得到更坏评分；输出训练/测试数量和时间。模型、提示词、标签或市场结构发生变化后，旧温度不得无提示沿用；少量样本不得自动授予“校准通过”。

## CPU、模型与 API 集成边界

建议把上述纯计算放到有容量上限的 worker pool，提交任务即返回任务号，提供进度、取消、结果缓存和运行时。初始吞吐基准覆盖同步行情矩阵、组合大小、场景数与模拟期限；再决定工作线程数量。不得仅因为本机有多核就承诺所有外部数据和 LLM 调用在 5 秒内结束。前端 5 秒内返回可见的缓存状态与各来源新鲜度，是可以单独验收的交互目标；“全部完成刷新”需以真实端到端时间验证。

LLM 输入使用最小必要的公开研究事实与本地计算摘要；输出结构化的论据、出处、反例、敏感变量与建议参数。参数建议经过相同数据/资金/交易规则校验，成为新实验；模型不能修改已保存的检验结果、补全伪造行情、把模拟比例升级成事实胜率，或跳过执行限制。

建议实现顺序为：数据契约和实验登记 → 联合风险/ES → 现金流目标 → 嵌套样本外选择 → 校准实验 → 成本与交易约束的配置建议。各能力须同时交付公式 LaTeX、输入单位、拒绝原因、数据表和可交互图，并支持导出本次输入来源与计算版本。

## 研究限制与完成定义

本报告核对 12 项一手材料，其中 9 项为原始论文、1 项作者教材、2 项官方软件文档。Ledoit–Wolf 的 Honey 论文仅摘要可访问；若实现精确估计器应继续核对完整原文和官方参考实现版本。本报告没有进行真实产品预测效果试验，也没有证明任何金融数据源完整或准确；代码审计与局部财务测试见本地审计记录，不能代替新能力验收。

六项能力验收的共同底线是：来源与时间可追溯、资金算术可复算、未来数据不影响过去决策、无法支持的计算明确不可用、重复运行可复现、用户看到指标含义和限制。只有完成相应实现及反例测试后，才可关闭功能交付票。
