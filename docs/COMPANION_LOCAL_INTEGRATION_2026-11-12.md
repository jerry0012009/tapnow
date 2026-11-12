# Companion 0.1.20 本地集成验收

## 范围与对照

沿用 0.1.19 的新旧画布公开结构夹具，不访问 TapNow 或认证站点。
已有 72 项测试覆盖数据解析、审阅规则、LLM 协议、消息 listener 和备份；
已有浏览器回归覆盖新旧路由、初始选择、离屏节点、慢切换与桌面/窄屏。
本轮仅补编辑器重绘、快速 A-B-A 路由、入口重挂载、脚本重新注入与后台处理链。

旧 ZIP `tapnow-companion-0.1.19-chrome.zip` 的构建产物在相同新增夹具上复现：

| 缺陷 | 旧包实际结果 | 用户影响 | 修复 |
| --- | --- | --- | --- |
| 输入框被替换后丢草稿 | 读取 SAVED 提示词而非 REDRAW-LIVE-42 与换行 | 审阅旧提示词 | 从当前选中节点/浮动 workbench 重新查找编辑器 |
| 1 秒内 A-B-A 切换漏检 | 旧异步请求重新打开面板 | 展示已失效检测结果 | 使用 WXT locationchange 即时失效，保留周期检查 |
| host 移除后重挂载未清理 | 单次 pointerdown 触发 2 次 focus 处理 | 重复监听与状态处理 | 每次挂载用 AbortController 清理全局监听 |
| 重新注入未清理旧入口逻辑 | 单次 pointerdown 仍触发 2 次 | 扩展重载后残留监听/定时器 | 接入 WXT invalidation 与受管理 interval |

旧包回归证据：`artifacts/private/companion-compat/old-0.1.19-regressions.json`。
最终候选复跑证据：`artifacts/private/companion-compat/latest-run.json`。
这些文件被 Git 忽略，不含真实账号凭据。

## 三层边界

1. **构建 bundle + 本地 runtime 适配器**：通过。实际 production content script
   与 background bundle 原样执行；Chrome storage/runtime 传输由内存适配器提供，
   虚构 Key 和 fetch 响应验证后台审阅处理、结果返回及单击去重。全部页面请求由
   本地夹具处理，其他网络请求阻断，无计费请求。这不是原生扩展隔离世界或 MV3
   Service Worker 传输验收。
2. **原生 MV3 内容脚本/Service Worker 消息链**：本轮未完成。稳定版原生目录
   加载器未形成可重复加载步骤，尝试已停止。旧 0.1.19 原生夹具记录不能替代新包
   新增路径的原生验收。随后获授权再次在普通用户的新空 profile 中通过标准
   `chrome://extensions` / Load unpacked 选择最终 ZIP 解压目录；180 秒内未获得
   扩展安装项成功信号，测试正常关闭。未使用私有 loadDirectory API、未降低安全
   配置。该结果是当前 UI 加载执行阻碍，不证明所有官方加载路径均不可用。
   `TAPNOW_UI_INSTALL=1` 保留标准 UI 安装等待路径；原生 isolated-world 及 Worker
   断言已准备，但没有执行通过，不能记为原生验收成功。
   再核对 157.0.8103.78 官方源码后，确认普通 Chrome 忽略 `--load-extension`，
   CfT 构建不使用该品牌开关。官方 CfT 稳定版 Linux64 ZIP 已在临时目录解压，
   以 jerry、全新 profile、明确参数尝试受支持的命令行加载最终 0.1.20 扩展。
   浏览器在加载扩展前即报 `No usable sandbox!` 并退出 133；没有执行任何夹具。
   Ubuntu 当前 userns 限制与只覆盖 `/opt/google/chrome/chrome` 的现有规则符合
   [官方 AppArmor 说明](https://chromium.googlesource.com/chromium/src/+/157.0.8103.78/docs/security/apparmor-userns-restrictions.md)。
   未修改 AppArmor/sysctl、SUID 权限或添加 no-sandbox。继续 CfT 原生测试需要
   单独授权固定路径的安全配置方案；不能因该临时路径失败断言 CfT 不支持扩展。
3. **真实账号/真站新旧画布端到端**：未完成，未再次请求被阻断站点。真实登录、
   图片准备、引用顺序、真实节点类型及可选 LLM 审阅仍需独立验收。

## 检查和交付

- `npm test`：72/72 通过。测试入口限制为 `test/*.test.ts test/*.test.mjs`，
  避免并行类型比较时临时 baseline 目录被重复收集（先前出现的 141 不是新增测试）。
- TypeScript 与 HEAD `be4a05d` 使用同一命令、依赖和各自生成的 WXT 声明比较。
  基线与候选均保留 9 条既有错误、没有新增错误；不能宣称完整类型检查通过。
- Companion/Backup 构建通过；新 ZIP 的 5 个文件与构建目录逐字节一致，压缩校验通过。
- 候选 `releases/tapnow-companion-0.1.20-chrome.zip`，SHA-256 见
  `releases/SHA256SUMS.txt`。未发布、未提交 Git、未做视觉美化。

```text
cf4895e5d6fb112b2806387f2e1699b1ef355b05b535efaefb8b69e7d375b758
```
- 测试使用普通用户隔离目录与默认沙箱，不使用 no-sandbox、unsafe SwiftShader
  或 ignore blocklist。Playwright 默认参数整组禁用，避免其自动添加 unsafe 参数。

CfT 来源：GoogleChromeLabs 官方稳定版索引，版本 `157.0.8103.78`，下载地址
`https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/linux64/chrome-linux64.zip`。
加载规则依据：同版本 `chrome/browser/extensions/extension_service.cc` 与
`build/config/chrome_build.gni`，其中 `is_chrome_for_testing` 与
`is_chrome_branded` 明确互斥。并非通过猜测文档 URL 判断支持情况。

本地复现示例（wrapper 必须以现有普通用户启动浏览器，目录由该用户创建；
不引用现有账号 profile）：

```bash
DISPLAY=:92 \
TAPNOW_BROWSER_WRAPPER=/tmp/tapnow-integration-browser.sh \
TAPNOW_TEST_PROFILE=/tmp/tapnow-integration-gCJgEf/profile-final \
TAPNOW_TEST_EXTENSION=/tmp/tapnow-integration-gCJgEf/extension \
TAPNOW_BUNDLE_HARNESS=1 TAPNOW_LIFECYCLE=1 npm run companion:test-compat
```
