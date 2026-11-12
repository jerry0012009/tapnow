# TapNow Companion 新旧画布兼容排查

日期：2026-11-12。候选版本：0.1.19。尚未完成登录实站验收，不应视为完整兼容保证。

## 已确认的变化与故障

读取 TapNow 当前公开前端构建 `2530e30a3de1fdaeb7e671fad2cd6fd6a620f449` 的
入口、workspace、canvas-v2、GPU runtime 和 endpoints 模块，确认：

- 旧版路由 `/canvas/:canvasId` 仍存在，可通过 `classic=1` 保持经典画布。
- 新版独立画布为 `/p/:canvasId?t=c`；项目内画布为 `/p/:collectionId?c=:canvasId`。
  `/collection/:collectionId` 也是官方路由。单独的项目 URL 不一定是画布。
- 新版通过 `data-canvas-instance`、`data-canvas-active` 缓存多个画布。
- WebGPU 按需挂载 DOM 节点；挂载后的节点仍使用 `.react-flow__node[data-id]` 和
  `.selected`。引用 mention 和连接 handle 也有 `data-id`，不能把它们误认成节点。
- 新版提供节点外的 `data-node-generation-workbench` / `data-generation-input-shell`
  编辑区，不能只依赖提示词输入框的节点祖先。
- 当前官方接口适配同时接受 `data.canvas` 和直接 `data` 画布数据。

旧插件仅在 `/canvas/` 挂载，路由解析只接受旧版路径，取画布 ID 时又使用最后一个
路径片段。因此新版不显示入口，或无法正确启用；即使入口已存在，也可能取到项目 ID。
全页面查询首个选中节点也会读到缓存的旧画布。

## 本次修复

- 副驾驶专用路由解析器兼容以上路径，不改变 Backup 产品的路由与权限范围。
- 节点、选中态、DOM 连线限定在当前画布，切换画布清空旧焦点与快照。
- 优先读取真正的节点 wrapper，忽略 mention / handle 内部 ID。
- 支持浮动提示词编辑区，并优先读取实时草稿；API 内容保留为后备。
- API 提示词与输入框原文不再经过 DOM 装饰文字清理，保留数字、换行和模型名称。
- 同时支持新旧接口响应结构及空画布。
- 打开/检测过程增加画布身份与请求序号校验，旧异步结果不会重新打开已切换的面板。

## 验证结果

- `npm test`：72 项通过，包含新旧路由、响应格式和已有审阅/LLM 协议测试。
- `npm run extension:build`：Companion 与 Backup 构建通过。
- `DISPLAY=:99 npm run companion:test-compat -- releases/tapnow-companion-0.1.19-chrome.zip`：
  原生 Chromium 加载最终候选 ZIP 解压后的实际扩展产物，
  在按公开前端结构建立的模拟页面上验证经典/新版画布、实时草稿、mention ID、
  缓存画布隔离、离屏引用素材、上下游节点、SPA query 切换、GPU 节点卸载、
  异步竞态、项目页禁用入口及桌面/窄屏面板。所有 TapNow 请求均为 GET。
- 浏览器截图保存在被 Git 忽略的 `artifacts/private/companion-compat/`。

## TypeScript 基线对比

基线提交：`be4a05d76e0b781f2bc97f309f9be6da96196d7f`，当前候选：0.1.19。
TypeScript 5.9.3；基线从 Git 归档到临时目录，与候选共享已安装依赖。
两边独立执行 `TAPNOW_EDITION=companion node node_modules/wxt/bin/wxt.mjs prepare`，
避免 WXT 声明中的绝对路径把候选源码带入基线。随后两边执行完全相同的命令：

```bash
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2023,DOM,DOM.Iterable --skipLibCheck .wxt/wxt.d.ts entrypoints/tapnow.content.ts utils/tapnow-dom.ts utils/tapnow-route.ts
```

这与上一轮检查命令一致。两个新增模块在基线提交中不存在，仅在临时基线目录
创建 `export {};` 空模块占位，避免 TS6053 文件不存在干扰既有诊断；候选检查真实
完整模块。两边独立生成的 WXT 声明均指向各自源码。
还用不带这两个显式文件参数的入口依赖检查交叉验证，结果同样为 9 对 9、无新增。
复现比较：`node scripts/check-companion-types-baseline.mjs`。
比较脚本通过仅表示未新增诊断，不代表 TypeScript 检查通过。

| 位置/问题 | 基线位置 | 候选位置 | 诊断数 |
| --- | --- | --- | --- |
| `entrypoints/tapnow.content.ts` 图片元素类型 TS2339 | 526, 532, 533 | 534, 540, 541 | 3 |
| 同文件诊断缺少 model，TS2345 | 1665 | 1681 | 1 |
| 同文件 storage 设置参数，TS2769 | 1794 | 1815 | 1 |
| `utils/limits.ts` role 字段，TS2339 | 66 | 66 | 1 |
| `utils/llm.ts` requestStats 缺失，TS2741 | 413 | 413 | 1 |
| 同文件响应解析类型，TS2740 / TS2345 | 677 | 677 | 2 |

结果：基线 9 条、候选 9 条；新增 0、消失 0。两边 tsc 退出码均为 2，
类型检查仍未通过。完整诊断（含后续多行详情）在忽略行列位置后完全一致。
本次没有引入类型错误，也没有扩展整理既有 LLM 类型问题。
原始日志和机器可读对比位于 `artifacts/private/companion-types/`，不提交 Git。

## 最终候选包

`releases/tapnow-companion-0.1.19-chrome.zip`，仅本地候选，尚未发布。
由 `node scripts/build-editions.mjs zip companion` 生成，打包脚本逐条比较 ZIP
内容与最终构建目录，并确认 manifest 版本与 package 版本一致。
SHA-256 记录在 `releases/SHA256SUMS.txt`。

```text
30d8493d9c131dec03e31ab21591388330b38cc7acdc247f608f1b88b6c2bad3
```

最终包包含 5 个文件，均与最终构建文件逐字节一致；ZIP 压缩数据检查通过，
manifest 版本为 0.1.19。未进行视觉美化。

## 实站阻碍与待验收项

主站 `app.tapnow.ai` 和官网均返回 Vercel Security Checkpoint。
分别用无界面浏览器、本机有界面浏览器和两个已有 TapNow profile 尝试后，
主站均显示 `Failed to verify your browser / Code 21`，尚未到达登录页。
2026-11-12 03:53:58 UTC 再次用有界面 Chromium 复访仍为 Code 21；
该次 HTTP 状态是 200，但正文仍是安全拦截页，不能据此判断登录成功。
未绕过安全验证，没有输入密码，也没有执行付费生成或修改远端画布。
`api.tapnow.ai` 的公开首页与官方 CDN 资源可访问，本次仅用于核对公开前端契约，
未冒充主站登录或将账号凭据转移到其他 origin。

因此，模拟回归通过不能代替真实画布验证。后续需要在可正常访问主站的已登录
Chrome 中加载候选扩展，并完成：

1. 新版独立画布与项目内画布选择文字、图片、视频节点，核对提示词与引用顺序。
2. 同一画布用经典入口打开，核对相同节点得到一致的上下游与引用素材。
3. 切换画布、编辑未保存草稿、缩放至 GPU 节点卸载、重载页面后重复检测。
4. 用用户配置的低额度 LLM Key 验证图片准备及一次可选审阅请求。

候选 ZIP 仅在本地生成，未发布到 GitHub 或生产服务。
