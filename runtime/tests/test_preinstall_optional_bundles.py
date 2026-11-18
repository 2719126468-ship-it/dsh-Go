#!/usr/bin/env python3
"""Tests for the ARM64 preinstalled optional-bundle verifier/registrar."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "lib" / "preinstall_optional_bundles.py"


class PreinstalledBundles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prefix = self.root / "prefix"
        self.node_modules = self.prefix / "node_modules"
        self.node_modules.mkdir(parents=True)
        self.manifest = self.root / "manifest.json"
        self.catalog = self.node_modules / "@deepseek-ai/dsh-official-bundles/lib/index.js"
        self.catalog.parent.mkdir(parents=True)
        self.catalog.write_text("const OPTIONAL_BUNDLES = [];\n", encoding="utf-8")
        self.packages = [
            {"name": "@liustack/modsearch", "version": "5.10.12", "license": "MIT", "node": ">=22.13"},
            {"name": "dsh-context", "version": "0.84.1", "license": "Apache-2.0",
             "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.2-rc.1"},
        ]
        for item in self.packages:
            package_dir = self.node_modules / item["name"]
            (package_dir / "dist").mkdir(parents=True)
            (package_dir / "dist/bundle.patch").write_text("# reviewed patch\n", encoding="utf-8")
            metadata = {
                "version": item["version"], "license": item["license"],
                "engines": {"node": item["node"]},
                "dsh": {"bundle": {"patch": "dist/bundle.patch"}},
            }
            if "dsh" in item:
                metadata["engines"]["dsh"] = item["dsh"]
            (package_dir / "package.json").write_text(json.dumps(metadata), encoding="utf-8")
        self.write_manifest()

    def tearDown(self):
        self.tmp.cleanup()

    def write_manifest(self):
        self.manifest.write_text(json.dumps({"schema": 1, "packages": self.packages}), encoding="utf-8")

    def run_script(self):
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--prefix", str(self.prefix), "--manifest", str(self.manifest)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def test_registers_exact_optional_packages_and_is_idempotent(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout)
        text = self.catalog.read_text(encoding="utf-8")
        self.assertEqual(text.count("'@liustack/modsearch'"), 1)
        self.assertEqual(text.count("'dsh-context'"), 1)
        self.assertIn("disabled until enabled in Plugins", result.stdout)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.catalog.read_text(encoding="utf-8").count("'dsh-context'"), 1)

    def test_rejects_version_mismatch(self):
        self.packages[0]["version"] = "5.10.11"
        self.write_manifest()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("version mismatch", result.stdout)

    def test_rejects_bundle_patch_path_escape(self):
        package_file = self.node_modules / "@liustack/modsearch/package.json"
        metadata = json.loads(package_file.read_text(encoding="utf-8"))
        metadata["dsh"]["bundle"]["patch"] = "../outside.patch"
        package_file.write_text(json.dumps(metadata), encoding="utf-8")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe DSH bundle patch path", result.stdout)

    def test_rejects_package_symlink_escape(self):
        package_dir = self.node_modules / "dsh-context"
        outside = self.root / "outside"
        outside.mkdir()
        package_dir.rename(self.node_modules / "dsh-context-real")
        package_dir.symlink_to(outside, target_is_directory=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("escapes its package directory", result.stdout)


if __name__ == "__main__":
    unittest.main()
