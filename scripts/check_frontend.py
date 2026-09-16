#!/usr/bin/env python3
"""Deterministic gate for the frontend design system (frontend/DESIGN.md).

Source rules run always; the bundle budget runs when dist/frontend exists, which
is the case inside `pnpm check` because `pnpm test` builds first.
"""
import gzip
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
TOKENS = SRC / "index.css"
FORMAT = SRC / "lib" / "format.ts"
CHARTS = SRC / "components" / "charts"
FINANCE = SRC / "components" / "finance"
ENTRY_BUDGET_GZIP = 150 * 1024

HEX = re.compile(r"#[0-9a-fA-F]{6}(?![0-9a-zA-Z])|#[0-9a-fA-F]{3}(?![0-9a-zA-Z_-])")
RECHARTS_IMPORT = re.compile(r"""from\s+['"]recharts""")


def source_rules() -> list[str]:
    errors = []
    for path in sorted(SRC.rglob("*.ts*")):
        if path.suffix not in {".ts", ".tsx"} or path.name.endswith(".d.ts"):
            continue
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), 1):
            if HEX.search(line) and 'href="#' not in line:
                errors.append(f"{rel}:{line_number}: raw colour; use a token from index.css")
        if "Intl.NumberFormat" in text and path != FORMAT:
            errors.append(f"{rel}: Intl.NumberFormat belongs in lib/format.ts")
        if RECHARTS_IMPORT.search(text) and CHARTS not in path.parents:
            errors.append(f"{rel}: recharts may only be imported inside components/charts/")
        if "components/ui/select'" in text and FINANCE not in path.parents:
            errors.append(f"{rel}: pick from a list with Choice (components/finance), not a raw Select")
    return errors


def bundle_rules() -> list[str]:
    index_html = ROOT / "dist" / "frontend" / "index.html"
    if not index_html.is_file():
        print("check_frontend: no build in dist/frontend, bundle budget skipped")
        return []
    match = re.search(r'src="/assets/(index-[^"]+\.js)"', index_html.read_text(encoding="utf-8"))
    if not match:
        return ["dist/frontend/index.html: entry script not found"]
    entry = ROOT / "dist" / "frontend" / "assets" / match.group(1)
    raw = entry.read_bytes()
    gz = len(gzip.compress(raw))
    errors = []
    if gz > ENTRY_BUDGET_GZIP:
        errors.append(f"entry chunk {entry.name} is {gz // 1024} KB gzip; budget {ENTRY_BUDGET_GZIP // 1024} KB")
    # Walk the static imports from the entry. Every chunk reached that way loads
    # on first paint, so none of them may carry Recharts — not the entry, and
    # not a shared chunk that happened to absorb it.
    assets = entry.parent
    static_import = re.compile(r"""from\s*["']\./([A-Za-z0-9_.-]+\.js)["']""")
    seen, queue, first_paint = set(), [entry.name], 0
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        chunk = assets / name
        if not chunk.is_file():
            continue
        content = chunk.read_bytes()
        first_paint += len(gzip.compress(content))
        if b"recharts-wrapper" in content:
            errors.append(f"{name} carries Recharts and is reached from the entry's static imports")
            break
        queue.extend(static_import.findall(content.decode("utf-8", errors="ignore")))
    if not errors:
        print(
            f"check_frontend: entry {entry.name} {gz // 1024} KB gzip; "
            f"{len(seen)} chunks / {first_paint // 1024} KB gzip on first paint, charts lazy"
        )
    return errors


def main() -> int:
    errors = source_rules() + bundle_rules()
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("check_frontend: design rules hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
