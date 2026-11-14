---
name: runtime-triage
description: 排查内置 Linux 运行时/容器化引擎（proot、自带 Node、rootfs 解包、插件加载）启动失败。当 App 卡在"安装运行环境"、引擎起不来、插件不显示、或日志里有 proot/ELF/ABI 报错时使用。
# dsh-go:managed
---

# 内置运行时排障

## 先看三层现场

1. **清单**：`assets/runtime/manifest.json`（打进去的那份）——记录 abi、archive 名、sha256、uncompressedBytes、launch.argv/env。
2. **落地状态**：App 私有目录下 `runtime/`（解包后的 rootfs、`lkg.json`、`logs/dsh.log`）。
3. **进程**：`ps -A | grep -E 'proot|node'`；proot 起来但 node 秒退，问题通常在 rootfs 里的 loader 或 ELF 架构。

## 常见根因

| 现象 | 根因 | 处理 |
|---|---|---|
| 解包到一半失败 | 存储不足（需 uncompressed × 1.15） | 清空间，或改分层安装 |
| `Exec format error` | rootfs 里的 ELF 与 APK 的 ABI 不一致 | 校验每个 jniLib 与 rootfs ELF 的 machine 字段 |
| `not found` 但文件在 | 动态 loader 路径不对（32/64 位 loader 混用） | aarch64 用 `ld-linux-aarch64.so.1`，armhf 用 `ld-linux-armhf.so.3` |
| 引擎起、Web 打不开 | 端口被占或 token 未注入 | 换端口、核对启动 env 里的 token |
| 插件装上不出现 | 插件目录/profile 未刷新 | 重启引擎；核对 profile 的 bundle 列表 |
| 老系统上执行私有目录二进制被拒 | API 29+ 的 exec 限制 | targetSdk 降到 28，或把二进制放进 nativeLibraryDir |

## 32 位设备特别注意

- Node 官方只到 v23.11.1 提供 `linux-armv7l`，v24 起没有 32 位 Linux 包。要在 32 位 ARM 上跑 Node 24，只能自编译或改用 Node 22/23。
- 32 位地址空间有限：一个大 rootfs + Node + 插件很容易 OOM，进程会被 LMK 直接杀，日志里表现为无预兆退出。
- 部分 NDK 库只发 `arm64-v8a`；缺 32 位变体时不要硬塞，改用纯 Dart/纯 JS 路径。

## 提取日志

```sh
adb logcat -d | grep -iE 'dsh|proot|node|Abort message|FATAL' | tail -200
```

App 内：设置 → 诊断 → 导出；导出的快照已脱敏，可直接贴进 issue。
