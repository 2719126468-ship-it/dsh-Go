package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

// writeLayer 是定制层的文件部分（不碰 Android assets）：这里建假 rootfs 直接跑它，验插件落进
// 引擎的 node_modules、overlay 指向那里并带 managed 分发标记、xdg-open shim 可执行、旧落点被清，
// 以及引擎自己的包（cordis / dsh / undici）在任何一步都不被动到。
class CustomLayerTest {
    private val preset = listOf("a-preset.yml" to "# preset\n".toByteArray())

    private fun zipOf(vararg files: Pair<String, String>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            for ((name, text) in files) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(text.toByteArray())
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun rootfs(): Pair<File, File> {
        val root = Files.createTempDirectory("custom-layer-").toFile()
        val modules = File(root, "opt/dsh/node_modules").apply { mkdirs() }
        for (keep in enginePackages) {
            val dir = File(modules, keep).apply { mkdirs() }
            File(dir, "package.json").writeText("{\"name\":\"" + keep + "\"}")
        }
        return root to modules
    }

    private val enginePackages = listOf("@deepseek-ai/cordis", "@deepseek-ai/dsh", "undici")

    private fun pluginZip() = zipOf(
        "dsh-our-free-model/package.json" to "{\"name\":\"dsh-our-free-model\"}\n",
        "dsh-our-free-model/index.js" to "export default function plugin(ctx) {}\n",
        "dsh-our-free-model/vendor/channel-pack/pack.js" to "import 'undici'\n",
    )

    @Test fun pluginLandsInsideTheEngineNodeModules() {
        val (root, modules) = rootfs()
        try {
            CustomLayer.writeLayer(root, preset, pluginZip()) { it.mkdirs() }
            val pkg = File(modules, "dsh-our-free-model")
            assertTrue(File(pkg, "package.json").isFile)
            assertTrue(File(pkg, "index.js").isFile)
            assertTrue(File(pkg, "vendor/channel-pack/pack.js").isFile)
            // 版本戳留在定制层目录里，不混进 node_modules。
            assertTrue(File(root, "opt/dsh-app/custom/plugins.stamp").isFile)
            assertFalse(File(modules, "plugins.stamp").exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun enginePackagesSurviveAVersionChange() {
        val (root, modules) = rootfs()
        try {
            CustomLayer.writeLayer(root, preset, pluginZip()) { it.mkdirs() }
            // 换 zip 内容：只允许重解本层声明的包目录。
            CustomLayer.writeLayer(root, preset, zipOf(
                "dsh-our-free-model/package.json" to "{\"name\":\"dsh-our-free-model\",\"version\":\"2\"}\n",
                "dsh-our-free-model/index.js" to "export const v = 2\n",
            )) { it.mkdirs() }
            assertEquals("export const v = 2", File(modules, "dsh-our-free-model/index.js").readText().trim())
            assertFalse(File(modules, "dsh-our-free-model/vendor").exists())
            for (keep in enginePackages)
                assertTrue(keep + " survived", File(modules, "$keep/package.json").isFile)
        } finally { root.deleteRecursively() }
    }

    @Test fun pluginPatchUsesNewPathAndManagedDistribution() {
        val (root, _) = rootfs()
        try {
            CustomLayer.writeLayer(root, preset, pluginZip()) { it.mkdirs() }
            val yaml = CustomLayer.pluginFile(root).readText()
            assertTrue(yaml, yaml.contains("name: /opt/dsh/node_modules/dsh-our-free-model/index.js"))
            assertTrue(yaml, yaml.contains("config: { distribution: managed }"))
            assertFalse(yaml, yaml.contains("/opt/dsh-app/custom/plugins/"))
            assertTrue(yaml, yaml.contains("- id: our-free-model"))
            assertTrue(CustomLayer.presetFile(root).isFile)
        } finally { root.deleteRecursively() }
    }

    @Test fun oldLandingSiteGoesAndXdgOpenIsAnExecutableSh() {
        val (root, _) = rootfs()
        try {
            // 旧落点带着上次的残留先存在。
            val stale = File(root, "opt/dsh-app/custom/plugins/dsh-our-free-model").apply { mkdirs() }
            File(stale, "index.js").writeText("old")
            CustomLayer.writeLayer(root, preset, pluginZip()) { it.mkdirs() }
            assertFalse(File(root, "opt/dsh-app/custom/plugins").exists())
            val shim = File(root, "usr/local/bin/xdg-open")
            assertTrue(shim.isFile)
            assertTrue(shim.canExecute())
            val sh = shim.readText()
            assertTrue(sh, sh.startsWith("#!/bin/sh"))
            assertTrue(sh, sh.contains("/var/lib/dsh-app/open-urls"))
            assertTrue(sh, sh.contains("pending.ndjson"))
            assertTrue(sh, sh.contains("\u0024{1:-}"))
            assertTrue(sh, sh.contains("-le 2048"))
        } finally { root.deleteRecursively() }
    }

    @Test fun aSymlinkAtTheShimPathGetsReplaced() {
        val (root, _) = rootfs()
        try {
            val bin = File(root, "usr/local/bin").apply { mkdirs() }
            val shim = File(bin, "xdg-open")
            Files.createSymbolicLink(shim.toPath(), File(root, "usr/bin/true").toPath())
            CustomLayer.writeLayer(root, preset, pluginZip()) { it.mkdirs() }
            assertFalse(Files.isSymbolicLink(shim.toPath()))
            assertTrue(shim.isFile && shim.canExecute())
        } finally { root.deleteRecursively() }
    }

    @Test fun zipCannotTouchEnginePackages() {
        val (root, modules) = rootfs()
        try {
            val hostile = zipOf(
                "dsh-our-free-model/index.js" to "ok\n",
                "@deepseek-ai/dsh/lib/bin.js" to "pwned\n",
            )
            var threw = false
            try { CustomLayer.writeLayer(root, preset, hostile) { it.mkdirs() } } catch (_: Exception) { threw = true }
            assertTrue(threw)
            assertEquals("{\"name\":\"@deepseek-ai/dsh\"}", File(modules, "@deepseek-ai/dsh/package.json").readText())
        } finally { root.deleteRecursively() }
    }

    @Test fun unchangedZipIsSkippedByTheStamp() {
        val (root, modules) = rootfs()
        try {
            val bytes = pluginZip()
            CustomLayer.writeLayer(root, preset, bytes) { it.mkdirs() }
            val stamp = File(root, "opt/dsh-app/custom/plugins.stamp").readText()
            val marker = File(modules, "dsh-our-free-model/marker")
            marker.writeText("kept")
            CustomLayer.writeLayer(root, preset, bytes) { it.mkdirs() }
            assertEquals(stamp, File(root, "opt/dsh-app/custom/plugins.stamp").readText())
            assertTrue("unchanged zip must not re-extract", marker.isFile)
        } finally { root.deleteRecursively() }
    }

    @Test fun launchArgStillAppendsBothPatches() {
        val arg = "proot -0 /usr/bin/env node /usr/local/bin/dsh web --patch /etc/dsh-app/dsh-web.patch.yml --port 0"
        val patched = CustomLayer.launchArg(arg)!!
        assertTrue(patched.contains("--patch /opt/dsh-app/custom/presets/master.patch.yml"))
        assertTrue(patched.contains("--patch /opt/dsh-app/custom/presets/plugins.patch.yml"))
        assertNull(CustomLayer.launchArg("proot -0 node /usr/local/bin/dsh web --profile safe"))
    }

    @Test fun bridgeDrainsAtomicallyAndDropsBadLines() {
        val dir = Files.createTempDirectory("open-url-bridge-").toFile()
        try {
            val pending = File(dir, OpenUrlBridge.PENDING)
            pending.writeText(
                "{\"url\":\"https://github.com/login/device\"}\n" +
                    "{\"url\":\"file:///etc/passwd\"}\n" +
                    "not json\n" +
                    "{\"url\":\"http://127.0.0.1:1/x\"}\n" +
                    "{\"url\":\"\"}\n",
            )
            val got = mutableListOf<String>()
            OpenUrlBridge.drain(dir) { got += it }
            assertEquals(listOf("https://github.com/login/device", "http://127.0.0.1:1/x"), got)
            assertFalse(pending.exists())
            assertFalse(File(dir, OpenUrlBridge.PROCESSING).exists())
            OpenUrlBridge.drain(dir) { fail("nothing left") }
        } finally { dir.deleteRecursively() }
    }
}
