---
name: apk-sign
description: 构建、签名、校验与分发 Android APK（含 Termux 本机与 GitHub Actions 两条路径）。当用户要给 App 打正式包、换固定签名、做多架构（arm64/arm32）安装包、校验 v1/v2/v3 签名、或排查 INSTALL_FAILED_* 安装失败时使用。
# dsh-go:managed
---

# APK 构建与固定签名

## 何时用

- 要把项目打成可以覆盖安装的正式 APK（不是 debug 签名）。
- 要一次出多个 ABI（arm64-v8a 手机、armeabi-v7a 老设备/点读笔）。
- 系统拒装：`INSTALL_FAILED_UPDATE_INCOMPATIBLE`（签名不一致）、`INSTALL_FAILED_NO_MATCHING_ABIS`（架构不符）、`INSTALL_FAILED_OLDER_SDK`（minSdk 太高）。

## 固定签名（一次生成，永久复用）

```sh
keytool -genkeypair -v -keystore release.jks -storetype PKCS12 \
  -alias app -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=App Name, OU=Owner, O=Owner, L=City, ST=Province, C=CN" \
  -storepass ${STORE_PASS:?} -keypass ${KEY_PASS:?}
```

- 有效期写 36500 天（100 年），避免上架后证书过期。
- 记录 **证书 SHA-256 指纹**，以后每一版都必须一致：
  ```sh
  keytool -list -v -keystore release.jks -storepass "$STORE_PASS" | grep SHA256
  ```
- 密钥库只经 CI secret 注入，绝不进仓库；本地放 `~/keys/`，权限 600。

## Gradle 侧接线

`app/android/key.properties`（不进版本库）：

```properties
storeFile=/abs/path/release.jks
storePassword=...
keyAlias=app
keyPassword=...
```

`build.gradle.kts` 里只在四项齐全时启用 release 签名，三种签名方案全开：

```kotlin
val keyProps = Properties().apply {
    rootProject.file("key.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
signingConfigs {
    if (!keyProps.isEmpty) create("release") {
        storeFile = keyProps.getProperty("storeFile")?.let { file(it) }
        storePassword = keyProps.getProperty("storePassword")
        keyAlias = keyProps.getProperty("keyAlias")
        keyPassword = keyProps.getProperty("keyPassword")
        enableV1Signing = true   // 国内 ROM 的安装器/安全扫描仍读 JAR 签名
        enableV2Signing = true
        enableV3Signing = true
    }
}
```

## 多架构

Gradle product flavor 每 ABI 一条，不要用 `--split-per-abi`（它给 versionCode 加偏移，破坏升级序列）：

```kotlin
flavorDimensions += "abi"
productFlavors {
    create("arm64") { dimension = "abi"; ndk { abiFilters += "arm64-v8a" } }
    create("arm32") { dimension = "abi"; ndk { abiFilters += "armeabi-v7a" } }
    create("x64")   { dimension = "abi"; ndk { abiFilters += "x86_64" } }
}
```

32 位注意点：

- Flutter 支持 `armeabi-v7a`；但 NDK 原生依赖（ONNX、WebRTC 等）必须各自带 `jniLibs/armeabi-v7a`，缺一个链接就失败。
- 32 位进程地址空间只有 ~3–4 GB，跑一个自带 Node runtime 的 App 要按实际内存重新评估。
- 老设备常见 `android:extractNativeLibs` 必须为 `true`（`useLegacyPackaging = true`），否则 `lib*.so` 无法执行。

## 验证（发版前必做）

```sh
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify -v \
  --min-sdk-version 21 --print-certs app-release.apk
```

- v1 / v2 / v3 三项都必须是 `true`。
- 证书主题不得含 `CN=Android Debug`。
- SHA-256 与上一版完全一致；不一致就说明用错了密钥库。
- `sha256sum app-release.apk` 写进 `SHA256SUMS` 随包发布。

## GitHub Actions 出包

自签密钥经 secret 注入、构建后立刻清理，产物用 artifact 上传：

```yaml
- uses: actions/checkout@v4
- run: echo "$KEYSTORE_B64" | base64 -d > android/key.jks
  env: { KEYSTORE_B64: ${{ secrets.KEYSTORE_B64 }} }
- run: flutter build apk --release --flavor arm64 --target-platform android-arm64
  env:
    KEY_STORE_PASSWORD: ${{ secrets.KEY_STORE_PASSWORD }}
    KEY_ALIAS: ${{ secrets.KEY_ALIAS }}
    KEY_PASSWORD: ${{ secrets.KEY_PASSWORD }}
- uses: actions/upload-artifact@v4
  with: { name: apk, path: build/app/outputs/flutter-apk/*.apk }
- if: always()
  run: rm -f android/key.jks
```

## 排错

| 报错 | 原因 | 处理 |
|---|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 与已装版本签名不同 | 同一密钥库重打，或先卸载旧版（会清数据） |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | ABI 不含设备架构 | 出对应 flavor；核对 `Build.SUPPORTED_ABIS` |
| `INSTALL_FAILED_OLDER_SDK` | minSdk 高于设备 | 降 minSdk，或用对应 Android 版本设备 |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | 未签名或被二次修改 | 用 apksigner 重签并 verify |
| 覆盖安装后图标/通知不刷新 | versionCode 未变 | 每次构建递增 versionCode |
