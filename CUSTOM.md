# DSH Go 定制版（YG 私有构建）

基于上游 [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go)（22k★，Flutter + 内置 Ubuntu/Node/proot 运行时）。
本分支只加"开包即用"的东西，不改上游任何安全模型、不删检查项。

## 加了什么

| 层 | 内容 | 落地位置 |
|---|---|---|
| 破甲预设 | `pojia`（破甲模式）：persona 内核 + 18 行工具面（bash/fs/子代理/ptc 工作流/ralph/web/cron…） | `app/assets/custom/presets/pojia.patch.yml` |
| 实用技能 | `apk-sign`、`dev-loop`、`runtime-triage`、`phone-control` | `app/assets/custom/skills/<name>/SKILL.md` |
| 插件 | `dsh-our-free-model` 2.8.0（去掉 win32 引擎与 .git，9.6 MB） | `app/assets/custom/plugins/dsh-our-free-model/` |
| 皮肤 | 朱砂 / 柚绿 / 深海 三套新配色（OKLCH 推导，对比度全部过 WCAG） | `app/lib/ui/theme/accent.dart` |
| 架构 | 新增 `arm32` flavor（armeabi-v7a） | `app/android/app/build.gradle.kts` |
| 签名 | 固定密钥库经 CI secret 注入，v1/v2/v3 全开 | `.github/workflows/custom-release.yml` |

## 定制层怎么生效

`runtime/CustomLayer.kt` 在**每次引擎启动**时把 APK 里的 `assets/custom/**` 写进 rootfs：

```
assets/custom/presets/*.yml   → /opt/dsh-app/custom/presets/master.patch.yml
assets/custom/plugins/<pkg>/  → /opt/dsh-app/custom/plugins/<pkg>/
assets/custom/skills/<name>/  → /root/.dsh/skills/<name>/
```

然后往 `dsh web` 的 `--patch` 链尾追加两份 overlay：

```
--patch /etc/dsh-app/dsh-web.patch.yml --patch /opt/dsh-app/custom/presets/master.patch.yml --patch /opt/dsh-app/custom/presets/plugins.patch.yml
```

- **只在正常启动挂载**，安全模式（safe mode）不挂，排查问题时行为与上游一致。
- 写入失败就整层跳过，DSH 照常起来（只在日志里留一行），不会因为定制层把引擎拖死。
- 只在内容变化时重写文件，不是每次启动都碰磁盘。
- 插件按绝对路径加载，浏览器半身由包内 `package.json` 的 `dsh.client` 声明。

## 两个架构

| flavor | ABI | 本机 Linux 引擎 | 用途 |
|---|---|---|---|
| `arm64` | arm64-v8a | 有（完整 ununtu+node+dsh） | Android 10 手机（LYA-AL10 / 鸿蒙 4.0） |
| `arm32` | armeabi-v7a | **无** | Android 8.1 32 位设备（点读笔一类的 MTK 机） |
| `x64` | x86_64 | 有 | 模拟器自测 |

arm32 不带引擎的原因：DSH 要求 `node >= 24.9`，而 Node 官方自 v24 起**不再提供 32 位 Linux 构建**（最后一个是 v23.11.1）。硬塞只会得到一个永远起不来的引擎，所以这一档按"远端主机客户端"发：登录、会话、插件市场、皮肤、手机控制全在，只是不显示"安装本机运行环境"。

Kotlin 侧对应 `RuntimeManifest.loadOrNull()` → `absent()`（`bundled = false`），`RuntimeController` 的 `install()` / `start()` 直接拒绝并给出理由，Dart 侧 `RootGate` 跳过安装引导。

## 签名

密钥库 `~/keys/dshgo-release.jks`（PKCS12→JKS，RSA 4096，100 年）：

```
Alias : dshgo
SHA-256: 25:01:E2:5F:C2:5F:D7:3B:AA:F3:87:0D:B4:88:5E:48:61:36:C1:75:FC:73:98:31:ED:FE:1F:B2:A1:BC:34:44
```

CI 用四个 secret 注入：`KEYSTORE_B64`、`KEY_STORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`。
构建完成立刻删掉 `key.properties` 与落到临时目录的密钥库，产物只留 APK。

每一次构建都校验：

```
apksigner verify -v --min-sdk-version 21 --print-certs <apk>
```

v1 / v2 / v3 三项必须为 `true`，证书主题不得含 `CN=Android Debug`。

## 出包

```sh
# GitHub Actions（推荐）
gh workflow run custom-release.yml --repo <owner>/dsh-Go --ref custom/pojia-free-model \
  -f version=1.0.16 -f build_arm64=true -f build_arm32=true

# 本地（Termux，需先产出 runtime/out）
tooling/build-apk.sh -f arm64
tooling/build-apk.sh -f arm32
```

本地构建要签名，把 `app/android/key.properties` 指向密钥库即可（不进版本库）。

## 鸿蒙 4.0 适配

上游已经处理了 HarmonyOS/EMUI 的差异（`brandHuaweiOs`、受限权限引导页、后台保活白名单）。本分支在此之上：

- targetSdk 保持 28（与 Termux 一致），避免 API 29+ 对私有目录 exec 的限制 —— 内置 rootfs 里的 ELF 全靠这条。
- `useLegacyPackaging = true`：`libproot.so` 等必须解压到 nativeLibraryDir 才能执行。
- 切到后台被杀：设置 → 后台运行 里有华为/荣耀专用引导（悬浮窗、无障碍、电池优化白名单）。

## 不要做的事

- 不要把 `key.properties` 或 `.jks` 提交进仓库。
- 不要改 `versionCode` 生成规则（构建分钟编码），否则覆盖安装会变成降级。
- 不要在没有 `runtime/out` 的情况下打 arm64 包（`check_runtime_bundle.py` 会拦）。
