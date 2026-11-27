#!/usr/bin/env python3
"""Unit tests for `rtbuild.py patch-dsh` (strict unified-diff application, per-version pins).

    python3 -I runtime/tests/test_patch_dsh.py
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True   # runtime/lib/__pycache__ is tracked; do not rewrite it
HERE = os.path.dirname(os.path.abspath(__file__))
RTBUILD = os.path.join(HERE, "..", "lib", "rtbuild.py")
spec = importlib.util.spec_from_file_location("rtbuild", RTBUILD)
rtbuild = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rtbuild)

REL = "node_modules/@x/web/lib/index.js"
ORIGINAL = "".join("line %d\n" % i for i in range(1, 41)).replace("line 20\n", "\tif (route) {\n\t\tawait route.handler(req, res);\n\t}\n")
DIFF = """# comment lines before the first header are ignored (Unicode: 中文)
--- a/%s
+++ b/%s
@@ -19,4 +19,5 @@
 line 19
 \tif (route) {
+\t\tif (await guard(req, res)) return;
 \t\tawait route.handler(req, res);
 \t}
@@ -40,1 +41,2 @@
 line 40
+-- a removed-looking added line
""" % (REL, REL)
sha = lambda text: hashlib.sha256(text.encode()).hexdigest()


def read(path):
    with open(path) as f:
        return f.read()


def load(path):
    with open(path) as f:
        return json.load(f)


class PatchDsh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.prefix = os.path.join(self.tmp.name, "prefix")
        self.patches = os.path.join(self.tmp.name, "patches")
        os.makedirs(os.path.join(self.prefix, os.path.dirname(REL)))
        os.makedirs(self.patches)
        self.target = os.path.join(self.prefix, REL)
        with open(self.target, "w") as f:
            f.write(ORIGINAL)
        with open(os.path.join(self.patches, "guard.diff"), "w", encoding="utf-8") as f:
            f.write(DIFF)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *extra):
        return subprocess.run([sys.executable, "-I", RTBUILD, "patch-dsh", "--prefix", self.prefix,
                               "--patches", self.patches, *extra],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C"})

    def test_arm32_internal_loader_fallback(self):
        self.assertEqual(rtbuild.dsh_node_flags("armeabi-v7a"), ["--expose-internals"])
        self.assertEqual(rtbuild.dsh_node_flags("arm64-v8a"), [])
        source = """import { createRequire, isBuiltin } from "node:module";
function internalModules() {
  const addon = createRequire(import.meta.url)("node-addon-require-builtin");
  const esmModule = addon.requireBuiltin("internal/modules/esm/loader");
  const cjsModule = addon.requireBuiltin("internal/modules/cjs/loader");
  const cjsHelpers = addon.requireBuiltin("internal/modules/helpers");
  const esmUtils = addon.requireBuiltin("internal/modules/esm/utils");
  const esmResolve = addon.requireBuiltin("internal/modules/esm/resolve");
}
"""
        patched = rtbuild.patch_arm32_internal_modules_text(source)
        self.assertIn('process.execArgv.includes("--expose-internals")', patched)
        self.assertIn("createRequire(import.meta.url)(moduleId)", patched)
        self.assertIn('createRequire(import.meta.url)("node-addon-require-builtin").requireBuiltin(moduleId)', patched)
        self.assertEqual(patched.count("requireInternal("), 5)
        self.assertNotIn("addon.requireBuiltin", patched)
        self.assertEqual(rtbuild.patch_arm32_internal_modules_text(patched), patched)

        # A marker must not make a partially edited loader look successfully patched.
        damaged = patched.replace(
            'const esmResolve = requireInternal("internal/modules/esm/resolve");',
            'const esmResolve = addon.requireBuiltin("internal/modules/esm/resolve");',
        )
        with self.assertRaisesRegex(ValueError, "marker exists but the transformed loader is incomplete"):
            rtbuild.patch_arm32_internal_modules_text(damaged)

        # Exercise the exact transformed loader with Node's exposed-internals path.
        # The string assertions above alone would not catch a Node-version/API mismatch.
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required to exercise the ARM32 loader fallback")
        runtime_source = patched + "\ninternalModules();\n"
        result = subprocess.run(
            [node, "--expose-internals", "--input-type=module", "-e", runtime_source],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout)

        legacy_source = """import { createRequire } from "node:module";
function internalModules() {
  const require = createRequire(import.meta.url);
  const addon = require("node-addon-require-builtin");
  const esmModule = addon.requireBuiltin("internal/modules/esm/loader");
  const cjsModule = addon.requireBuiltin("internal/modules/cjs/loader");
  const cjsHelpers = addon.requireBuiltin("internal/modules/helpers");
  const esmUtils = addon.requireBuiltin("internal/modules/esm/utils");
  const esmResolve = addon.requireBuiltin("internal/modules/esm/resolve");
}
"""
        legacy_patched = rtbuild.patch_arm32_internal_modules_text(legacy_source)
        self.assertEqual(legacy_patched.count("requireInternal("), 5)
        self.assertNotIn("addon.requireBuiltin", legacy_patched)

    def test_arm32_internal_loader_cli_is_idempotent_and_preserves_mode(self):
        source = """import { createRequire } from "node:module";
function internalModules() {
  const addon = createRequire(import.meta.url)("node-addon-require-builtin");
  const esmModule = addon.requireBuiltin("internal/modules/esm/loader");
  const cjsModule = addon.requireBuiltin("internal/modules/cjs/loader");
  const cjsHelpers = addon.requireBuiltin("internal/modules/helpers");
  const esmUtils = addon.requireBuiltin("internal/modules/esm/utils");
  const esmResolve = addon.requireBuiltin("internal/modules/esm/resolve");
}
"""
        with tempfile.TemporaryDirectory() as prefix:
            target = os.path.join(prefix, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(source)
            os.chmod(target, 0o750)

            def run():
                return subprocess.run(
                    [sys.executable, "-I", RTBUILD, "patch-arm32-internals", "--prefix", prefix],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C"},
                )

            first = run()
            self.assertEqual(first.returncode, 0, first.stdout)
            with open(target, encoding="utf-8") as f:
                patched = f.read()
            self.assertIn("requireInternal", patched)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o750)

            second = run()
            self.assertEqual(second.returncode, 0, second.stdout)
            self.assertIn("already patched", second.stdout)
            with open(target, encoding="utf-8") as f:
                self.assertEqual(f.read(), patched)

    def test_overlay_launcher_flags_are_abi_specific(self):
        with tempfile.TemporaryDirectory() as temp:
            boot_cache = os.path.join(temp, "boot-cache.mjs")
            direct_dir = os.path.join(temp, "direct")
            os.makedirs(direct_dir)
            with open(boot_cache, "wb") as f:
                f.write(b"// test boot cache\n")
            with open(os.path.join(direct_dir, "entry.mjs"), "wb") as f:
                f.write(b"// test direct entry\n")
            old_boot_cache = rtbuild.BOOT_CACHE_SRC
            old_direct_dir = rtbuild.DIRECT_SRC
            try:
                rtbuild.BOOT_CACHE_SRC = boot_cache
                rtbuild.DIRECT_SRC = direct_dir
                arm32 = rtbuild.overlay_entries({}, "armeabi-v7a")
                arm64 = rtbuild.overlay_entries({}, "arm64-v8a")
            finally:
                rtbuild.BOOT_CACHE_SRC = old_boot_cache
                rtbuild.DIRECT_SRC = old_direct_dir
        arm32_shim = arm32["usr/local/bin/dsh"].data.decode()
        arm64_shim = arm64["usr/local/bin/dsh"].data.decode()
        self.assertIn("exec /opt/node/bin/node --expose-internals", arm32_shim)
        self.assertNotIn("exec /opt/node/bin/node --expose-internals", arm64_shim)

    def test_parse_hunks(self):
        files = rtbuild.parse_unified_diff(DIFF)
        self.assertEqual([f[0] for f in files], [REL])
        (old1, new1), (old2, new2) = files[0][1]
        self.assertIn("\t\tif (await guard(req, res)) return;\n", new1)
        self.assertNotIn("guard", old1)
        self.assertEqual(new2, "line 40\n-- a removed-looking added line\n")

    def test_record_then_apply_pinned(self):
        r = self.run_cli("--dsh-version", "1.0.0", "--record")
        self.assertEqual(r.returncode, 0, r.stdout)
        pins = load(os.path.join(self.patches, "pins.json"))
        pin = pins["patches"]["guard.diff"]["1.0.0"][REL]
        self.assertEqual(pin["before"], sha(ORIGINAL))
        patched = read(self.target)
        self.assertEqual(pin["after"], sha(patched))
        self.assertIn("guard(req, res)", patched)
        # idempotent on an already patched tree
        r = self.run_cli("--dsh-version", "1.0.0")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("already patched", r.stdout)
        # a fresh original applies to exactly the pinned result, by replacing the file (hard links survive)
        with open(self.target + ".orig", "w") as f:
            f.write(ORIGINAL)
        os.replace(self.target + ".orig", self.target)
        link = self.target + ".link"
        os.link(self.target, link)
        r = self.run_cli("--dsh-version", "1.0.0", "--out", os.path.join(self.tmp.name, "applied.json"))
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(sha(read(self.target)), pin["after"])
        self.assertEqual(read(link), ORIGINAL)
        self.assertEqual(load(os.path.join(self.tmp.name, "applied.json")), ["guard.diff"])

    def test_unpinned_version_fails(self):
        self.run_cli("--dsh-version", "1.0.0", "--record")
        with open(self.target, "w") as f:
            f.write(ORIGINAL)
        r = self.run_cli("--dsh-version", "1.0.1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no pin for DSH 1.0.1", r.stdout)
        self.assertEqual(read(self.target), ORIGINAL)

    def test_drifted_original_fails(self):
        self.run_cli("--dsh-version", "1.0.0", "--record")
        with open(self.target, "w") as f:
            f.write(ORIGINAL + "// upstream change\n")
        r = self.run_cli("--dsh-version", "1.0.0")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("differs from the vetted", r.stdout)

    def chain_fixture(self, broken=False):
        first = rtbuild.apply_hunks(ORIGINAL, rtbuild.parse_unified_diff(DIFF)[0][1], "first")
        second_diff = "--- a/%s\n+++ b/%s\n@@ -1,1 +1,1 @@\n-line 1\n+later reviewed patch\n" % (REL, REL)
        final = first.replace("line 1\n", "later reviewed patch\n", 1)
        with open(os.path.join(self.patches, "zz-later.diff"), "w") as out:
            out.write(second_diff)
        pins = {"schema": 1, "patches": {
            "guard.diff": {"1.0.0": {REL: {"before": sha(ORIGINAL), "after": sha(first)}}},
            "zz-later.diff": {"1.0.0": {REL: {"before": "0" * 64 if broken else sha(first), "after": sha(final)}}},
        }}
        with open(os.path.join(self.patches, "pins.json"), "w") as out:
            json.dump(pins, out)
        return first, final

    def test_ordered_hash_chain_is_idempotent_at_final_and_intermediate(self):
        first, final = self.chain_fixture()
        for starting in (ORIGINAL, first, final):
            with open(self.target, "w") as out:
                out.write(starting)
            result = self.run_cli("--dsh-version", "1.0.0")
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertEqual(read(self.target), final)

    def test_broken_hash_chain_fails_before_writing_any_file(self):
        self.chain_fixture(broken=True)
        result = self.run_cli("--dsh-version", "1.0.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("broken patch hash chain", result.stdout)
        self.assertEqual(read(self.target), ORIGINAL)

    def test_unknown_hash_is_not_accepted_by_chain_idempotency(self):
        _, final = self.chain_fixture()
        with open(self.target, "w") as out:
            out.write(final + "unexpected modification\n")
        result = self.run_cli("--dsh-version", "1.0.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the vetted", result.stdout)

    def test_record_refuses_ambiguous_or_missing_context(self):
        with open(self.target, "w") as f:
            f.write(ORIGINAL + ORIGINAL)          # every hunk matches twice
        r = self.run_cli("--dsh-version", "2.0.0", "--record")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("matches 2 places", r.stdout)
        with open(self.target, "w") as f:
            f.write(ORIGINAL.replace("await route.handler", "await route.run"))
        r = self.run_cli("--dsh-version", "2.0.0", "--record")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("matches 0 places", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.patches, "pins.json")))

    def test_shipped_patch_parses_against_pins(self):
        shipped = os.path.join(HERE, "..", "patches")
        pins = load(os.path.join(shipped, "pins.json"))
        for name in sorted(n for n in os.listdir(shipped) if n.endswith(".diff")):
            files = rtbuild.parse_unified_diff(read(os.path.join(shipped, name)))
            self.assertTrue(files and all(hunks for _, hunks in files), name)
            for version, by_file in pins["patches"][name].items():
                self.assertEqual(sorted(by_file), sorted(rel for rel, _ in files), (name, version))

    def test_shipped_patch_pins_form_ordered_hash_chains(self):
        shipped = os.path.join(HERE, "..", "patches")
        pins = load(os.path.join(shipped, "pins.json"))["patches"]
        names = sorted(n for n in os.listdir(shipped) if n.endswith(".diff"))
        versions = sorted({
            version
            for patch in pins.values()
            for version in patch
            if version not in {"optional_files", "superseded_files", "superseded_hunks"}
        })
        for version in versions:
            terminal = {}
            for name in names:
                for rel, pin in pins.get(name, {}).get(version, {}).items():
                    if rel in terminal:
                        self.assertEqual(
                            terminal[rel], pin["before"],
                            (name, version, rel, "broken patch hash chain"),
                        )
                    terminal[rel] = pin["after"]

    @unittest.skipUnless(os.environ.get("DSH_FS_LOCAL_ORIGINAL_JS"),
                         "set DSH_FS_LOCAL_ORIGINAL_JS to the unpatched npm package lib/index.js")
    def test_pinned_fs_local_patch_provides_exclusive_create_fallback(self):
        # The current ARM runtime is pinned to DSH 0.2.1-rc.4. Verify the
        # shipped strict patch against that exact upstream source, rather than
        # asserting that the upstream package already contains our patch.
        original_bytes = open(os.environ["DSH_FS_LOCAL_ORIGINAL_JS"], "rb").read()
        original = original_bytes.decode("utf-8")
        version = os.environ["DSH_VERSION"]
        rel = "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js"
        patches = os.path.join(HERE, "..", "patches")
        pins = load(os.path.join(patches, "pins.json"))["patches"]["fs-create-exclusive.diff"][version]
        self.assertEqual(hashlib.sha256(original_bytes).hexdigest(), pins[rel]["before"])
        files = rtbuild.parse_unified_diff(read(os.path.join(patches, "fs-create-exclusive.diff")))
        self.assertEqual([path for path, _ in files], [rel])
        patched = rtbuild.apply_hunks(original, files[0][1], "fs-create-exclusive.diff")
        self.assertIn('["EPERM", "EXDEV", "ENOTSUP", "EMLINK"]', patched)
        self.assertEqual(hashlib.sha256(patched.encode("utf-8")).hexdigest(), pins[rel]["after"])
        self.assertIn(')(absolutePath, "wx", 384)', patched)
        self.assertIn("await handle.sync()", original)
        self.assertIn("await handle.close()", original)



if __name__ == "__main__":
    unittest.main(verbosity=2)
