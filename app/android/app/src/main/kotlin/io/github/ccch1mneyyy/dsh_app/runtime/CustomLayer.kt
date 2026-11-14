package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * 定制层：APK 自带的破甲预设、实用技能、预装插件与皮肤资源，在每次引擎启动时写进 rootfs。
 *
 * - `assets/custom/presets/*.yml` → `/opt/dsh-app/custom/presets/master.patch.yml`（按 --patch 加载）
 * - `assets/custom/plugins.zip`   → 解开到 `/opt/dsh-app/custom/plugins/`（按绝对路径加载 index.js）
 * - `assets/custom/skills/<name>/**` → `/root/.dsh/skills/<name>/**`（DSH 直接扫描该目录）
 *
 * 插件打包成 zip 而不是散文件：3 MB 单资产比 285 个小文件在 APK 里更容易被 aapt 处理，
 * 也避免每个文件各占一条 zip 目录项。解压只做一次，用 zip 的 SHA-256 做版本戳。
 *
 * 只在本地引擎的正常启动里挂载（安全模式不挂）。写入失败则本次启动不带定制层，DSH 照常起来。
 */
object CustomLayer {
    const val GUEST_DIR = "/opt/dsh-app/custom"
    const val PRESET_PATCH = "$GUEST_DIR/presets/master.patch.yml"
    const val PLUGIN_PATCH = "$GUEST_DIR/presets/plugins.patch.yml"
    const val SKILLS_ROOT = "/root/.dsh/skills"

    private const val ASSET_DIR = "flutter_assets/assets/custom"
    private const val PLUGINS_ZIP = "$ASSET_DIR/plugins.zip"
    private const val PLUGIN_STAMP = ".dsh-app-layer"

    private const val WEB_PATCH_ARG = "--patch /etc/dsh-app/dsh-web.patch.yml"
    private const val DSH_WEB = "/usr/local/bin/dsh web"

    /** 插件行：绝对路径加载，浏览器半身由包内 package.json 的 dsh.client 声明。 */
    private val PLUGINS = listOf(
        "dsh-our-free-model" to "our-free-model",
    )

    private val PLUGIN_YAML = buildString {
        append("# dsh-app 定制层：插件行。由 App 在每次引擎启动时重写，改动不保留。\n")
        append("- insert:\n")
        for ((dir, id) in PLUGINS) {
            append("    - id: ").append(id).append("\n")
            append("      name: ").append(GUEST_DIR).append("/plugins/").append(dir).append("/index.js\n")
        }
    }

    /** 把定制层挂到 `dsh web` 的 --patch 链尾；[arg] 不是那条启动命令时返回 null。 */
    fun launchArg(arg: String): String? {
        val web = arg.indexOf("$DSH_WEB ")
        if (web < 0 || arg.indexOf("$DSH_WEB ", web + 1) >= 0 || arg.contains("--profile")) return null
        val patch = arg.indexOf(WEB_PATCH_ARG, web)
        val at = if (patch >= 0 && arg.indexOf(WEB_PATCH_ARG, patch + 1) < 0) patch + WEB_PATCH_ARG.length else web + DSH_WEB.length
        return arg.substring(0, at) + " --patch $PRESET_PATCH --patch $PLUGIN_PATCH" + arg.substring(at)
    }

    fun presetFile(rootfs: File) = File(rootfs, PRESET_PATCH.removePrefix("/"))
    fun pluginFile(rootfs: File) = File(rootfs, PLUGIN_PATCH.removePrefix("/"))

    /**
     * 复制预设、解开插件、复制技能，然后写两份 overlay。任何一步失败就删掉 overlay 并返回 false，
     * 让这次启动只用 App 自带的 dsh-web 补丁。
     */
    fun writeFiles(context: Context, rootfs: File): Boolean {
        return try {
            val custom = dir(rootfs, GUEST_DIR)
            val presets = File(custom, "presets").apply { ensureDir(this) }

            val presetNames = context.assets.list("$ASSET_DIR/presets")?.filter { it.endsWith(".yml") }.orEmpty()
            val merged = StringBuilder()
            for (name in presetNames.sorted()) {
                merged.append(context.assets.open("$ASSET_DIR/presets/$name").use { it.readBytes().toString(Charsets.UTF_8) })
                if (!merged.endsWith("\n")) merged.append('\n')
            }
            if (merged.isEmpty()) throw IOException("no bundled preset")
            writeIfChanged(File(presets, "master.patch.yml"), merged.toString().toByteArray())

            val plugins = File(custom, "plugins").apply { ensureDir(this) }
            unzipPlugins(context, plugins)

            copyTree(context, "$ASSET_DIR/skills", dir(rootfs, SKILLS_ROOT))

            writeIfChanged(File(presets, "plugins.patch.yml"), PLUGIN_YAML.toByteArray())
            true
        } catch (_: Exception) {
            presetFile(rootfs).delete()
            pluginFile(rootfs).delete()
            false
        }
    }

    /**
     * 把 plugins.zip 解开到 [target]。zip 的 SHA-256 存在 [PLUGIN_STAMP] 里：内容没变就跳过，
     * 变了才清空重解，避免每次启动都写几百个文件。
     */
    private fun unzipPlugins(context: Context, target: File) {
        val bytes = context.assets.open(PLUGINS_ZIP).use { it.readBytes() }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val stamp = digest.joinToString("") { "%02x".format(it) }
        val stampFile = File(target, PLUGIN_STAMP)
        if (Files.isRegularFile(stampFile.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            stampFile.readText().trim() == stamp
        ) {
            return
        }
        // 版本变了：整目录重来，删除旧的散文件（但不动层目录本身）。
        target.listFiles()?.forEach { it.deleteRecursively() }
        ensureDir(target)
        ZipInputStream(bytes.inputStream().buffered()).use { zip ->
            var count = 0
            while (true) {
                val entry = zip.nextEntry ?: break
                count++
                if (count > MAX_ENTRIES) throw IOException("plugins.zip has too many entries")
                val name = entry.name
                if (name.startsWith("/") || name.contains("..") || name.contains('\\')) {
                    throw IOException("unsafe zip entry: $name")
                }
                val dest = File(target, name)
                if (entry.isDirectory) {
                    ensureDir(dest)
                } else {
                    ensureDir(dest.parentFile ?: target)
                    dest.outputStream().use { out -> zip.copyTo(out, 1 shl 16) }
                }
                zip.closeEntry()
            }
        }
        writeIfChanged(stampFile, stamp.toByteArray())
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

    /** Recursively mirror an APK asset directory. */
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

    /** 只比较普通文件；符号链接/FIFO 一律覆盖。 */
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

    private const val MAX_ENTRIES = 4000
}
