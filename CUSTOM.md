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
| 架构 | 新增 `arm32` flavor（armeabi-v7a），带**实验性**本机引擎 | `app/android/app/build.gradle.kts`、`runtime/build-runtime.sh` |
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

## 三个架构

| flavor | ABI | 本机 Linux 引擎 | 用途 |
|---|---|---|---|
| `arm64` | arm64-v8a | 有（Ubuntu 24.04 + Node 24.22.1 + DSH） | Android 10 手机（LYA-AL10 / 鸿蒙 4.0） |
| `arm32` | armeabi-v7a | 有，**实验性**（Debian 12 armhf + Node 23.11.1 armv7l） | Android 8.1 32 位设备（点读笔一类的 MTK 机） |
| `x64` | x86_64 | 有 | 模拟器自测 |

arm32 为什么和别人不一样：DSH 要求 `node >= 24.9`，而 Node 官方自 v24 起**不再提供 32 位 Linux 构建**（最后一个带 `linux-armv7l` 的是 v23.11.1）；Ubuntu 也从来没有 armhf 的基础镜像。所以这一档换成 **Debian 12 (bookworm) armhf + Node v23.11.1**，`runtime/build-runtime.sh armeabi-v7a` 出包，输入钉死如下：

```
基础镜像  debuerreotype dist-arm32v7 bookworm rootfs.tar.gz   sha256 b6d0c47d…8ee097
Node      node-v23.11.1-linux-armv7l.tar.xz                  sha256 4dd49f33…23a554
Python    cpython-3.12.15+20261021-armv7-unknown-linux-gnueabihf  sha256 7a807f31…797422
proot     Termux binary-arm 5.1.107.102 / libtalloc 2.5.0 / libandroid-shmem 0.7
apt 包     deb.debian.org bookworm + bookworm-updates（InRelease 用镜像内 keyring gpgv 验签，
          闭包钉在 runtime/locks/debian-bookworm-armhf.json）
```

**实验性，装机验证前不要当稳定发行。** 已知限制与对应的补丁：

1. `node23-import-meta-main.diff` — Node 23 没有 `import.meta.main`，`bin.js` / `runner.js` 的入口守卫会静默跳过，`dsh web` 根本起不来。补丁把守卫改成 `import.meta.main ?? dshGoIsMainEntry()`；v24 下 `??` 永不触发，arm64/x86_64 行为不变。
2. `node-addon-system-armv7-flock.diff` — npm 不发布 `linux-arm` 的 flock addon（只有 x64/arm64/darwin/android-arm64），`SessionWriteLease.acquire` 会在每次会话写入时抛错。补丁只在 `require.resolve` 失败时回落到 `runtime/flock-fallback/dsh-go-flock.cjs`（O_EXCL 锁文件 + pid + 30s stale 判定）；**addon 包存在但加载失败仍然上抛**，不会把 arm64 的 addon 损坏悄悄降级成文件锁。
3. v23 的实验 API 面未做全量验证（`node:sqlite` v23.4 起免 flag，可用）。构建报告的 `warnings` 里带一条，真机行为才算确认。
4. arm32 只走 proot：`DirectLaunch` 对 `armeabi-v7a` 返回 `unsupportedAbi`（loader 路径直接抛错），tawcroot 同理，界面上这两项显示不可用。

不带引擎的包仍然可用：没有 `runtime/out/armeabi-v7a` 时 `RuntimeManifest.loadOrNull()` → `absent()`（`bundled = false`），`RuntimeController` 的 `install()` / `start()` 直接拒绝并给出理由，Dart 侧 `RootGate` 跳过安装引导，App 退化成远端主机客户端。

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
gh workflow run custom-release.yml --repo <owner>/dsh-Go --ref custom/pojia-free-model-stabilize \
  -f version=1.0.17 -f build_arm64=true -f build_arm32=true

# 本地（先产出 runtime/out；多个 ABI 共用一次生成的 versionCode）
BUILD_NUMBER=$(python3 tooling/build_number.py)
bash runtime/build-runtime.sh arm64-v8a && tooling/build-apk.sh -f arm64 -n "$BUILD_NUMBER"
bash runtime/build-runtime.sh armeabi-v7a && tooling/build-apk.sh -f arm32 -n "$BUILD_NUMBER"   # 实验性
bash runtime/build-runtime.sh x86_64 && tooling/build-apk.sh -f x64 -n "$BUILD_NUMBER"
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
- 不要在没有对应 `runtime/out/<abi>` 的情况下打 release 包：三个 flavor 都会被 `check_runtime_bundle.py` 逐个校验，缺哪个拦哪个。
- arm32 的本机引擎是实验性的：真机验证（`dsh web` 能否起来、会话写入是否被 flock 降级锁卡住、v23 的 API 面）之前，不要在发布说明里把它写成稳定能力。
- 定制发布工作流的 arm32 job 已与 arm64 一样先执行 `bash runtime/build-runtime.sh armeabi-v7a`，再通过 `tooling/build-apk.sh -f arm32` 做运行时 preflight；arm32 仍是实验性本机引擎，不能等同于 arm64 稳定性。双架构 Release 必须两边都成功，不能把缺少本机引擎的 APK 当成完整定制版。
