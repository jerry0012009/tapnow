# TapNow Companion 0.1.14

最新修复版：[v0.1.14 Windows 试用版](https://github.com/jerry0012009/tapnow/releases/tag/v0.1.14)。

[GitHub Release 与下载](https://github.com/jerry0012009/tapnow/releases/tag/v0.1.14)。
本版标为 Windows 试用预发布版，安装步骤及已知限制见 [版本说明](v0.1.14.md)。

`tapnow-companion-0.1.14-chrome.zip` 是已经构建好的 Chrome 扩展包，普通
试用用户不需要安装 Node.js、npm 或运行任何构建命令。

## 个人安装

1. 下载 `tapnow-companion-0.1.14-chrome.zip`。
2. 解压到一个不会被删除的目录。
3. 打开 Chrome `chrome://extensions`。
4. 开启右上角“开发者模式”。
5. 点击“加载已解压的扩展程序”。
6. 选择解压后的目录。
7. 打开或刷新 TapNow Canvas 页面。

## 资产备份

1. 登录并打开目标 TapNow 画布，点击页面中的“备份”入口。
2. 在独立备份页选择本地目录，确认 Chrome 原生写入授权。
3. 选择已打开的画布并扫描，确认节点、连线、引用与目标数量。
4. 设置本轮新增上限，点击“开始 / 增量补齐”，保持 Chrome 和备份页打开。
5. 单资源失败会记录后继续；再次选择相同目录并扫描可复核、复用和补漏。

备份不依赖 LLM，不压缩原文件。当前支持选择已打开的单画布，尚不是完整的
工作空间枚举产品。真实大画布插件写入、独立文件校验与剩余缺口见
[验收报告](../docs/REAL_BACKUP_TEST_2026-09-08.md)和
[自审计](../docs/SELF_AUDIT_2026-09-08.md)。

可视化查看器是单独的本地 Node.js 服务，不内置在扩展中。
[部署与数据格式](../docs/BACKUP_VIEWER.md)。

既有副驾驶功能继续保留：点击“检测”才会将准备好的输入交给配置的 LLM。

## 重要说明

- 这是个人试用包，不是 Chrome Web Store 安装包。
- LLM 审阅默认关闭。
- API Key 只保存在本机扩展存储，不会上传到本仓库。
- 0.1 支持 OpenAI/ACU HTTPS API 地址。
- 如果扩展更新，需要在 `chrome://extensions` 点击“重新加载”。

普通用户免开发者模式的一键安装，需要将同一个 ZIP 上传到 Chrome Web Store；
本地 `.crx` 不作为普通公开分发方案。
