# Finance 多资产数据、穿透及真实性契约研究

研究日期：2026-11-02。研究票：**多资产数据与穿透采用哪些可验证来源和实体模型？**。本报告只包含公开资料、公开证券示例及本地代码观察，不含个人持仓、交易、余额、密钥或私有数据库统计。研究没有更改应用代码或生产数据。

## 决策结论

建议采用“证券主数据 + 多种报价口径 + 公司行动 + 披露快照 + 来源证据”的分层模型。ETF/场外基金是交易载体，QDII 是跨境投资属性，FOF 是投资于基金的结构，不能继续用一个互斥的 `kind` 表达。每个字段具有来源、来源日期、抓取时间和质量状态；行情、净值、报告和模型任务分别刷新。以下是根据官方资料与探针提出的工程方案，不是已经实现的能力声明。

公开接口在本次少量探针中响应很快，但快速响应不等于实时数据。不能承诺外部所有报价、披露、新闻与模型推理每次都在 5 秒内完成；不能把受理刷新任务的时间冒充完成时间。应用应分别公布网络耗时、数据日期及刷新分区状态。

## 一手事实与规则

### 披露周期和穿透时滞

证监会现公开的《公开募集证券投资基金信息披露管理办法》（2019 年发布、2020 年修订）规定一般开放式基金按开放日披露净值，特殊品种按特别规定；年报、中报、季报的编制披露期限分别是期末起三个月、两个月、十五个工作日。合同生效不足两个月有定期报告豁免。因此报告的发布时间、持仓测量日、抓取日必须分别保存；当天抓到的季度报告不能表示当天实时持仓。[证监会管理办法](https://www.csrc.gov.cn/csrc/c106256/c1653985/content.shtml)

本次发现 **2026 年报告格式已经更新**：新《定期报告的内容与格式》自 2026-05-01 实施，整合年报、中报、季报并针对不同报告类型提出差异要求，XBRL 模板由基金业协会按准则制定。其第三十条要求披露期末资产组合及规定范围的证券明细。解析器应跟随报告类型和模板版本记录覆盖范围，不能依据旧经验把“前十名”固定解释为全持仓。[证监会实施公告](https://www.csrc.gov.cn/csrc/c101954/c7619929/content.shtml)、[修订说明](https://www.csrc.gov.cn/csrc/c100028/c7619936/content.shtml)、[准则正文](https://www.csrc.gov.cn/csrc/c101954/c7619929/7619929/files/6597e7afd35843e1a6ec023ea547d126.pdf)

本次未核实全部 QDII 产品各自的披露条款，不能给所有 QDII 硬编码同一个滞后日数。应逐份额读取合同/招募说明书和境内外工作日历，保留 `disclosureLagRule = unknown`，直到取得确切条款。跨期穿透可以作为有标记的近似视图，不应无提示用于精确风险归因。

### 正交产品分类

国泰管理人产品页直接将代码 513100 标为 QDII-ETF，证明 QDII 与 ETF 可同时成立；页面同时列有 QDII-FOF 产品。证监会运作办法以投资其他基金的资产比例定义 FOF，说明它描述投资结构，而非上市交易方式。[国泰 513100 产品页](https://www.gtfund.com/product/productlist/haiwai/513100/index.html)、[证监会运作管理办法第三十条](https://www.csrc.gov.cn/csrc/c106256/c1653978/content.shtml)

建议实体：`Instrument` 表示经济证券/基金份额，`Listing` 表示交易所挂牌；基金 A/C、人民币/美元份额均单独标识。将基金代码与 `sh/sz/bj` 等交易代码映射到实体，保留原始供应商代码；不能靠名称相似或裸代码相同合并。标识设计是本研究推导的工程决策。

| 维度 | 建议字段/值 | 缺证据时 |
| --- | --- | --- |
| 经济资产 | fund_share / equity / bond / index_reference 等 | unknown，不猜 |
| 交易载体 | ETF / LOF / OTC / exchange_equity | 未验证，保留人工录入来源 |
| 投资结构 | direct / feeder / FOF | unknown |
| 投资授权/范围 | QDII、境内、港股通等标签 | 不由计价币种推出 |
| 风格 | index / active；equity / bond / money / balanced；行业/区域 | 名称分类仅作检索提示，不变成已核实事实 |
| 身份 | internal ID、份额代码、交易所、ticker、ISIN（如公开）、CIK（发行人） | 记录来源与有效期 |

### 复权、分红和收益口径

Apple 官方列出历史拆股，并明确分红表中的金额没有按拆股调整；其 FAQ 同时列明 IPO 时间。这证明价格序列、股数变化与现金分红必须一起处理，不能把价格跳变一律视作投资损失，也不能把发行价直接补成缺失市场收盘价。[Apple FAQ](https://investor.apple.com/faq./default.aspx)、[Apple 分红和拆股表](https://investor.apple.com/dividend-history/default.aspx)

建议至少保存 `raw_close`、`split_adjusted_close`、`total_return_index` 三种不同序列，外加拆股比例、除息日、登记日、支付日、每份现金分红和其报价基准。来源仅给 `adjclose` 时应先核实具体调整范围，不能自动声称是经独立验证的含税再投收益。当前 `price-history.ts` 明确请求 `fqt=0`，属于未复权价格路径；需在计算模块禁止把它静默当作总回报。

### 行情权限与真实时延

上交所信息公司公开列有 Level-1 即时行情、接入方式及授权许可；深交所数据服务区分实时、15 分钟延时和日终数据；港交所数据服务同样区分授权数据产品和供应商。公开页面存在不等于任意抓取接口具有交易所实时性保证。[上证所 Level-1](https://www.sseinfo.com/services/assortment/level1/)、[深交所数据服务](https://investor.szse.cn/English/services/dataServices/index.html)、[港交所数据服务 FAQ](https://www.hkex.com.hk/Global/Exchange/FAQ/Market-Data/Getting-Market-Data?sc_lang=en)

ECB 官方说明参考汇率通常在工作日约 16:00 CET 更新，并将其定位为信息用途，而非成交汇率。它可以支持有日期标记的资产估值，不能代表用户实际换汇成本。[ECB 汇率说明](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)

SEC 官方提供无需 API Key 的提交记录与财报 XBRL API，按披露更新，支持 CIK 和 ticker/交易所元数据；这适合美国发行人原始报告，不是市场价格源。[SEC EDGAR API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

## 数据源矩阵

下表“可接入”是工程优先级建议，不表示已验证所有产品覆盖、自动化许可、服务 SLA 或源数据绝对准确。

| 数据 | 优先证据 | 当前/备用适配 | 最小契约与限制 |
| --- | --- | --- | --- |
| 基金主数据、类型、份额 | 管理人合同/产品页、监管公开资料 | [东方财富公开目录](https://fund.eastmoney.com/js/fundcode_search.js) | exact share code、名称、币种、成立/变更日；目录不证明可购/上市/适当性 |
| 基金正式净值 | 管理人、监管披露 | 易方达财富销售页、东方财富正式净值序列 | NAV date、share currency、unit/accumulated NAV、来源；不可混入盘中估值或万份收益 |
| 股票/场内 ETF 报价 | 授权交易所/供应商 | [腾讯公开示例](https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL)、东方财富 | exact listing、币种、来源时间、报价类型；免费源实时性未核验 |
| 股票/ETF 历史 OHLCV | 授权历史行情与公司行动 | [东方财富历史示例](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=0&beg=20261001&end=20261102&lmt=5&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61)、Yahoo | 严格区分未复权、拆股调整、总收益；保存 OHLCV，不用单一价格造 K 线 |
| 海外证券类型 | 交易所/发行人身份资料 | [Yahoo AAPL 元数据与历史示例](https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo&events=div%2Csplits) | 精确 ticker、exchange、currency、instrumentType；美国全市场目录含混合类型，不默认全是股票 |
| 基金/上市证券公告 | 管理人、[上交所公告](https://www.sse.com.cn/disclosure/fund/announcement/)、深交所/巨潮公开发行人文件 | [东方财富基金公告示例](https://api.fund.eastmoney.com/f10/JJGG?fundcode=000216&pageIndex=1&pageSize=30&type=0) | 原始 URL、发行人/份额标识、publication date、report period、文档 hash、解析版本 |
| 美国发行人报告 | SEC EDGAR、发行人 IR | 下一批适配 SEC submissions / companyfacts | CIK、accession、form、filed/period 日期；报告更新不等于行情更新 |
| 穿透持仓 | 各层管理人正式报告 | 东方财富/销售机构披露表辅助索引 | parent/child ID、weight denominator、report date、范围/未知部分、证据位置；跨期标记 |
| 财经新闻/播客 | 出版方 RSS、发行人新闻 | 项目现有白名单 feeds | 标题、原始链接、发布时间、媒体类型/主体、相关性；不得为凑 10 条复制泛市场消息 |
| FX | ECB 等央行参考数据 | [ECB daily XML](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml) | currency pair、base、reference date、published/fetched time；成交换汇另按账本事实 |
| 指数基准 | 指数编制人、交易所 | 当前腾讯指数报价/历史 | price / gross total return / net total return、币种、交易日历、成分有效期；不同口径不可直接并线排名 |

每份资料不足 10 条应披露“实际 N 条、最后成功抓取、失败源、覆盖范围”；新基金/停运来源可能根本没有十份相关资料。“网站来源画面”需真实截图或允许展示的页面预览，当前 SVG 标题资料卡不能算来源截图。

## 免费探针（真实读取，单次样本）

本机 Node fetch，超时 15 秒；目录分页探针使用当前 PublicDataClient 的限速。未使用 API Key、未调用付费模型；只使用明确列出的公开样本。下列耗时包含网络读取及解析，不是 SLA 或 P95。官方 PDF 的网页抽取部分曾超时，直接抓取及本地文本读取成功；未绕过验证或封禁。

2026-11-02 14:05:34 UTC 开始的一组探针：

| 公开请求 | HTTP | 本次耗时 | 实际结果 |
| --- | --- | ---: | --- |
| [基金目录](https://fund.eastmoney.com/js/fundcode_search.js) | 200 | 841 ms | 28,242 条，可解析 |
| [000216 公告](https://api.fund.eastmoney.com/f10/JJGG?fundcode=000216&pageIndex=1&pageSize=30&type=0) | 200 | 111 ms | 30 条真实元数据；最新公告日期 2026-10-27；没有逐份读完 PDF |
| [腾讯三市场报价](https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL) | 200 | 204 ms | sh600519 来源时刻 2026-11-02 08:14:55Z；00700 为 08:08:21Z；AAPL 为 2026-10-30 20:00:02Z |
| [600519 未复权日历史](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=0&beg=20261001&end=20261102&lmt=5&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61) | 200 | 92 ms | 18 行，2026-10-08 至 2026-11-02；请求 lmt=5 未把响应限制为五行，客户端须校验实际长度 |
| [Yahoo AAPL 一月日线](https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo&events=div%2Csplits) | 200 | 1,194 ms | AAPL/EQUITY/USD/NMS、23 点、含 adjclose 字段；本区间事件为空，不证明整个历史无公司行动 |
| [ECB daily XML](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml) | 200 | 1,309 ms | asOf 2026-10-30；CNY/USD/HKD/GBP/EUR 转换数据可解析 |
| [证监会披露办法 PDF](https://www.csrc.gov.cn/csrc/c106256/c1654000/1654000/files/166-8%E3%80%8A%E5%85%AC%E5%BC%80%E5%8B%9F%E9%9B%86%E8%AF%81%E5%88%B8%E6%8A%95%E8%B5%84%E5%9F%BA%E9%87%91%E4%BF%A1%E6%81%AF%E6%8A%AB%E9%9C%B2%E7%AE%A1%E7%90%86%E5%8A%9E%E6%B3%95%E3%80%8B.pdf) | 200 | 869 ms | 18 页文本可读取；另成功读取 2026 定期报告格式准则 10 页正文 |

来源时刻可能是供应商更新时间，而非每笔成交的事件时间；它的语义也须纳入契约。此次探针发生在中港收盘后、美股当日正式开盘前，所以不能拿 `fetchedAt-asOf` 当作交易时段供应商延迟，更不能据此宣布实时行情通过。

14:06:48–14:06:50 UTC 多市场目录抽样（每市场仅请求第一页三条）：

| 来源 | 来源报告的总数 | 收到 | 请求及排队耗时 | 结论 |
| --- | ---: | ---: | ---: | --- |
| [CN typed boards](https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&fs=m%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23%2Cm%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A0%2Bt%3A81%2Bs%3A2048&fields=f12%2Cf13%2Cf14&fltt=2&invt=2&fid=f12&po=0) | 5,926 | 3 | 298 ms | 类型契约为指定股票板块；不能据三条推导全目录准确 |
| [HK mainboard](https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&fs=m%3A116%2Bt%3A3&fields=f12%2Cf13%2Cf14&fltt=2&invt=2&fid=f12&po=0) | 2,620 | 3 | 786 ms | 不是所有港股金融产品的穷尽列表 |
| [US exchange universe](https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&fs=m%3A105%2Cm%3A106%2Cm%3A107&fields=f12%2Cf13%2Cf14&fltt=2&invt=2&fid=f12&po=0) | 13,899 | 3 | 1,116 ms | 当前解析器正确保留 kindVerified=false；需逐证券核型 |

所有 sourceReportedTotal 只是来源返回数字，未完成全页枚举，也不是可交易清单。与旧报告数字不同是观察结果，不能在未核查增删原因时称为错误或准确性提升。

## 建议数据契约

这些契约为工程建议，须在实现票通过样本和回归测试验收：

1. **Observation**：`instrumentId/listingId, field, value(decimal string), currency, unit, priceBasis, sourceId, sourceUrl, sourceAsOf, eventTimeMeaning, publishedAt?, fetchedAt, validatedAt, quality, uncertaintyReason, rawHash, parserVersion`。禁止以 fetchedAt 替换 sourceAsOf，禁止无证据自动升级质量。
2. **Series**：`frequency, timezone, calendar, adjustmentBasis, corporateActionCoverage, first/lastAvailableDate, requestedRange, missingDates, sourceIds`。收益计算须校验同币种同口径；累计净值不是可以无条件当作分红再投指数的替代品。
3. **DisclosureSnapshot**：`fundShareId, reportPeriod, publicationDate, reportType/templateVersion, assetBasis, holdings, coverage, unknownWeight, documents/evidenceOffsets`。图递归以快照为单位，保留每层报告期；来源新一层不能静默删除先前子图。
4. **SourceRegistry**：能力、适用市场/字段、主体身份、授权/使用条件核验状态、额度/限速、冷却期、失败类型、最近成功与下一次计划。主次来源独立，不因某次 200 就有完整 SLA。
5. **RefreshJob**：每字段分区 queued/running/succeeded/failed/cancelled，requestedAt/startedAt/completedAt，deadline、sourceAsOf、cache/stale 标记；全量完成只在所有要求分区终态后声明。模型推理状态单独呈现。
6. **AccuracyReport**：identity/date/unit/currency/schema 检查、重复与冲突、公司行动、完整性、独立源核对、源时延验证分别统计分母。可解析 28,242 条目录不能写成 28,242 个产品价格均已核实。

## 实施优先顺序与验收

1. **P0：保留证据与阻止错误计算。** 分区保留最后成功结果；未来/非法日期和币种/代码冲突拒收；未复权证券不输出未经公司行动处理的总回报排名。模拟一次上游故障应保留历史/报告的原日期并清楚标记失败。
2. **P1：主数据与口径迁移。** 增加稳定实体、交易所挂牌、份额映射和正交标签。以 513100、普通股票、FOF、ETF 联接为交叉样本，确认上市交易价格与基金 NAV 不串线、不重复记作不同持仓。
3. **P1：刷新分区及端到端测量。** 先读本地快照，有界并行获取报价，报告/新闻/历史差分独立作业；UI 5 秒响应与所有外部更新完成分别统计。对 1/10/50 产品、缓存冷热、来源失败、限流、并发刷新测量 P50/P95/P99，不以此次少量探针替代压力验收。
4. **P1：公司行动与收益序列。** 独立获取拆分/分红，先以发行人官方事件核对，再用人工可计算样本验证股数、现金和再投过程。调整规则不明时输出原价格及不可计算原因。
5. **P2：报告和穿透。** 接入管理人/交易所/SEC 第一手报告索引，解析器按 2026 格式版本演进；逐层显示已知资产、未识别份额和跨期近似，禁止把同名海外 ETF 自动映射 ticker。
6. **P2：数据库与来源浏览。** 分页过滤所有主数据、来源、历史点、公司行动、报告快照与冲突；导出包含口径及时间证据。文档真实去重计数，提供原文链接；截图功能单独验收。
7. **P3：扩大覆盖与持续校验。** 分市场/产品类/管理人建立固定样本+随机样本，夜间批处理官方资料与独立源比对；样本通过仅报告样本范围，未覆盖项继续显式未知。

## 仍未成立的声明

没有完成全市场行情授权或实时时延验收、所有产品独立数据核对、全部基金完整穿透、每只金融产品至少十条实际相关资料、所有 QDII 特别披露规则核验、所有价格历史公司行动复原，亦没有验证未来投资收益。研究票解决的是证据源和契约方向，后续实现仍需按以上验收推进。
