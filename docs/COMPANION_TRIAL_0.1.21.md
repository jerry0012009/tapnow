# Companion 0.1.21 试用版

- 默认模型 `gpt-6.1-sol`；LLM 审阅与图片素材发送默认开启，移除设置页的两个勾选项。
- 点击“检测”才向设置的 API 发送节点文字与图片。打开面板仅进行本地图片预检，
  不调用 LLM。LLM 请求可能计费。
- 发布者明确授权将限额试用 Key 内置到发布 ZIP 的编译代码，用户无需填写；
  内置 Key 可以被包接收者提取，并非保密方案。源码不保存真实 Key。
- 首次运行迁移旧版关闭状态与旧默认模型；已有用户 Key、自定义模型保留。
  Key 写入本机 storage.local，不同步到 Chrome 账号。

## 构建

用被 Git 忽略的 JSON 文件提供 `apiKey`，以 `TAPNOW_TRIAL_KEY_FILE` 指定文件路径：

```bash
TAPNOW_TRIAL_KEY_FILE=/path/to/private-key.json node scripts/build-editions.mjs zip companion
TAPNOW_TRIAL_KEY_FILE=/path/to/private-key.json node scripts/check-trial-bundle.mjs
```

真实 Key 仅注入编译产物；带 Key 的 ZIP 写入 `artifacts/private/trial-releases/`，
不会自动写进 Git 跟踪的 `releases/`。经授权后将该 ZIP 作为 GitHub Release 资产发布。
无 Key 构建不会伪造凭据，未配置个人 Key 时会明确报错。

## 验证

- 76/76 项测试通过，包含默认值、新安装试用 Key、升级迁移及保留个人配置。
- 真实后台 production bundle 本地执行：空存储自动取得内置 Key；请求模型为
  `gpt-6.1-sol`，图片 data URL 实际进入请求；启动时无 LLM 调用。
  请求使用内存 fetch 固定响应，不调用真实模型，不产生测试费用，不打印 Key。
- 0.1.21 ZIP 解压后的 bundle 新旧画布、重绘、切换与去重夹具回归通过，
  使用本地 runtime 适配器；不是本版本原生 MV3 重新验收。
- 0.1.20 的原生 MV3 本地验收记录仍有效作为历史证据，但不能替代 0.1.21 的
  默认设置与内置 Key 在用户 PC 的实际试用。
- TypeScript 比较基线 9 条、当前 8 条既有诊断，新增 0；原 storage 参数错误消除。
  完整类型检查仍未通过。
- 未重试 TapNow 安全检查，未进行真实账号或真实模型端到端验证。

安装包 SHA-256：

```text
dbb84fa0860bf46feb739b9fe14cd7d53d0728e5ef78273777041e2529995f14
```
