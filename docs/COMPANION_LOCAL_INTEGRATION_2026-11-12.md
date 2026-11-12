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
2. **原生 MV3 内容脚本/Service Worker 消息链**：2026-11-12 11:07:58 UTC
   通过。官方 CfT 157.0.8103.78 使用受支持的 `--load-extension` 加载最终
   0.1.20 ZIP 原样解压目录。真实 Chrome 隔离世界有扩展 runtime，页面主世界
   没有 sendMessage；实际 Companion Worker 的 manifest 名称与版本匹配。
   检测、host 重挂载后检测、隔离世界重新注入后检测，后台 fetch 累计数严格为
   1、2、3，面板均收到固定审阅结果；focus 处理每次为 1，host 保持唯一。
   没有 runtime 适配器。仅 Worker 的 fetch 被替换为拒绝其他 URL 的固定 LLM
   JSON 响应，API Key 为虚构值；因此验证原生消息传输而非真实模型服务。
   普通用户 jerry 的新空 profile，无旧登录数据，其他页面网络全部拦截。
3. **真实账号/真站新旧画布端到端**：未完成，未再次请求被阻断站点。真实登录、
   图片准备、引用顺序、真实节点类型及可选 LLM 审阅仍需独立验收。

## 检查和交付

- `npm test`：72/72 通过。测试入口限制为 `test/*.test.ts test/*.test.mjs`，
  避免并行类型比较时临时 baseline 目录被重复收集（先前出现的 141 不是新增测试）。
- TypeScript 与 HEAD `be4a05d` 使用同一命令、依赖和各自生成的 WXT 声明比较。
  基线与候选均保留 9 条既有错误、没有新增错误；不能宣称完整类型检查通过。
- Companion/Backup 构建通过；新 ZIP 的 5 个文件与构建目录逐字节一致，压缩校验通过。
- 候选 `releases/tapnow-companion-0.1.20-chrome.zip`，SHA-256 见
  `releases/SHA256SUMS.txt`。包与代码已提交推送；未发布 GitHub Release、未做视觉美化。

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

## 授权沙箱准备与回收

前次正式 Chrome UI 未完成安装；CfT 临时路径首次启动报 `No usable sandbox!`。
随后经用户明确确认，仅为以下 root:root 固定安装路径新增精确 userns 规则：
`/opt/google/chrome-for-testing/157.0.8103.78/chrome-linux64/chrome`。
软件树无 group/other 写权限、无 SUID/SGID、无符号链接；新规则为
`/etc/apparmor.d/tapnow-cft157`，profile 名 `tapnow-cft157`，内容为：

```apparmor
abi <abi/4.0>,
include <tunables/global>
profile tapnow-cft157 /opt/google/chrome-for-testing/157.0.8103.78/chrome-linux64/chrome flags=(unconfined) {
  userns,
}
```

这是按路径允许创建 user namespace，不是关闭 Chromium 沙箱；该 AppArmor profile
自身为 unconfined，不提供文件/网络限制。实测标签 `tapnow-cft157 (unconfined)`、
UID 1000、chrome://sandbox 报 adequately sandboxed，renderer Seccomp=2、
NoNewPrivs=1。无 no-sandbox、unsafe SwiftShader 或 ignore-blocklist 参数。
规则依据：[Chromium 官方 AppArmor 文档](https://chromium.googlesource.com/chromium/src/+/157.0.8103.78/docs/security/apparmor-userns-restrictions.md)。

测试结束后进程正常退出；新增规则已卸载并删除，本次 CfT 固定安装目录已移除。
全局 `apparmor_restrict_unprivileged_userns` 仍为 1；原 Chrome 规则 SHA-256
前后均为 `9da127c4af5d1639aa4102387a29a04548299a832c5f9e803a6b0c2cfb79ef76`。
原浏览器、下载包、测试记录均保留。非秘密验收与回收摘要见
[原生验收记录](COMPANION_NATIVE_MV3_2026-11-12.json)。

本轮没有生产代码缺陷或包变更；只修正测试从所有 Worker 中误选 Chrome 内置
组件 Worker（版本 1.2）的问题，改按扩展名称及版本精确选择 Companion。
原生复跑需要重新取得同等限定安全配置授权，不能直接把已删除的固定路径当成
可运行前提，也不能因新包已通过本地原生验收就访问被阻断真站。

本地复现示例（wrapper 必须以现有普通用户启动浏览器，目录由该用户创建；
不引用现有账号 profile）：

```bash
DISPLAY=:92 \
TAPNOW_BROWSER_WRAPPER=/tmp/tapnow-integration-browser.sh \
TAPNOW_TEST_PROFILE=/tmp/tapnow-integration-gCJgEf/profile-final \
TAPNOW_TEST_EXTENSION=/tmp/tapnow-integration-gCJgEf/extension \
TAPNOW_BUNDLE_HARNESS=1 TAPNOW_LIFECYCLE=1 npm run companion:test-compat
```
