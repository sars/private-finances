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
# Tailwind's own palette is a colour outside the tokens as much as a hex value
# is; warnings use `warning`, deltas `positive`/`negative`, series `chart-*`.
PALETTE = re.compile(
    r"\b(?:text|bg|border|ring|fill|stroke|from|to|via)-"
    r"(?:amber|emerald|red|blue|green|yellow|gray|slate|zinc|neutral|stone|"
    r"orange|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d+\b"
)
RECHARTS_IMPORT = re.compile(r"""from\s+['"]recharts""")
# A dialog and a bottom sheet are both fixed and neither scrolls the page
# behind it, so one taller than the screen cannot be reached at either end --
# the Add holding form was unusable on a phone for exactly this. The primitives
# come from the registry and are never edited, so the bound belongs on the call.
OVERLAY = re.compile(r"<(?:Dialog|Sheet)Content\b[^>]*>", re.S)


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
            if PALETTE.search(line) and (SRC / "components" / "ui") not in path.parents:
                errors.append(f"{rel}:{line_number}: palette colour class; use a token (warning, positive, negative, chart-*)")
        if "Intl.NumberFormat" in text and path != FORMAT:
            errors.append(f"{rel}: Intl.NumberFormat belongs in lib/format.ts")
        if RECHARTS_IMPORT.search(text) and CHARTS not in path.parents:
            errors.append(f"{rel}: recharts may only be imported inside components/charts/")
        if "components/ui/select'" in text and FINANCE not in path.parents:
            errors.append(f"{rel}: pick from a list with Choice (components/finance), not a raw Select")
        if "<table" in text and (SRC / "components" / "ui") not in path.parents:
            errors.append(f"{rel}: raw <table>; use the Table primitive or card rows")
        if (SRC / "components" / "ui") not in path.parents:
            for opening in OVERLAY.finditer(text):
                tag = opening.group(0)
                if "overflow-y-auto" in tag and "max-h-" in tag:
                    continue
                line_number = text.count("\n", 0, opening.start()) + 1
                errors.append(
                    f"{rel}:{line_number}: dialog and sheet content needs max-h-[90dvh] overflow-y-auto; "
                    "it is fixed, so content taller than the screen cannot be scrolled to"
                )
        # Base UI's Button renders type="button", so a form's Button submits
        # nothing unless it says type="submit". The save-explanation button
        # once did nothing at all for exactly this reason.
        forms = text.count("<form")
        if forms and text.count('type="submit"') < forms:
            errors.append(
                f"{rel}: {forms} <form> but fewer type=\"submit\" buttons; a Button submits only with type=\"submit\""
            )
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


def pwa_rules() -> list[str]:
    """The installable app is only as good as its two entry files.

    Both rules here failed in the browser once. The service worker precached
    index.html, which the server never serves under that path, so every install
    died with bad-precaching-response and no asset was cached at all. And the
    manifest link had no crossorigin attribute, so the browser asked for it with
    credentials omitted and HTTP Basic authentication answered 401.
    """
    built = ROOT / "dist" / "frontend"
    index_html = built / "index.html"
    worker = built / "sw.js"
    if not index_html.is_file():
        return []
    errors = []
    html = index_html.read_text(encoding="utf-8")
    link = re.search(r"<link[^>]*rel=[\"']manifest[\"'][^>]*>", html)
    if not link:
        errors.append("dist/frontend/index.html: no manifest link; is VitePWA still enabled?")
    elif "use-credentials" not in link.group(0):
        errors.append(
            'dist/frontend/index.html: manifest link needs crossorigin="use-credentials" '
            "(VitePWA useCredentials) or Basic authentication answers it with 401"
        )
    if worker.is_file():
        precached_html = re.findall(r"[\"']([^\"']*\.html)[\"']", worker.read_text(encoding="utf-8"))
        if precached_html:
            errors.append(
                "dist/frontend/sw.js precaches " + ", ".join(sorted(set(precached_html)))
                + "; the server has no such route, so the whole install fails"
            )
    return errors


def main() -> int:
    errors = source_rules() + bundle_rules() + pwa_rules()
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("check_frontend: design rules hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
