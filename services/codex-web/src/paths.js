/**
 * 工作目录守卫：把前端/接口给的 cwd 收敛到允许的根（默认 $HOME）之下。
 *
 * 为什么不能只做字符串前缀比较：
 * 旧实现是 `p.startsWith(WORKDIR + sep)`。`resolve()` 只能折叠 `..`，管不了软链接，
 * 所以 `$HOME/storage`（Termux 里指向 /storage/emulated/0 的软链）、或者
 * `$HOME/anything -> /` 这种，字符串上看着在 $HOME 之下，实际打开的是外面。
 * 现在一律先 realpath 拿到真实路径，再用 path.relative 判断是否真的在根里面。
 *
 * 不存在的路径（比如刚准备新建的目录、被删掉的最近使用项）也要能判：
 * 向上找到最近一个存在的祖先，realpath 祖先，再把剩下的段拼回去，
 * 这样"祖先是不是软链、软链指向哪"依然参与判断，逃逸照样会被拦。
 *
 * 用法:
 *   const normalizeCwd = createCwdGuard(WORKDIR);
 *   const realRoot = await normalizeCwd.realRoot();
 *   const got = await normalizeCwd("/data/data/com.termux/files/home/codex");
 *   // → { ok: true, path: "<真实路径>", exists: true } | { ok: false, error: "..." }
 */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

/** `..` 只按路径段来判断：`..foo` 这种正常名字不能被误伤。 */
function hasParentSegment(input) {
  return input.split(/[\\/]+/).includes("..");
}

/** 拿不到真实路径（不存在、权限不够）就返回 null。 */
export async function realpathOrNull(p) {
  try { return await realpath(p); } catch { return null; }
}

/**
 * 判定 realTarget 是否真的在 realRoot 之下（两者都必须是已解析的真实路径）。
 * 用 path.relative：rel 不能以 `..` 开头、不能是绝对路径、为空表示就是根本身。
 * 列目录时判断条目软链指向哪，也复用这一条，避免两处判定跑偏。
 */
export function withinRoot(realRoot, realTarget) {
  const rel = relative(realRoot, realTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * @param {string} root 允许的根目录（通常是 $HOME）
 */
export function createCwdGuard(root) {
  const fallbackRoot = resolvePath(root);
  /** 根自己也要 realpath：根是软链时，比较基准必须是它指向的真实目录。 */
  let rootPromise = null;
  const realRoot = () => {
    if (!rootPromise) rootPromise = realpathOrNull(fallbackRoot).then((r) => r || fallbackRoot);
    return rootPromise;
  };

  const guard = async (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "路径为空" };
    const input = raw.trim();
    if (input.includes("\0")) return { ok: false, error: "路径不合法" };
    // realpath 之前先挡住 `..`：不靠折叠来兜底，语义更明确。
    if (hasParentSegment(input)) return { ok: false, error: "路径里不能出现 .." };

    const abs = resolvePath(input);
    const realRootPath = await realRoot();

    // 存在的直接取真实路径；不存在的向上找最近存在祖先，realpath 后拼回剩余段。
    let realPath = await realpathOrNull(abs);
    const exists = realPath !== null;
    if (!exists) {
      let cur = abs;
      const rest = [];
      let ancestor = null;
      for (;;) {
        const parent = dirname(cur);
        if (parent === cur) break;          // 一路到文件系统根都没找到
        rest.unshift(basename(cur));
        cur = parent;
        ancestor = await realpathOrNull(cur);
        if (ancestor) break;
      }
      realPath = ancestor ? resolvePath(ancestor, ...rest) : abs;
    }

    // 真实路径必须落在真实根之下（判定规则见 withinRoot）。
    if (!withinRoot(realRootPath, realPath)) {
      return { ok: false, error: `只能在工作目录 ${root} 之下选择目录` };
    }

    if (exists) {
      let st;
      try { st = await stat(realPath); } catch { return { ok: false, error: "目录不存在" }; }
      if (!st.isDirectory()) return { ok: false, error: "不是一个目录" };
    }
    return { ok: true, path: realPath, exists };
  };

  guard.realRoot = realRoot;
  return guard;
}
