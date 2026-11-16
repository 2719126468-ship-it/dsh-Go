#!/usr/bin/env python3
"""Verify and expose bundled third-party packages as optional DSH plugins."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


_PACKAGE_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")


def _within(root: Path, candidate: Path, label: str) -> Path:
    resolved_root = root.resolve()
    resolved = candidate.resolve()
    if not resolved.is_relative_to(resolved_root):
        raise SystemExit(f"{label} escapes its package directory: {candidate}")
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, help="npm prefix containing the DSH installation")
    parser.add_argument("--manifest", required=True, help="JSON manifest listing exact preinstalled packages")
    args = parser.parse_args()

    prefix = Path(args.prefix)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    packages = manifest.get("packages")
    if not isinstance(packages, list) or not packages:
        raise SystemExit("preinstalled bundle manifest must contain a non-empty packages array")

    names: list[str] = []
    for expected in packages:
        if not isinstance(expected, dict):
            raise SystemExit("invalid package entry in preinstalled bundle manifest")
        name = expected.get("name")
        version = expected.get("version")
        if (
            not isinstance(name, str)
            or len(name) > 214
            or not _PACKAGE_NAME.fullmatch(name)
            or not isinstance(version, str)
            or not version
        ):
            raise SystemExit("each preinstalled package needs a safe npm name and exact version")
        node_modules = prefix / "node_modules"
        package_dir = _within(node_modules, node_modules / name, "package path")
        package_file = _within(package_dir, package_dir / "package.json", "package.json path")
        if not package_file.is_file():
            raise SystemExit(f"preinstalled package not found: {name}")
        package = json.loads(package_file.read_text(encoding="utf-8"))
        if package.get("version") != version:
            raise SystemExit(f"{name} version mismatch: expected {version}, got {package.get('version')}")
        for field in ("license",):
            expected_value = expected.get(field)
            if expected_value is not None and package.get(field) != expected_value:
                raise SystemExit(f"{name} {field} mismatch: expected {expected_value}, got {package.get(field)}")
        expected_node = expected.get("node")
        actual_node = package.get("engines", {}).get("node")
        if expected_node is not None and actual_node != expected_node:
            raise SystemExit(f"{name} Node engine mismatch: expected {expected_node}, got {actual_node}")
        expected_dsh = expected.get("dsh")
        actual_dsh = package.get("engines", {}).get("dsh")
        if expected_dsh is not None and (
            not isinstance(actual_dsh, str) or expected_dsh not in actual_dsh.split(" || ")
        ):
            raise SystemExit(f"{name} DSH engine mismatch: expected {expected_dsh} in {actual_dsh}")
        dsh = package.get("dsh")
        bundle = dsh.get("bundle") if isinstance(dsh, dict) else None
        patch = bundle.get("patch") if isinstance(bundle, dict) else None
        if not isinstance(patch, str) or not patch or Path(patch).is_absolute() or ".." in Path(patch).parts:
            raise SystemExit(f"{name} has an unsafe DSH bundle patch path")
        patch_file = _within(package_dir, package_dir / patch, "bundle patch path")
        if not patch_file.is_file():
            raise SystemExit(f"{name} does not contain its declared DSH bundle patch")
        if name in names:
            raise SystemExit(f"duplicate preinstalled package: {name}")
        names.append(name)

    catalog = prefix / "node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js"
    if not catalog.is_file():
        raise SystemExit(f"DSH optional-bundle catalog not found: {catalog}")

    source = catalog.read_text(encoding="utf-8")
    occurrences = []
    marker = "OPTIONAL_BUNDLES"
    offset = 0
    while True:
        found = source.find(marker, offset)
        if found < 0:
            break
        equals = found + len(marker)
        while equals < len(source) and source[equals].isspace():
            equals += 1
        bracket = equals + 1
        while bracket < len(source) and source[bracket].isspace():
            bracket += 1
        if equals < len(source) and source[equals] == "=" and bracket < len(source) and source[bracket] == "[":
            closing = source.find("]", bracket + 1)
            if closing >= 0:
                occurrences.append((bracket, closing))
        offset = found + len(marker)

    if len(occurrences) != 1:
        raise SystemExit(f"expected one OPTIONAL_BUNDLES array in {catalog}, found {len(occurrences)}")

    opening, closing = occurrences[0]
    body = source[opening + 1:closing]
    additions = [name for name in names if "'" + name + "'" not in body and '"' + name + '"' not in body]
    if additions:
        newline = chr(10)
        separator = "" if not body.strip() or body.rstrip().endswith(",") else ","
        insertion = separator + newline + "".join("  '" + name + "'," + newline for name in additions)
        source = source[:closing] + insertion + source[closing:]
        temporary = catalog.with_suffix(".js.tmp")
        temporary.write_text(source, encoding="utf-8")
        temporary.replace(catalog)

    written = catalog.read_text(encoding="utf-8")
    for name in names:
        if "'" + name + "'" not in written and '"' + name + '"' not in written:
            raise SystemExit(f"preinstalled bundle missing from OPTIONAL_BUNDLES: {name}")

    print("DSH installation optional bundles (disabled until enabled in Plugins): " + ", ".join(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
