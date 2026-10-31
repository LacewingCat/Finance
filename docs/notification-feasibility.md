# ChatGPT 通知可行性核验

核验日期：2026-11-01，Asia/Shanghai。范围：官方文档、已连接工具能力和只读网络探针；未创建隧道、插件或事件订阅，未发送真实通知，未加载或使用项目 API Key。

**当前结论：本地通知桥已实现；官方隧道设置入口已可访问；已验证用户身份接入、ChatGPT 订阅和 iPhone 推送均未接通，不能宣称通知功能已上线。**

## 官方能力与个人账户边界

| 环节 | 已核验事实 | 本项目当前状态 |
| --- | --- | --- |
| 私有传输 | Secure MCP Tunnel 支持本机 stdio/HTTP MCP，通过出站 HTTPS 工作。个人账户应使用自己的 personal Platform organization，并关联目标 ChatGPT workspace。创建需组织级 Tunnels Read + Manage；运行和选择需 Read + Use。[官方隧道文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) | 已在登录状态下读取到 Tunnels 设置页与 Create tunnel 入口；当前没有隧道。未创建或运行客户端，未验证实际创建/使用权限。 |
| ChatGPT 插件 | 自定义 MCP 入口在 ChatGPT 网页 Plugins 中；可选择 Tunnel。连接和使用仍受 workspace 权限与 Lockdown 等限制。[自定义 MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server) | 未读取到用户已登录的该页面，也未验证自定义插件入口资格。 |
| 事件 | MCP Events 支持 webhook。入口是网页 Work、桌面 Work 的 Cloud 模式或 dot；ChatGPT 负责订阅并给出 callback URL 和签名 secret。事件进入订阅的聊天异步处理。[MCP Events](https://developers.openai.com/plugins/build/mcp-events) | 已实现本地事件协议，但没有 ChatGPT 签发的真实订阅。 |
| 用户身份 | mTLS 认证客户端与 OAuth 认证最终用户是不同层次；服务必须验证用户身份和访问范围。[插件认证](https://developers.openai.com/plugins/build/auth) | 本地桥只接受外部认证适配器签发的短期身份声明。该适配器尚未实现。 |
| 手机提醒 | 通知类别和可用渠道依账户而定，可在 Settings → Notifications 管理。推送仍取决于实际账户和设备设置。[通知文档](https://learn.chatgpt.com/docs/notifications) | 未测试 iPhone 的账户同步、系统通知权限、前台/后台接收。不能把 HTTP 2xx 当作手机已收到。 |

“受支持 Gmail/Slack/GitHub 事件触发的 Scheduled task”与“自定义 MCP Events”不是同一项资格证明；前者的文档不能替代后者的接通验证。[Scheduled tasks](https://learn.chatgpt.com/docs/automations)

## 本次实际只读探针

| 探针 | 结果 | 能证明什么 |
| --- | --- | --- |
| 当前已暴露 OpenAI Platform 连接器工具清单 | 仅 Dashboard、Key 设置目标选择和 Key 创建相关能力；未发现 Tunnel / workspace entitlement 的只读查询工具 | 当前连接器不能完成账户资格查询。目标选择说明可能初始化 Platform 资源，因此未把它用作只读探针。 |
| 官方文档中项目 Key 可调用的隧道状态 GET | 未找到明确、可验证的公开 endpoint 契约；文档只给出控制面 `/v1/tunnel/*` 范围以及客户端操作 | 没有猜测路径，没有把 Key 发到网页或未知端点，没有使用 Admin Key。未找到不等于断言服务不存在。 |
| `command -v tunnel-client` | 退出码 1，无路径 | 当前进程 PATH 未发现客户端；不等于扫描整个硬盘证明未安装。 |
| 受限 shell 的公开 HTTPS GET | DNS 解析受限 | 是探针执行环境限制，不是账户资格结论。 |
| 同一公开 GET 通过获准的正常网络执行 | 隧道 Markdown 官方文档 HTTP 200，21,777 bytes；MCP Events Markdown 官方文档 HTTP 200，16,570 bytes | 本机可在默认 TLS 校验下读取官方文档。未使用 `-k`、关闭证书验证或替换 CA。 |
| 对官方链接 `https://platform.openai.com/settings/organization/tunnels` 的无 Cookie GET | HTTP 403 | 未认证脚本无法读取设置页；不能据此认定用户无权限。未读取响应中的账户资料。 |
| 第一轮浏览器访问 | 子任务的 `iab` 不可用；该执行通道浏览器清单为空 | 初次无法检查设置，不代表用户无权限。 |
| 后续本机 Chrome 只读核验 | 已登录的官方 Tunnels 页可见，显示没有现成隧道和创建入口 | 证明入口可读；没有点击创建，没有导出 Cookie 或读取密钥，未据此推断创建/调用权限与手机送达。 |

前述 shell 网络探针仅发出三个公开 URL 的 GET，无 Authorization、无个人资产、无 API Key。没有执行 `/v1/responses`、`/v1/decisions` 或其他计费模型调用。

## 本地实现与尚缺的连接代码

已有代码是 [notifications.ts](../src/server/notifications.ts)、[notification-bridge.ts](../scripts/notification-bridge.ts) 和 [notifications.test.ts](../tests/notifications.test.ts)。它们包含独立 SQLite outbox、事件发现/订阅/取消、签名回调挑战、短期身份检查、公网 HTTPS 地址过滤与解析后连接绑定、过期、重试和去重。已有验证使用合成身份和模拟传输，不能替代官方端到端验收。

以下是具体未完成项：

1. **身份适配器缺失。** 当前 `finance-auth-gateway` 是本项目约定的 issuer，不是 OpenAI 颁发的身份。声明中的 subject、callbackOrigins、有效期和 live 模式需要来自真实验证链。不能自己填用户名、把普通 MCP 参数当身份，或仅设置环境变量就认定完成认证。
2. **Tunnel 到 stdio 的身份关联尚未验证。** 官方文档证明隧道传输可用，不证明本项目能从 stdio 自动取得调用者身份。必须确定实际 OAuth/身份传递契约，并实现验证、撤权和短期声明续签。MCP callback 的 challenge 只证明回调端点可达，也不能替代用户认证。
3. **没有真实 callback Origin。** allowlist 必须来自经过认证的实际连接配置；不能猜测 OpenAI 回调域名或开放任意公网回调。
4. **业务告警与独立 outbox 的输送还未接线。** 核验时主应用只保存本地 alerts，没有调用 `NotificationOutbox.enqueue` 的正式生产路径。后续应只传最小告警快照，不向 MCP 暴露主资产数据库。当前桥没有主账本读取工具。
5. **没有用户订阅和接收证据。** 尚无真实 `events/list → events/subscribe → challenge → event → ChatGPT 回复 → iPhone push → unsubscribe` 的完整链路记录。

`FINANCE_NOTIFICATION_ATTESTATION_FILE` 和 `FINANCE_NOTIFICATION_AUTH_PUBLIC_KEY_FILE` 只是本地适配器输入位置；它们不是官方账户凭据查询接口。缺少有效外部身份时，事件读取、订阅与发送拒绝执行。`FINANCE_NOTIFICATION_DELIVERY_ENABLED=true` 也不会自行创建官方订阅。

## 费用与后续验收

本次检索的[官方价格页](https://developers.openai.com/api/docs/pricing)和隧道/事件文档没有给出足以承诺本账户“隧道完全免费”或“事件触发 ChatGPT 消耗必定抵扣 Pro100 赠送 API Credit”的明确计费说明。缺少价格条目不等于价格为零。当前 $90 预算控制覆盖本地发出的 Responses/Decisions 请求，不能监测 ChatGPT 端事件任务自身的套餐消耗，也不能约束第三方另行调用同一 Key。

后续在已登录官方设置 UI 验证组织权限、workspace 关联和 ChatGPT 自定义插件入口；完成上述身份适配器、业务 outbox 接线及官方连接，再用不含真实资产的合成告警逐项验收。分别保留订阅成功、回调验证、webhook 接收、ChatGPT 实际回复和手机实际推送的证据。仅前面几项通过时继续显示相应阶段，不能笼统显示“手机通知已接通”。取消、到期、身份撤回、休眠恢复和重复事件也须通过后再启用真实告警。
