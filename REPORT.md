# TapNow Canvas 本地导出与动态请求拦截测试报告

## 1. 测试范围

测试日期：2026-09-03（Europe/Berlin）

目标画布：

```text
https://app.tapnow.ai/canvas/350073d9-2b5a-4a79-b057-4f9e644c75d4
```

目标：

1. 判断画布中的每个步骤是否可以抓取并保存到本地。
2. 判断节点运行过程的输入、输出和状态变化是否可以拦截。
3. 验证文本、连线、图片原文件、浏览器缓存和流式通道。
4. 形成不泄露账号、token 和画布正文的可公开报告。

测试使用用户授权账号和专用 Chromium profile。未执行付费生成、删除节点、
修改提示词、分享或发布画布。

## 2. 最终结论

**可以保存。** 对本次目标画布，登录后能够完整保存：

- 画布名称、ID、创建/更新时间、组织和可见性等元数据。
- 全部节点及其类型、位置、尺寸、参数、任务状态和节点数据。
- 全部连线及 source/target、handle、类型等关系数据。
- Text 节点的提示词和文本输出。
- Image 节点的模型参数、提示词、文件 ID、媒体 URL 和图片原文件。

**可以拦截。** 新开标签页的加载测试捕获了 112 个网络事件、19 个第一方
API 请求/响应正文。`nodes:batchActions` 请求正文包含完整节点更新，
包括提示词、模型、结果和完成状态，因此浏览器中间请求可被动态记录。

**有边界。**

- 主站 API 需要 `Authorization: Bearer <access_token>`。
- 媒体域不能携带主站 Authorization，必须带
  `Referer: https://app.tapnow.ai/`。
- 本次没有执行新的付费生成，故没有实测一条从提交到完成的全新生成流。
- 目标画布加载期间没有观察到 WebSocket；前端代码包含协作加入和 Yjs
  WebSocket 实现，但是否启用取决于画布/账号配置。
- 接口属于网页内部接口，不是已承诺稳定的公开 API。

## 3. 实测画布结果

公开报告只保留结构与数量，不发布节点正文和图片。

| 项目 | 结果 |
| --- | ---: |
| 画布名称 | `TEST-0903` |
| 节点总数 | 4 |
| Text 节点 | 2 |
| Image 节点 | 2 |
| 连线总数 | 4 |
| 引用媒体 | 2 |
| 已下载原图 | 2 |
| 原图总大小 | 1,177,662 字节 |
| 原图尺寸 | 两张均为 2560×2560 |

检测到的节点字段包括：

```text
id, canvas_id, type, data, position, dimensions, measured,
source_position, target_position, parent_id, session_id,
created_by, created_by_role, created_at, updated_at
```

Text 节点的 `data` 结构包含：

```text
title, type, prompt, text, params, taskInfo
```

Image 节点的 `data` 结构包含：

```text
title, type, prompt, src, currentSourceFileId, options,
params, taskInfo, historyLocalQueues, historyLocalQueueMetadata
```

本画布检测到的模型类型为文本模型和图片模型，所有 4 个节点的
`taskInfo.status` 均为 `completed`。

## 4. 关键接口

| 用途 | 方法与路径 | 实测 |
| --- | --- | --- |
| 画布整体 | `GET /api/canvas/v1/canvases/{id}?with_nodes=true&with_connections=true` | 200 |
| 节点分页 | `GET /api/canvas/v1/canvases/{id}/nodes?limit=100&include_relations=true` | 200，4 节点 |
| 连线分页 | `GET /api/canvas/v1/canvases/{id}/connections?limit=100` | 200，4 连线 |
| 节点批量持久化 | `POST /api/canvas/v1/canvases/{id}/nodes:batchActions` | 200，可见请求/响应 |
| 画布对话 | `GET /api/agent-gateway/v1/conversation?canvas_id={id}` | 200 |
| 动态建议 | `POST /api/agent-gateway/v1/conversations/suggestions/dynamic` | 200 |
| 媒体文件 | `GET https://files.tapnow.media/api/conversation/storage/uploads/{file_id}` | 200，需 Referer |

从当前官方前端构建中还定位到以下通道：

```text
POST /api/agent-gateway/v1/conversations
POST /api/agent-gateway/v1/conversations/{conversation_id}/runs
GET  /api/agent-gateway-stream/v1/runs/{run_id}/events
POST /api/agent-gateway/v1/runs/{run_id}/answers
POST /api/agent-gateway/v1/runs/{run_id}/cancel
POST /api/canvas-collab/v1/canvas/{canvas_id}/join
```

其中 `runs/{run_id}/events` 用于 Agent 运行事件流，协作加入接口会返回实时
协作连接所需信息。它们来自 TapNow 2.15.4 前端实现分析，本次未启动付费
Agent run，也未在目标画布捕获到 WebSocket 帧。

## 5. 输入输出动态能否拦截

### 5.1 已有节点

可以。画布 GET 响应已经包含历史输入、输出、模型参数、任务状态和媒体 URL。
只要账号有画布访问权，就能将当前完整状态保存为 JSON。

### 5.2 节点保存过程

可以。页面首次加载时观察到：

```text
POST /api/canvas/v1/canvases/{id}/nodes:batchActions
```

请求正文中出现 `actions[].updates[]`，其中包含节点 ID、类型、位置、
`data.params`、`data.prompt`、`data.text`、`data.src` 和
`data.taskInfo.status`。因此 fetch/XHR 层可以直接记录输入与输出。

### 5.3 新生成过程

技术上可拦截，但本次只验证到通道和已有完成结果，没有消耗 Tapies 发起新生成。
推荐同时记录：

1. 生成提交 POST 的请求正文。
2. task/run ID。
3. SSE、轮询或任务恢复接口的增量事件。
4. 最终 `nodes:batchActions` 和画布 GET 中持久化后的结果。

如果某类生成使用二进制 WebSocket，应通过 CDP 保存帧长度和原始字节，再使用
对应协议库解码；不能假设所有帧都是 JSON。

## 6. 媒体下载测试

第一次直接请求媒体域得到 401。对浏览器实际成功的图片请求比较后发现，关键是：

```http
Referer: https://app.tapnow.ai/
```

正确策略：

1. 主站 JSON API 使用 Bearer token。
2. `files.tapnow.media` 不携带主站 Authorization。
3. 媒体请求单独带主站 Referer。

按此方式，两张原始 JPEG 均成功下载，尺寸均为 2560×2560。

## 7. 浏览器本地存储

观察到：

- `localStorage` 中存在 `access_token`、`refresh_token` 和应用偏好。
- IndexedDB 包含 `TapflowCSVCache`、`TapflowGroupPositionCache`、
  `workbox-expiration`。
- Cache Storage 主要保存应用壳、JS/CSS 和版本资源。
- 本画布没有可用的 OPFS 文件。
- 注册了 TapNow PWA Service Worker 和跟踪相关 Service Worker。

结论：不能只复制 IndexedDB 来备份画布。核心内容来自云端画布 API；
本地数据库主要是 CSV、分组位置和静态资源缓存。

## 8. 版本变化

测试开始时 `version.json` 返回 2.15.3，构建时间为
`2026-09-03T11:16:09.404Z`。测试期间页面提示更新，随后接口返回 2.15.4，
构建时间为 `2026-09-03T14:21:26.757Z`。

这说明私有接口和前端 chunk 会在同一天变化。长期工具必须：

- 避免依赖压缩变量名和固定 chunk hash。
- 优先依赖稳定的 JSON 字段和 URL 路径。
- 对状态码、分页字段和媒体下载失败做显式检查。
- 在每次运行时记录 TapNow 版本。

## 9. 测试清单

| 测试 | 结果 |
| --- | --- |
| 未登录访问目标画布 | 重定向到登录页 |
| Chromium 人工/分步登录 | 成功 |
| 无 Authorization 调用画布 API | 401 |
| 内存中使用 Bearer token 调用画布 API | 200 |
| 导出节点 | 4/4 |
| 导出连线 | 4/4 |
| 捕获 fresh-page 网络事件 | 112 |
| 捕获第一方请求/响应正文 | 19 |
| 下载媒体缩略图/小图 | 成功 |
| 下载两张媒体原图 | 成功 |
| IndexedDB/Cache Storage 枚举 | 成功 |
| WebSocket 捕获 | 本画布未出现 |
| 付费生成 | 未执行 |
| 脱敏单元测试 | 3/3 通过 |
| 脚本语法检查 | 通过 |

注意：新开画布标签页时，TapNow 前端自动发送了两次
`nodes:batchActions` 更新，用于持久化已加载节点的测量/状态数据。
未观察到内容生成、删除或人工编辑，但这意味着“打开页面”不一定严格只读，
可能更新画布的 `updated_at`。

## 10. 合规和风险

TapNow 服务条款（2025-09-01 更新）保留用户对输入和相应输出的权利，也明确
禁止大规模抓取，以及通过未明确授权的自动化方式访问服务。

因此本报告的建议边界是：

- 仅导出本人或已明确授权的画布。
- 低频、单画布、本地备份，不做批量账号或全站抓取。
- 不绕过访问控制、配额、安全机制、水印或内容标识。
- 不公开 token、私有节点正文、媒体 URL、组织 ID 或个人信息。
- 需要生产化、批量化或商业集成时，向 TapNow 获取书面许可或正式 API。

相关官方文件：

- [服务条款](https://www.tapnow.ai/zh/terms-of-service)
- [隐私政策](https://www.tapnow.ai/zh/privacy-policy)
- [生成内容授权说明](https://www.tapnow.ai/zh/generated-content-license)

## 11. 建议实现

推荐保留两层产物：

1. **原始私有备份**：完整 JSON、媒体文件、响应正文，放在加密磁盘或对象存储。
2. **公开审计摘要**：版本、时间、数量、状态码、字段名和哈希，不含内容正文。

导出流程：

```text
手动登录专用 Chromium
  -> CDP 连接本机 9223
  -> 读取内存 access_token
  -> GET canvas/nodes/connections
  -> 收集媒体 URL
  -> 以 Referer 下载媒体
  -> 写入 artifacts/private/
  -> 生成不含正文的 summary.json
```

## 12. Companion 0.1.9 回归

测试日期：2026-09-04（Europe/Berlin）。使用真实 Chrome 151、已登录的
TapNow 页面、真实目标画布和真实构建产物 `.output/chrome-mv3`，未使用 mock
页面作为最终验收。

| 测试 | 结果 |
| --- | --- |
| 真实图像节点识别 | 通过，`image-3512ed6d-7c20-465a-8216-10a087ddb3bb` 正确识别为 `image` |
| 直接入边文字读取 | 通过，真实节点读取 1 项上游文字素材并作为有效审核提示词 |
| 直接入边图片读取 | 通过，真实节点读取 2 项图片素材 |
| 检测前后状态稳定 | 通过，检测期间 TapNow 重渲染不再导致节点、文字或图片归零 |
| 图片原始地址恢复 | 通过，去除 `small/thumbnail` 变体后读取原始媒体，实际发送约 1.18 MB |
| 检测前是否调用 LLM | 通过，`called=false` |
| 点击检测后真实 ACU Responses | 通过，`called=true`，返回结构化审阅结果 |
| 真实双图本地准备 | 通过，2 张图片均已准备并发送 |
| 图片素材对应关系 | 通过，分别标记为 `image-1`/`focused-node-output` 和 `image-2`/`focused-node-reference` |
| 模型图标过滤 | 通过，16×16 UI 图标不计入素材 |
| popup 自定义审阅提示词 | 通过，保存、重载和真实检测回归通过 |
| 多图请求组装 | 通过，自动测试验证多张 data URL 同时发送，未准备图片不发送 |
| 大图处理 | 已实现页面侧和后台侧缩放压缩，单图 8 MB 阈值，按总请求预算发送 |
| 压缩可追溯性 | 通过，开发者信息记录压缩状态、方式、原始/准备字节数、节省字节数和比例 |
| 真实 ACU 2 张图片 | 通过，Responses 成功，约 82 KB 请求体 |
| 真实 ACU 8 张图片 | 通过，Responses 成功，约 327 KB 请求体 |
| 真实 ACU 高分辨率图片 | 通过，5000×5000、8.08 MB JPEG，约 10.78 MB 请求体 |
| 真实生图节点产物边界 | 通过，当前图像节点只读取直接入边 `text-*` 节点的英文生成产物；上游人工提示词和图片节点哈希标题均未进入 prompt、上下文或文字素材 |
| 真实生图节点双图审阅 | 通过，同一真实节点发送 1 项上游英文文字和 2 张图片，返回结构化 `warn` 审阅结果 |
| 浏览器网络异常重试 | 通过，LLM 请求层对一次临时 `Failed to fetch` 自动重试，并保留 endpoint 诊断信息 |

真实图像节点本轮实际读取并发送了 2 张图片；没有为了测试向用户画布永久添加
新素材或超过 8 MB 的新素材。多图路径通过实际请求组装测试验证，12 张小 data
URL 可以同时发送；大图会尝试缩放压缩。当前插件依据 ACU Router 默认 32 MB 解压后请求体限制，设置
28 MB 整体安全预算和 20 MB 图片 data URL 总预算，超出预算的图片会明确标记
为未发送并保留图片元数据。

ACU 随附模型目录将 `gpt-5.6-luna` 等 ACU 模型标为 272,000 tokens 上下文窗口。
插件据此把文字收集预算放宽到约 200,000 字符，同时保留图片 token、JSON schema
和输出空间；字符数不直接等同 token 数。2026-09-04 的真实 ACU 流式请求已验证
新策略使用的 Responses 格式仍可成功审阅真实图片。

0.1.9 新增的文字节点类型过滤、直接入边素材读取、稳定草稿快照、图片编号与此前的“开发者信息”和
Console 诊断包含当前 focus、节点 ID/类型、输入、上下文、文字来源、图片编号、
图片来源节点、图片角色、图片尺寸与准备状态、每张图片是否压缩及压缩前后字节数、
协议、模型、实际请求端点、发送图片数和 LLM 结果摘要；不包含 API Key 或图片 data URL。

仓库中的 `export-canvas.mjs` 已实现该流程，`record-session.mjs` 用于动态请求
记录，`audit-canvas.mjs` 用于未登录基线检查。

## 13. Companion 0.1.10 真实页面回归

测试日期：2026-09-06（Europe/Berlin）。

本轮继续使用真实 Chrome 151、真实 TapNow 页面和真实扩展构建目录，没有使用
Mock 页面或伪造节点数据。当前可访问的真实画布为：

```text
https://app.tapnow.ai/canvas/8b18df2d-7254-4a17-8837-718081d6e7c4
```

### 13.1 三图引用节点

节点 `image-fd8c0be4-1edb-40b3-bd4d-28aff976213f` 的真实 API 数据包含
三个直接入边，提示词引用 `Image 1`、`Image 2`、`Image 3`。插件实际读取并绑定：

```text
Image 1 -> image-dcef2e6e-5535-4768-9f9a-411c783f3fa8 / 正脸证件照
Image 2 -> image-b9b1800d-6e5a-4976-acad-59069f84af73 / 图片生成
Image 3 -> image-c9795845-d673-4c36-971b-d3d888cc42f6 / 穿衣服-正脸
```

三张参考图均成功读取。当前节点还有一张历史产物图，因此本地素材列表共
四项，开发者信息会区分“引用图”和“当前节点产物图”。由于三张参考图已经
占用大部分请求预算，本轮实际发送三张参考图，产物图被预算选择器明确标为
未发送，而不是错误地改名或冒充已发送。

点击“检测”后，真实 ACU Responses 请求返回 HTTP 200，模型能够在结果中正确
引用 `Image 1`、`Image 2`、`Image 3`，并给出结构化质量建议。实际请求体约
16.6 MB，三张图片原始发送数据约 12.5 MB。

### 13.2 当前节点与上游边界

读取规则现在明确分开：

- 当前节点的 `data.prompt` 是当前节点输入。
- 当前节点的 `data.text` 是当前节点生成产物。
- 直接上游 Text 节点只把 `data.text` 放入 `textMaterials`。
- 上游 Text 节点的 `data.prompt` 不会作为本次节点提示词。
- 32 位内部哈希和 UUID 候选值会保留在开发者信息中，但标为忽略，不会作为
  有效提示词发送给 LLM。

这样可以避免页面 DOM 把“上游人工提示词 + 上游生成产物 + 模型控件文本”拼接
成一段内容时污染本次生图审阅。API 可用时以 API 字段为权威，DOM 仅作为
备用来源。

### 13.3 节点关系和透明度

0.1.10 的审阅草稿和开发者信息新增：

- 当前节点完整的稳定 API 数据快照及字段。
- `incoming_nodes`、`incoming_connections`。
- `outgoing_nodes`、`outgoing_connections`。
- 每个提示词候选值、选择结果和忽略原因。
- 每张图片的来源节点、引用编号、角色、原始地址、实际抓取地址、准备状态、
  压缩信息和是否被本次请求选中。

打开面板或点击检测都不会拦截 TapNow 的生成动作；只有点击“检测”才会请求
LLM。已经准备好的图片会在检测时复用，避免重复下载。

### 13.4 引用顺序稳定性修复

真实接口探测发现，`/nodes?include_relations=true` 对同一节点的
`relations[node].incoming` 顺序并不稳定：连续请求会返回不同排列；而画布详情
接口中的 `connections` 顺序保持稳定。0.1.10 已改为：

1. 当前节点 DOM 中存在明确的引用图顺序时，使用 DOM 顺序。
2. 否则使用画布详情接口的 `connections` 顺序。
3. 只有没有可用 connections 时，才把 relations 顺序作为兜底，并在开发者信息
   中标明 `tapnow-api-relations-fallback`。

重载真实 Chrome 后，三图节点 `image-fd8c0be4-1edb-40b3-bd4d-28aff976213f`
的开发者信息显示 `referenceOrderSource: tapnow-api-connections`，并稳定绑定：

```text
Image 1 -> image-dcef2e6e-5535-4768-9f9a-411c783f3fa8 / 正脸证件照
Image 2 -> image-b9b1800d-6e5a-4976-acad-59069f84af73 / 图片生成
Image 3 -> image-c9795845-d673-4c36-971b-d3d888cc42f6 / 穿衣服-正脸
```

### 13.5 回归结果

| 测试 | 结果 |
| --- | --- |
| 真实 API 读取 102 个节点、78 条连线 | 通过 |
| 两图节点引用顺序与来源绑定 | 通过 |
| 三图节点 `Image 1/2/3` 绑定 | 通过 |
| 三图真实图片准备 | 通过 |
| 三图真实 ACU Responses 审阅 | 通过，HTTP 200 |
| 当前节点产物图与引用图区分 | 通过 |
| 上游 Text 的 prompt/text 边界 | 已由 API 字段规则和自动回归覆盖 |
| 32 位哈希不作为有效提示词 | 通过自动回归 |
| 节点数据与出入边透明展示 | 通过，真实页面重载后验证 |
| relations 顺序变化不影响 `Image N` 映射 | 通过，改用稳定 connections 顺序 |
| 单元/协议/重试测试 | 31/31 通过 |
| WXT production build | 通过 |

## 14. 2026-09-07 ACU 卡住问题复原与真实回归

### 14.1 精确关联结果

本次真实 Chrome 检测使用扩展生成的 `X-Client-Request-Id` 做关联，并在本机
`acu-router` PostgreSQL 中核对了 logical request、provider attempt 以及
client response。敏感 ID 不写入公开报告；完整值只保留在页面“开发者信息”和
本机路由日志中。

| 项目 | 结果 |
| --- | --- |
| 真实页面 | `https://app.tapnow.ai/canvas/73c4c63e-4ddd-428b-8f27-5c482f4be03c` |
| 真实节点 | `deefd076-ee2b-4c1b-a629-15ea3481c68d` |
| 当前输入 | 1 项当前节点提示词 |
| 参考图 | 2 项，均已准备并发送 |
| 请求体 | 901,679 字节 |
| ACU logical request | `completed` |
| provider HTTP | 200 |
| 浏览器响应 | `application/json` |
| LLM 结果 | `warn` |
| 端到端耗时 | 58.7 秒 |

这次真实请求没有卡死。ACU 记录显示 provider 成功、没有
`client_cancelled`，最终 client response 已完整保存。

### 14.2 根因

历史 ACU payload 同时出现过两种真实返回形态：

1. `stream:false` 请求收到普通 `application/json`，响应体完整后返回。
2. 同类 Responses 请求收到 `text/event-stream`，并包含
   `response.output_text.done` 和 `response.completed`，但连接 EOF 可能晚于
   终止事件。

旧版插件只在响应头明确为 SSE 时使用 `ReadableStream`；其他情况调用
`response.text()`，这会等待连接 EOF。于是当中间层把 SSE 误标为
`application/json`，或服务端已经发送完整 JSON 但连接未及时关闭时，面板会一直
停留在“正在请求”。

`acu-frontend` 日志中的 `client_gone` / `use of closed network connection`
是另一类真实现象：客户端主动断开后，服务端停止扫描上游流。它们不能直接证明
本次扩展请求失败；本次关联请求的状态是 `completed`，不是 `client_gone`。

### 14.3 修复

- 所有有响应体的请求都按块读取，不再仅由 `Content-Type` 决定读取方式。
- 自动识别普通 JSON、标准 Responses SSE，以及头部误标为 JSON 的 SSE。
- JSON 已经解析成功时立即继续，不等待 EOF。
- 收到 `response.completed`、`response.done`、`response.failed`、`error`
  或 `[DONE]` 后立即结束读取。
- 请求超时、重试和 `AbortController` 仍保留。
- 开发者信息新增响应模式、首字节耗时、终止事件、终止事件耗时、是否等到
  连接关闭以及响应 ID。

### 14.4 真实回归

使用真实 Chrome 151、真实 TapNow 页面、真实图片素材和真实 ACU API 完成：

1. 重新加载生产构建扩展。
2. 聚焦真实图片生成节点。
3. 读取当前节点提示词、两个直接入边图片和来源关系。
4. 等待两张图片完成本地准备。
5. 点击真实“检测”。
6. 收到结构化 `warn` 结果，面板结束等待状态。

本轮真实响应是普通 JSON；自动测试另外覆盖了“不关闭连接的 JSON”和
`Content-Type: application/json` 的 SSE，两种情况均能在终止条件满足后返回。

## 15. 当前验证状态

| 验证 | 结果 |
| --- | --- |
| 自动测试 | 36/36 通过 |
| WXT Chrome MV3 构建 | 通过 |
| `git diff --check` | 通过 |
| 真实 Chrome TapNow 双图检测 | 通过 |
| ACU logical request 关联 | 通过 |
| API Key 写入代码、ZIP、日志、报告 | 未发现 |
