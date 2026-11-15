#!/usr/bin/env python3
"""Expose selected, installation-provided third-party bundles as optional DSH plugins."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, help="npm prefix containing node_modules/@deepseek-ai/dsh-official-bundles")
    parser.add_argument("--manifest", required=True, help="JSON manifest listing exact preinstalled package names")
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    packages = manifest.get("packages")
    if not isinstance(packages, list) or not packages:
        raise SystemExit("preinstalled bundle manifest must contain a non-empty packages array")

    names: list[str] = []
    for package in packages:
        if not isinstance(package, dict):
            raise SystemExit("invalid package entry in preinstalled bundle manifest")
        name = package.get("name")
        version = package.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            raise SystemExit("each preinstalled package needs an exact name and version")
        if not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", name):
            raise SystemExit(f"invalid npm package name: {name}")
        names.append(name)

    catalog = Path(args.prefix) / "node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js"
    if not catalog.is_file():
        raise SystemExit(f"DSH optional-bundle catalog not found: {catalog}")

    source = catalog.read_text(encoding="utf-8")
    pattern = re.compile(r"OPTIONAL_BUNDLES\\s*=\\s*\\[(?P<body>.*?)\\]", re.S)
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise SystemExit(f"expected one OPTIONAL_BUNDLES array in {catalog}, found {len(matches)}")

    match = matches[0]
    body = match.group("body")
    additions = [name for name in names if not re.search(rf"['\"]{re.escape(name)}['\"]", body)]
    if additions:
        separator = "" if not body.strip() or body.rstrip().endswith(",") else ","
        insertion = separator + "\\n" + "".join(f"  '{name}',\\n" for name in additions)
        source = source[:match.start("body")] + body + insertion + source[match.end("body"):]
        temporary = catalog.with_suffix(".js.tmp")
        temporary.write_text(source, encoding="utf-8")
        temporary.replace(catalog)

    written = catalog.read_text(encoding="utf-8")
    for name in names:
        if not re.search(rf"['\"]{re.escape(name)}['\"]", written):
            raise SystemExit(f"preinstalled bundle missing from OPTIONAL_BUNDLES: {name}")

    print("DSH installation optional bundles: " + ", ".join(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
