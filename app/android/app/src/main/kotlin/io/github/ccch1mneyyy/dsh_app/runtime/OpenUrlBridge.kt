package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import java.io.File
import org.json.JSONObject

/**
 * openExternal 桥：guest（ubuntu-base）里没有 xdg-open，而 dsh 的 openExternal 非 win32/darwin
 * 一律 execFile xdg-open。CustomLayer 在 rootfs 里写一个 shim，把合法 URL 追加进
 * <GUEST_QUEUE_DIR>/pending.ndjson；引擎 RUNNING 且非安全模式期间在这里低频轮询，原子改名后
 * 逐行发 ACTION_VIEW 交给系统浏览器。没有重试和状态机：坏行与发送失败直接丢弃。
 */
object OpenUrlBridge {
    const val GUEST_QUEUE_DIR = "/var/lib/dsh-app/open-urls"
    internal const val PENDING = "pending.ndjson"
    internal const val PROCESSING = "processing.ndjson"
    private const val TICK_MS = 1500L
    private const val MAX_URL = 2048

    @Volatile private var loop: Runnable? = null
    @Volatile private var handler: Handler? = null

    /** 引擎就绪路径上挂：active（RUNNING 且非安全模式）为真的每个 tick 消费一次队列，转假自停。 */
    fun start(context: Context, rootfs: File, active: () -> Boolean) {
        stop()
        val app = context.applicationContext
        val queueDir = File(rootfs, GUEST_QUEUE_DIR.removePrefix("/"))
        val h = Handler(Looper.getMainLooper())
        handler = h
        val tick = object : Runnable {
            override fun run() {
                if (loop !== this) return
                if (!active()) { loop = null; return }
                drain(queueDir) { url ->
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { app.startActivity(intent) }
                }
                h.postDelayed(this, TICK_MS)
            }
        }
        loop = tick
        h.postDelayed(tick, TICK_MS)
    }

    fun stop() {
        val r = loop
        loop = null
        if (r != null) handler?.removeCallbacks(r)
    }

    /** 读取-清空原子：先改名成 processing 再逐行发；坏行与发送失败都丢弃，最后删掉 processing。 */
    internal fun drain(queueDir: File, open: (String) -> Unit) {
        val pending = File(queueDir, PENDING)
        val working = File(queueDir, PROCESSING)
        if (!pending.isFile || !pending.renameTo(working)) return
        try {
            for (line in working.readLines()) {
                val url = runCatching { JSONObject(line).optString("url") }.getOrNull() ?: continue
                if (url.length in 1..MAX_URL && (url.startsWith("http://") || url.startsWith("https://"))) open(url)
            }
        } catch (_: Exception) {
        } finally {
            working.delete()
        }
    }
}
