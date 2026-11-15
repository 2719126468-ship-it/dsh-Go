# AI 浏览器与 DSH-017 B 站媒体接入

## 接入方式

DSH Go 增加两个入口：**AI 浏览器**与**B站媒体**。AI 浏览器提供 ChatGPT、Claude 和普通网址入口；B站媒体通过 WebView 打开用户自己的 DSH-017 服务。

本次不把 DSH-017 的 Flask/Python 服务、curl_cffi、媒体下载依赖或 ScreenClickCapture 中未接入的截屏服务复制进 APK。媒体后端仍运行在用户的 DSH-017 主机上，客户端仅负责访问。这样不会把双份 Python 运行时或 Chromium APK 塞进安装包。

## 配置 DSH-017

在「全部功能 → B站媒体」或 AI 浏览器里的媒体卡片点配置：

1. 填写 DSH-017 的主服务地址，通常为 https://你的域名:8092。
2. 填写 DSH-017 的普通访问 Token。用户名固定为 dsh017；不要使用 admin Token。
3. 保存后打开媒体页。Token 存在 Android Keystore 支持的安全存储中，不写入普通偏好设置。

DSH Go 的 Android 网络策略只允许回环地址 127.0.0.1 / localhost 使用明文 HTTP。局域网或公网主机请配置 HTTPS；不会为了兼容 HTTP 而全局开放明文流量。

## ScreenClickCapture 功能复用

ScreenClickCapture 的可执行入口目前只是 ChatGPT / Claude WebView；其旧 Service.bak 截屏实现并未接入 Android Manifest / Activity 启动流程。DSH Go 已有完整的「手机操控」原生模块，提供屏幕读取、点击、输入和停止控制。因此本接入复用 DSH Go 现有 WebView 与手机操控，不再增加一份重复的 MediaProjection 服务或 sing-box 占位服务。

## B 站搜索与播放器

DSH-017 当前服务端包含 B 站搜索、播放、多 P、收藏、下载等页面。DSH Go 的 WebView 增加了 Android HTML5 自定义全屏视图处理：点击 DSH-017 播放器的横屏全屏操作会进入横屏沉浸式播放，退出或按返回键后恢复应用布局。

搜索结果列表状态恢复、分页快照和服务端搜索缓存属于 DSH-017 服务端改动，见 [DSH-017 PR #58](https://github.com/2719126468-ship-it/dsh017/pull/58)。该 PR 目前仍为 Draft；其 CI 构建已通过，但 Mate 20 Pro / Android 10 手动验收尚未完成。部署的 DSH-017 服务端需包含该 PR 的改动后，返回搜索页才会获得原位置恢复效果。不要把这项待验收的服务端能力误认为已随 DSH Go 客户端自动部署。

## 包体积与依赖边界

- AI 浏览器和媒体页面共用 Flutter 页面与 Android System WebView。
- 不打包 DSH-017 的 Flask/Python 服务、curl_cffi、媒体下载依赖或 Chromium APK。
- 不复制 ScreenClickCapture 中尚未接入 Android 生命周期的截屏服务，也不带入 sing-box JNI 占位服务。
- DSH-017 继续作为独立主机服务运行，客户端只保存服务 URL 和安全凭据并打开其 Web 页面。

## 尚待设备验收

在目标 Android 设备上检查 ChatGPT / Claude 登录、普通网页导航、DSH-017 Basic Auth、B 站搜索返回状态、视频横屏全屏和返回恢复。CI 能确认静态分析与构建检查，不能代替设备验证。
