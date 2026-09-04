# TapNow Companion WXT

扩展源码已迁移到仓库根目录的 WXT 入口：

- `wxt.config.ts`
- `entrypoints/`
- `utils/`

构建：

```bash
npm run extension:build
```

然后在 Chrome `chrome://extensions` 中开启开发者模式，加载
`.output/chrome-mv3/`。

普通试用用户不需要构建源码，直接使用
`releases/tapnow-companion-0.1.7-chrome.zip`，解压后在
`chrome://extensions` 中选择“加载已解压的扩展程序”。完整步骤见
`releases/README.md`。

## 0.1 能做什么

- 在 TapNow Canvas 页面显示常驻、可拖动的副驾驶按钮。
- 只读取用户最近 focus 的节点，不拦截运行/生成按钮。
- 打开面板时在本地预检图片并显示“可发送图片”数量，不调用 LLM。
- 点击“检测”后执行少量本地规则：空提示词、团队禁用词；团队要求词只产生提醒。
- 可选地把当前节点草稿发送给 OpenAI 的 Responses 或 Chat Completions 接口。
- 可选地把当前节点中的图片转换为 data URL 后随检测请求发送；跨域媒体由扩展后台按
  TapNow 媒体域名和主站 Referer 规则抓取。图片不再按 4 张硬截断，而按总请求预算
  选择，超出预算的图片会显示为未发送。
- 以配置页中的可编辑短提示词请求 JSON 结构化审阅结果。
- 面板的“开发者信息”和 Console 会显示当前 focus、节点类型、输入、图片准备状态、
  LLM 协议/模型和结果摘要，不包含 API Key 或图片 data URL；每张已准备图片还会记录
  是否压缩、压缩方式、原始字节数、发送字节数和压缩比例。
- Responses 请求显式使用流式协议，并解析 ACU 返回的 Responses SSE 事件。

0.1 不调用 TapNow 私有 API，不读取 TapNow Token，不处理 TapNow 的
WebSocket/SSE，也不拦截或修改 TapNow 的运行请求。当前允许 OpenAI/ACU HTTPS
API，API Key 保存在扩展本机的 `storage.local` 中，不会提交到 Git 或同步到
Chrome 账号。

## LLM 设置

点击扩展图标后可以设置：

- `Responses` 或 `Chat Completions`
- 模型名称，默认 `gpt-5.6-luna`
- API Base URL，默认 `https://api.acucompute.com/v1`，也可填写 OpenAI 地址
- API Key

点击“检测”后发送给 LLM 的内容只包括：

```json
{
  "canvas_id": "...",
  "node_id": "...",
  "node_type": "...",
  "prompt": "...",
  "upstream_context": "...",
  "text_materials": [],
  "image_materials": []
}
```

容量策略：

- ACU 模型目录标注的上下文窗口：272,000 tokens。
- 节点文字总预算：约 200,000 字符；单个输入字段最多约 120,000 字符。
- LLM 审阅提示词最多 20,000 字符。
- 图片素材最多收集 32 项；实际发送按 20,000,000 个 data URL 字符总预算，
  单图原始数据超过 8 MB 会先尝试压缩。
- 整体 JSON 请求体最多约 28 MB，为 ACU Router 默认 32 MB 解压后限制预留余量。

这些是发送前的客户端预算，不代表所有上游模型都接受同样的图片分辨率或图片
token 数。面板开发者信息会显示文字实际纳入量、准备图片数、实际发送图片数、
图片字节数和请求体大小。

固定审阅要求在 `utils/llm.ts` 中维护，模型必须返回：

```json
{
  "decision": "allow | warn | block",
  "summary": "...",
  "issues": [],
  "suggestions": []
}
```

个人试用时，`block` 只作为审阅结果展示，不会阻止或修改 TapNow 的运行。

## 验证

服务器已验证：

- WXT production build
- 原生 Chromium 加载构建产物
- TapNow 匹配页面注入
- 常驻副驾驶按钮可显示并拖动
- 审核面板显示当前 focus 节点的提示词和素材
- 点击“检测”后执行本地规则和可选 LLM 审阅
- popup 配置页可打开并显示两种 API 协议
- 真实 TapNow 画布、真实节点 focus 和真实图片素材
- ACU Responses 连续 5 次真实 SSE 请求与解析
- ACU Chat Completions 真实 JSON 请求与解析

实际 ACU/OpenAI 计费请求需要在本机 popup 中配置自己的 API Key。个人试用时
应使用低权限、低额度 API Key；正式团队版建议使用服务端代理，不把长期 Key
放在浏览器扩展中。
