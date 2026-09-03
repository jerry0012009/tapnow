# TapNow Canvas Audit

针对 TapNow Canvas 的可导出性与浏览器请求可观测性验证工具。

本仓库只发布审计脚本和脱敏报告。真实画布 JSON、媒体文件、登录态、
访问令牌和网络响应正文默认写入 `artifacts/private/`，该目录已被
`.gitignore` 排除。

## 结论

- 登录后可以通过画布接口保存节点、连线、画布元数据。
- 节点数据中包含类型、位置、模型参数、提示词、文本结果、媒体 URL 和任务状态。
- 图片原文件可以下载，但 `files.tapnow.media` 要求主站 `Referer`。
- 页面运行时的 `fetch`/XHR 请求和响应正文可以通过 Playwright/CDP 拦截。
- Agent 流式接口和协作接口可以被观察，但本次未执行付费生成，也未在目标画布上观察到 WebSocket。
- TapNow 服务条款限制大规模抓取和未经明确授权的自动化访问。此项目应限定为本人账号、本人画布、低频备份和研究用途。

完整测试过程与证据见 [REPORT.md](REPORT.md)。

完整导出样例见
[examples/canvas-export-TEST-0903](examples/canvas-export-TEST-0903/README.md)。

个人试用的最小 Chrome 副驾驶扩展见
[安装包说明](releases/README.md)：用户下载 ZIP、解压并在 Chrome 扩展页加载，
不需要 Node.js 或 npm。WXT 源码在 `wxt.config.ts`、`entrypoints/` 和
`utils/`，也可以在扩展后台通过 Responses 或 Chat Completions 调用 OpenAI/ACU
审阅当前 focus 节点的文字和可选图片素材；插件不拦截运行请求。

## 环境

- Node.js 22+（WXT 0.21）
- Chrome、Chromium 或 Playwright Chromium
- 一个已登录且有权访问目标画布的 TapNow 账号

安装依赖：

```bash
npm install
```

## 推荐流程

使用独立浏览器配置启动 Chrome，并仅监听本机：

```bash
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --user-data-dir="$PWD/artifacts/private/chrome-profile" \
  "https://app.tapnow.ai/canvas/350073d9-2b5a-4a79-b057-4f9e644c75d4"
```

如果使用 Playwright 自带 Chromium，把 `google-chrome` 换成
`chromium.executablePath()` 对应的可执行文件。请在浏览器里手动登录并处理协议、
验证码或多因素认证，不要把密码写进脚本或 `.env`。

记录一次新标签页的加载过程：

```bash
npm run record -- --fresh-page
```

导出节点、连线、画布元数据及媒体：

```bash
npm run export
```

常用环境变量：

```bash
TAPNOW_CDP_URL=http://127.0.0.1:9223
TAPNOW_CANVAS_ID=350073d9-2b5a-4a79-b057-4f9e644c75d4
TAPNOW_EXPORT_DIR=artifacts/private/my-export
TAPNOW_MAX_ASSETS=100
TAPNOW_MAX_ASSET_BYTES=200000000
```

未登录基线审计：

```bash
npm run audit
```

运行脱敏测试：

```bash
npm test
```

构建 Chrome 扩展：

```bash
npm run extension:build
```

开发模式：

```bash
npm run extension:dev
```

构建完成后，在 Chrome `chrome://extensions` 中开启开发者模式，加载
`.output/chrome-mv3/`。

扩展 popup 可以配置：

- 本地团队要求词和禁用词
- 是否启用副驾驶
- 是否启用 LLM 审阅
- 是否把图片素材发送给 LLM
- `responses` 或 `chat_completions` 协议
- 模型、API Base URL 和 API Key

0.1 支持 `https://api.openai.com` 和 `https://api.acucompute.com`，API Key 存在扩展的本机
`storage.local`，不会写入仓库或同步到 Chrome 账号。正式团队版建议改为自有
后端代理，不把长期 API Key 放在浏览器端。

## 产物

`export-canvas.mjs` 会生成：

- `canvas.json`: 画布元数据及接口返回的节点、连线。
- `nodes.json`: 节点分页结果。
- `connections.json`: 连线分页结果。
- `media/`: 下载成功的媒体原文件。
- `media-manifest.json`: 媒体 URL、状态、文件名、大小和类型。
- `summary.json`: 不含节点正文的汇总。

`record-session.mjs` 会生成：

- `network.json`: document/fetch/XHR 请求清单。
- `body-index.json` 与 `bodies/`: 脱敏后的第一方 API 请求/响应正文。
- `storage.json`: IndexedDB、Cache Storage、OPFS 和 Service Worker 摘要。
- `canvas.png` 与 `page.json`: 页面截图和 DOM 摘要。

## 安全边界

- 不要提交 `artifacts/private/`。
- 不要提交 `.output/` 或 `.wxt/` 构建缓存。
- 不要把 `access_token`、`refresh_token`、Cookie 或浏览器 profile 上传到 Git。
- CDP 端口必须绑定 `127.0.0.1`，不要暴露到公网。
- 导出脚本读取当前浏览器内存中的 token，但不会打印或写入文件。
- 对组织画布、他人内容或批量任务，先取得明确授权。
- 私有接口没有稳定性承诺，TapNow 更新后可能需要调整。

## 官方规则

- [TapNow 服务条款](https://www.tapnow.ai/zh/terms-of-service)
- [TapNow 隐私政策](https://www.tapnow.ai/zh/privacy-policy)
- [生成内容授权说明](https://www.tapnow.ai/zh/generated-content-license)
