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

## 12. Companion 0.1.8 回归

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

真实图像节点本轮实际读取并发送了 2 张图片；没有为了测试向用户画布永久添加
新素材或超过 8 MB 的新素材。多图路径通过实际请求组装测试验证，12 张小 data
URL 可以同时发送；大图会尝试缩放压缩。当前插件依据 ACU Router 默认 32 MB 解压后请求体限制，设置
28 MB 整体安全预算和 20 MB 图片 data URL 总预算，超出预算的图片会明确标记
为未发送并保留图片元数据。

ACU 随附模型目录将 `gpt-5.6-luna` 等 ACU 模型标为 272,000 tokens 上下文窗口。
插件据此把文字收集预算放宽到约 200,000 字符，同时保留图片 token、JSON schema
和输出空间；字符数不直接等同 token 数。2026-09-04 的真实 ACU 流式请求已验证
新策略使用的 Responses 格式仍可成功审阅真实图片。

0.1.8 新增的直接入边素材读取、稳定草稿快照、图片编号与此前的“开发者信息”和
Console 诊断包含当前 focus、节点 ID/类型、输入、上下文、文字来源、图片编号、
图片来源节点、图片角色、图片尺寸与准备状态、每张图片是否压缩及压缩前后字节数、
协议、模型、实际请求端点、发送图片数和 LLM 结果摘要；不包含 API Key 或图片 data URL。

仓库中的 `export-canvas.mjs` 已实现该流程，`record-session.mjs` 用于动态请求
记录，`audit-canvas.mjs` 用于未登录基线检查。
