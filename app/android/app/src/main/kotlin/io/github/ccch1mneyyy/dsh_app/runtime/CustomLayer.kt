package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.zip.ZipInputStream

// 定制层：APK 自带的破甲预设、实用技能、预装插件与皮肤资源，在每次引擎启动时写进 rootfs。
//
//   assets/custom/presets/<name>.yml  -> /opt/dsh-app/custom/presets/master.patch.yml（按 --patch 加载）
//   assets/custom/plugins.zip         -> /opt/dsh/node_modules/<pkg>/（按绝对路径加载 index.js）
//   assets/custom/skills/<name>/...   -> /root/.dsh/skills/<name>/（DSH 直接扫描该目录）
//   （另写）/usr/local/bin/xdg-open   -> openExternal 桥的 guest 侧 shim，见 OpenUrlBridge
//
// 插件解进引擎自己的 node_modules：包里的裸 import（@deepseek-ai/cordis、undici 等）沿
// node_modules 上溯才能命中 /opt/dsh/node_modules 里的依赖；旧落点 /opt/dsh-app/custom/plugins
// 在 writeLayer 里一次性清掉。zip 的 SHA-256 存 /opt/dsh-app/custom/plugins.stamp，
// 不放进 node_modules。
//
// 插件打包成 zip 而不是散文件：3 MB 单资产比 285 个小文件在 APK 里更容易被 aapt 处理，
// 也避免每个文件各占一条 zip 目录项。解压只做一次，内容没变就按戳跳过。
//
// 只在本地引擎的正常启动里挂载（安全模式不挂）。写入失败则本次启动不带定制层，DSH 照常起来。
object CustomLayer {
    const val GUEST_DIR = "/opt/dsh-app/custom"
    const val PRESET_PATCH = "$GUEST_DIR/presets/master.patch.yml"
    const val PLUGIN_PATCH = "$GUEST_DIR/presets/plugins.patch.yml"
    const val SKILLS_ROOT = "/root/.dsh/skills"
    /** 引擎的 node_modules（guest 路径）：预装插件解在这里，裸 import 才解析得到 cordis / undici。 */
    const val DSH_NODE_MODULES = "/opt/dsh/node_modules"

    private const val ASSET_DIR = "flutter_assets/assets/custom"
    private const val PLUGINS_ZIP = "$ASSET_DIR/plugins.zip"
    private const val PLUGIN_STAMP = "plugins.stamp"
    private const val MAX_ENTRIES = 4000

    private const val WEB_PATCH_ARG = "--patch /etc/dsh-app/dsh-web.patch.yml"
    private const val DSH_WEB = "/usr/local/bin/dsh web"
    private const val XDG_OPEN_GUEST = "/usr/local/bin/xdg-open"

    // 插件行：绝对路径加载，浏览器半身由包内 package.json 的 dsh.client 声明。
    private val PLUGINS = listOf(
        "dsh-our-free-model" to "our-free-model",
    )

    private val PLUGIN_YAML = buildString {
        appendLine("# dsh-app 定制层：插件行。由 App 在每次引擎启动时重写，改动不保留。")
        appendLine("- insert:")
        for ((dir, id) in PLUGINS) {
            appendLine("    - id: $id")
            appendLine("      name: $DSH_NODE_MODULES/$dir/index.js")
            // APK 拥有的字节不能被插件自更新改写：managed 让 self-updater、公告 feed、热重载收兵。
            appendLine("      config: { distribution: managed }")
        }
    }

    // guest 里没有 xdg-open（ubuntu-base 不带），而 dsh 的 openExternal 非 win32/darwin 一律
    // execFile xdg-open。shim 把合法 http(s) URL 写成一行 JSON 追加进队列文件，App 侧
    // OpenUrlBridge 轮询后用 ACTION_VIEW 打开；非法输入静默 exit 0，不把登录流程卡在
    // openExternal 的失败退出上。URL 按 RFC 3986 不含 " 与反斜杠，直接内插；真混进非法
    // 字符只会得到坏行，消费端丢弃。
    private val XDG_OPEN_SH = listOf(
        "#!/bin/sh",
        "# dsh-app openExternal 桥 —— App 每次启动引擎时重写，改了也会被覆盖。",
        "u=\"\${1:-}\"",
        "case \"\$u\" in http://*|https://*) ;; *) exit 0 ;; esac",
        "[ \"\${#u}\" -le 2048 ] || exit 0",
        "d=" + OpenUrlBridge.GUEST_QUEUE_DIR,
        "mkdir -p \"\$d\" || exit 0",
        "printf '{\"url\":\"%s\"}\n' \"\$u\" >> \"\$d/" + OpenUrlBridge.PENDING + "\"",
    ).joinToString("\n") + "\n"

    // 把定制层挂到 dsh web 的 --patch 链尾；arg 不是那条启动命令时返回 null。
    fun launchArg(arg: String): String? {
        val web = arg.indexOf("$DSH_WEB ")
        if (web < 0 || arg.indexOf("$DSH_WEB ", web + 1) >= 0 || arg.contains("--profile")) return null
        val patch = arg.indexOf(WEB_PATCH_ARG, web)
        val at = if (patch >= 0 && arg.indexOf(WEB_PATCH_ARG, patch + 1) < 0) patch + WEB_PATCH_ARG.length else web + DSH_WEB.length
        return arg.substring(0, at) + " --patch $PRESET_PATCH --patch $PLUGIN_PATCH" + arg.substring(at)
    }

    fun presetFile(rootfs: File) = File(rootfs, PRESET_PATCH.removePrefix("/"))
    fun pluginFile(rootfs: File) = File(rootfs, PLUGIN_PATCH.removePrefix("/"))

    // 读 APK 资产（assets 只在 Android 上有）；文件部分在 writeLayer，JVM 单测直连那里。
    // 任何一步失败就删掉两份 overlay 并返回 false，让这次启动只用 App 自带的 dsh-web 补丁。
    fun writeFiles(context: Context, rootfs: File): Boolean {
        return try {
            val presetNames = context.assets.list("$ASSET_DIR/presets")?.filter { it.endsWith(".yml") }.orEmpty()
            val presets = presetNames.sorted().map { name ->
                context.assets.open("$ASSET_DIR/presets/$name").use { name to it.readBytes() }
            }
            val zip = context.assets.open(PLUGINS_ZIP).use { it.readBytes() }
            writeLayer(rootfs, presets, zip) { dest -> copyTree(context, "$ASSET_DIR/skills", dest) }
            true
        } catch (_: Exception) {
            presetFile(rootfs).delete()
            pluginFile(rootfs).delete()
            false
        }
    }

    /** 文件部分：写预设、把插件解进引擎 node_modules、复制技能、写 overlay 与 xdg-open shim。 */
    internal fun writeLayer(
        rootfs: File,
        presets: List<Pair<String, ByteArray>>,
        pluginsZip: ByteArray,
        copySkills: (File) -> Unit,
    ) {
        val custom = dir(rootfs, GUEST_DIR)
        val presetsDir = File(custom, "presets").apply { ensureDir(this) }

        val merged = StringBuilder()
        for ((_, bytes) in presets) {
            merged.append(bytes.toString(Charsets.UTF_8))
            if (!merged.endsWith("\n")) merged.append("\n")
        }
        if (merged.isEmpty()) throw IOException("no bundled preset")
        writeIfChanged(File(presetsDir, "master.patch.yml"), merged.toString().toByteArray())

        // 一次性清理旧落点（裸 import 在那里解析不到）；只删本层目录，不碰引擎。
        File(custom, "plugins").deleteRecursivelySafely()
        unzipPlugins(pluginsZip, dir(rootfs, DSH_NODE_MODULES), File(custom, PLUGIN_STAMP))

        copySkills(dir(rootfs, SKILLS_ROOT))

        writeIfChanged(File(presetsDir, "plugins.patch.yml"), PLUGIN_YAML.toByteArray())
        writeXdgOpen(rootfs)
    }

    // 把 plugins.zip 解开到 nodeModules/<pkg>。zip 的 SHA-256 存在 stampFile：内容没变就跳过。
    // 目标目录是引擎的 node_modules：版本变化只删 PLUGINS 声明的包目录（整目录清空等于删掉
    // dsh 安装本体），条目顶层名也必须在 PLUGINS 白名单里，防止 zip 覆盖 cordis / dsh。
    internal fun unzipPlugins(bytes: ByteArray, nodeModules: File, stampFile: File) {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val stamp = digest.joinToString("") { "%02x".format(it) }
        if (Files.isRegularFile(stampFile.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            stampFile.readText().trim() == stamp
        ) {
            return
        }
        for ((dir, _) in PLUGINS) File(nodeModules, dir).deleteRecursivelySafely()
        ensureDir(nodeModules)
        ZipInputStream(bytes.inputStream().buffered()).use { zip ->
            var count = 0
            while (true) {
                val entry = zip.nextEntry ?: break
                count++
                if (count > MAX_ENTRIES) throw IOException("plugins.zip has too many entries")
                val name = entry.name
                if (name.startsWith("/") || name.contains("..") || name.contains(92.toChar())) {
                    throw IOException("unsafe zip entry: $name")
                }
                if (PLUGINS.none { name == it.first || name.startsWith(it.first + "/") }) {
                    throw IOException("plugins.zip entry outside the layer: $name")
                }
                val dest = File(nodeModules, name)
                if (entry.isDirectory) {
                    ensureDir(dest)
                } else {
                    ensureDir(dest.parentFile ?: nodeModules)
                    dest.outputStream().use { out -> zip.copyTo(out, 1 shl 16) }
                }
                zip.closeEntry()
            }
        }
        writeIfChanged(stampFile, stamp.toByteArray())
    }

    // openExternal 桥的 guest 侧；见 XDG_OPEN_SH。writeIfChanged 会替换同名符号链接/非普通
    // 文件；proot 下 exec 位仍必要，写完显式置可执行。
    private fun writeXdgOpen(rootfs: File) {
        val target = File(rootfs, XDG_OPEN_GUEST.removePrefix("/"))
        ensureDir(target.parentFile ?: rootfs)
        writeIfChanged(target, XDG_OPEN_SH.toByteArray())
        target.setReadable(true, false)
        target.setExecutable(true, false)
    }

    private fun dir(rootfs: File, guestPath: String): File {
        val target = File(rootfs, guestPath.removePrefix("/"))
        ensureDir(target)
        return target
    }

    private fun ensureDir(target: File) {
        if (Files.isSymbolicLink(target.toPath())) target.delete()
        if (target.isDirectory) return
        if (!target.mkdirs() && !target.isDirectory) throw IOException("could not create ${target.path}")
    }

    // Recursively mirror an APK asset directory.
    private fun copyTree(context: Context, assetDir: String, target: File, depth: Int = 0) {
        if (depth > 12) throw IOException("asset tree too deep: $assetDir")
        ensureDir(target)
        val names = context.assets.list(assetDir) ?: return
        for (name in names) {
            val child = "$assetDir/$name"
            val nested = context.assets.list(child)
            val dest = File(target, name)
            if (!nested.isNullOrEmpty()) {
                copyTree(context, child, dest, depth + 1)
            } else {
                writeIfChanged(dest, context.assets.open(child).use { it.readBytes() })
            }
        }
    }

    // 只比较普通文件；符号链接/FIFO 一律覆盖。
    private fun writeIfChanged(target: File, bytes: ByteArray) {
        if (Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            target.length() == bytes.size.toLong() && target.readBytes().contentEquals(bytes)
        ) {
            return
        }
        if (target.exists() && !Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS)) target.delete()
        val tmp = File(target.parentFile, ".${target.name}.dsh-app-${System.nanoTime()}.tmp")
        try {
            tmp.writeBytes(bytes)
            tmp.setReadable(true, false)
            if (!tmp.renameTo(target)) throw IOException("could not replace ${target.path}")
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}
