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
`releases/tapnow-companion-0.1.0-chrome.zip`，解压后在
`chrome://extensions` 中选择“加载已解压的扩展程序”。完整步骤见
`releases/README.md`。

## 0.1 能做什么

- 在 TapNow Canvas 页面显示运行前审核面板。
- 读取当前页面可见的提示词和少量节点上下文。
- 运行前执行少量本地规则：空提示词、团队禁用词；团队要求词只产生提醒。
- 可选地把当前节点草稿发送给 OpenAI 的 Responses 或 Chat Completions 接口。
- 以固定短提示词请求 JSON 结构化审阅结果。
- 用户确认后重新触发原始运行按钮。

0.1 不调用 TapNow 私有 API，不读取 TapNow Token，不处理 WebSocket/SSE，
也不自动修改提示词。当前只允许 `https://api.openai.com/v1`，API Key
保存在扩展本机的 `storage.local` 中，不会提交到 Git 或同步到 Chrome 账号。

## LLM 设置

点击扩展图标后可以设置：

- `Responses` 或 `Chat Completions`
- 模型名称，默认 `gpt-4o-mini`
- API Base URL，0.1 固定为 `https://api.openai.com/v1`
- API Key

发送给 LLM 的内容只包括：

```json
{
  "canvas_id": "...",
  "node_id": "...",
  "node_type": "...",
  "prompt": "...",
  "upstream_context": "..."
}
```

固定审阅要求在 `utils/llm.ts` 中维护，模型必须返回：

```json
{
  "decision": "allow | warn | block",
  "summary": "...",
  "issues": [],
  "suggestions": []
}
```

个人试用时，`block` 仍保留“强制运行”；团队版再决定是否改成不可绕过。

## 验证

服务器已验证：

- WXT production build
- 原生 Chromium 加载构建产物
- TapNow 匹配页面注入
- 运行按钮被拦截
- 审核面板显示提示词
- 用户点击确认后原始按钮继续执行
- popup 配置页可打开并显示两种 API 协议
- Responses 和 Chat Completions 的真实 HTTP mock 请求、鉴权和结果解析

由于服务器没有真实 OpenAI API Key，未执行真实计费请求。个人试用时应使用
自己的低权限、低额度 API Key；正式团队版建议使用服务端代理，不把长期 Key
放在浏览器扩展中。
