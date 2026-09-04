# TapNow Companion 0.1.6

`tapnow-companion-0.1.6-chrome.zip` 是已经构建好的 Chrome 扩展包，普通
试用用户不需要安装 Node.js、npm 或运行任何构建命令。

## 个人安装

1. 下载 `tapnow-companion-0.1.6-chrome.zip`。
2. 解压到一个不会被删除的目录。
3. 打开 Chrome `chrome://extensions`。
4. 开启右上角“开发者模式”。
5. 点击“加载已解压的扩展程序”。
6. 选择解压后的目录。
7. 打开或刷新 TapNow Canvas 页面。

第一次试用建议先打开一个 TapNow 节点并让它获得 focus，再点击页面右下角的
“副驾驶”。面板读取当前 focus 节点，并在本地预检图片是否可发送；点击“检测”
才会把可发送图片交给 LLM 审阅。

## 重要说明

- 这是个人试用包，不是 Chrome Web Store 安装包。
- LLM 审阅默认关闭。
- API Key 只保存在本机扩展存储，不会上传到本仓库。
- 0.1 支持 OpenAI/ACU HTTPS API 地址。
- 如果扩展更新，需要在 `chrome://extensions` 点击“重新加载”。

普通用户免开发者模式的一键安装，需要将同一个 ZIP 上传到 Chrome Web Store；
本地 `.crx` 不作为普通公开分发方案。
