# 系统架构

浏览器和 Fastify 在本机同源运行；只监听 `127.0.0.1`。所有第三方连接都由后端发起。持仓、费用预留、Prompt 版本和分析审计保存 SQLite；对话正文只存在当前页面与进行中的会话，不建立长期用户记忆。

```mermaid
flowchart TB
    U[用户：查看、提问、记账<br/>证券交易自行执行]
    subgraph MAC[用户的 Mac]
      UI[React / TypeScript / ECharts<br/>六视图、本地会话、CSRF]
      API[Fastify · 127.0.0.1<br/>Host / Origin / 权限与输入校验]
      CFG[设置与 Prompt 版本<br/>风险、模型、reasoning、预算]
      L[不可覆盖的交易流水<br/>申请 → 确认 → 到账 / 冲销]
      DB[(SQLite 私有数据库)]
      KEY[项目环境变量 / macOS Keychain<br/>仅后端可读]
      JOB[launchd + 本地调度<br/>日历、恢复、降频]
      DATA[免费来源适配<br/>缓存、限速、退避、来源日期]
      EXP[历史、公告、穿透关系图<br/>不同分母与未知覆盖独立展示]
      S[一致性资产快照<br/>交易版本 + 数据版本 + 风险配置]
      CHAT[简报 / 临时对话]
      WRITE[记录工具执行器<br/>仅明确用户记账链可写]
      D[Decisions<br/>三概率 + 评分 + confidence]
      B[统一预算控制<br/>原子预留 → usage 结算<br/>超时保留预留，不自动重试]
      G{有效交易窗口<br/>Buy / Sell 严格大于 90%}
      R[Responses 证据复核]
      M[本地金额规则<br/>分账户现金、费用、仓位、可卖数量]
      A[Responses 评价合法候选<br/>Score / Urgency]
      CHECK[发布前复核<br/>快照、数据、权限、金额有效]
      O[(本地告警及去重)]
      BR[独立通知桥与 SQLite<br/>验证身份、签名、回调公网地址校验]
    end
    subgraph PUBLIC[公开免费来源]
      F[基金目录 / 销售机构<br/>净值与历史]
      P[监管 / 管理人 / 交易所<br/>定期报告与产品资料]
      Q[股票行情 / 宏观 RSS<br/>ECB 参考汇率]
    end
    subgraph OPENAI[授权的 OpenAI 服务]
      RESP[Responses API<br/>用户选择模型与 reasoning]
      DEC[Decisions API<br/>gpt-6-luna]
      T[Secure MCP Tunnel<br/>账户与身份适配待接通]
      C[ChatGPT MCP Events<br/>订阅与回调待实测]
    end
    IOS[iPhone ChatGPT App<br/>实际推送待验收]
    GH[GitHub Public<br/>代码、文档、合成测试]
    U --> UI --> API
    API --> CFG
    API --> L --> DB
    API --> CHAT
    KEY -.-> B
    JOB --> DATA
    F --> DATA
    P --> DATA
    Q --> DATA
    DATA --> EXP --> DB
    DB --> S
    CFG --> S
    S --> CHAT --> B
    CHAT --> WRITE
    WRITE -->|受控读| DB
    WRITE -->|明确事实、幂等校验| L
    S --> D --> B
    B <--> RESP
    B <--> DEC
    D --> G --> R --> B
    R -->|复核 confidence 严格大于90%| M
    S --> M --> A --> B
    A --> CHECK --> O
    O -.->|只传有效告警；桥接待接通| BR
    BR -.->|认证身份未完成时关闭| T
    T -.-> C
    BR -.->|签名事件回调| C
    C -.-> IOS
    DB --> API
    GH -.->|安装更新；无个人数据| MAC
```

实线表示本地代码已有实现的路径；通知虚线表示独立组件已经具备测试，但官方连接、可信身份适配及手机送达尚未完成。主程序不会把待完成通知显示成已经送达。

## 模块契约

| 模块                                        | 责任                                           | 不具备的权限                      |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| `ledger.ts`                                 | 十进制流水、在途状态、幂等、冲销、移动均价成本 | 下单、访问 API Key                |
| `portfolio.ts` / `returns.ts`               | 汇总、快照版本、收益口径与缺失状态             | 伪造估值、覆盖历史流水            |
| `providers.ts` / `feeds.ts` / `exposure.ts` | 限制来源的公开数据读取、解析、穿透             | 执行网页 JS、执行报告内指令       |
| `ai.ts` / `budget.ts`                       | 固定边界、可编辑模板、模型校验、费用预留       | 绕过交易校验、后台写账本          |
| `risk.ts`                                   | 交易日历、分账户约束、确定性金额候选           | 决定实际成交、借用其它账户现金    |
| `notifications.ts`                          | 独立 outbox、认证订阅、回调验证与重试          | 读取主账本、访问 Platform API Key |

新闻和报告均是低信任证据；模型工具只接受服务器定义的结构。授权头不进入模型输入、导出、浏览器或日志。
