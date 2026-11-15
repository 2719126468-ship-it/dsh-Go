/**
 * 端口占用探测：有东西在监听就退 0，空闲就退 1。
 *
 * 为什么不用 `ss -tln`：这台 Android 设备的 SELinux 策略让 Termux 里的 ss
 * 读不到任何监听套接字（输出永远只有表头），拿它做判断会误判成"端口空闲"，
 * 结果新实例 EADDRINUSE 秒退，请求却被上一个老进程悄悄接走 —— 极难排查。
 * 直接 TCP 连一下是唯一可靠的。
 *
 * 用法: node tools/portcheck.js [port] [host]
 */
import net from "node:net";

const port = Number(process.argv[2] || process.env.PORT || 3081);
const host = process.argv[3] || "127.0.0.1";

const sock = net.connect({ host, port });
const finish = (code) => {
  try { sock.destroy(); } catch { /* 无所谓 */ }
  process.exit(code);
};
sock.setTimeout(1500);
sock.on("connect", () => finish(0));
sock.on("timeout", () => finish(1));
sock.on("error", () => finish(1));
