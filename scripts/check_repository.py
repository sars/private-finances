"""Small foundation check; not a general secret scanner or application test suite."""

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md", "AGENTS.md", ".gitignore", ".editorconfig",
    ".github/workflows/ci.yml", ".github/dependabot.yml",
    ".github/pull_request_template.md", "docs/requirements.md",
    "docs/adr/0001-foundation.md", "docs/testing.md", "docs/operations.md",
    "docs/observability.md", "docs/roadmap.md", "docs/incidents/TEMPLATE.md",
]


def main():
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, check=True, capture_output=True,
    )
    names = sorted(set(result.stdout.decode().strip("\0").split("\0")) - {""})
    errors = [f"Missing required file: {name}" for name in REQUIRED if not (ROOT / name).is_file()]
    forbidden_parts = {"secrets", "credentials", "exports", "backups", "data"}
    secret_patterns = [
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"),
        re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
        re.compile(r"\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b"),
    ]
    conflict_marker = re.compile(r"^(?:<{7}|={7}|>{7})(?: |$)", re.M)
    # This repository is public. An address is the one thing in it that an
    # attacker cannot work out for themselves: it names the machine holding the
    # household's database. The addresses that were removed are deliberately not
    # written here — putting them in a tracked file would republish exactly what
    # was taken out — so these match the shape instead of the value.
    ipv4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
    routable_exceptions = re.compile(
        r"^(?:0\.0\.0\.0$|127\.|10\.|192\.168\.|169\.254\.|255\.255\.255\.255$"
        r"|172\.(?:1[6-9]|2\d|3[01])\."
        r"|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)"  # RFC 5737 documentation ranges
    )
    tailnet_host = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9-]*\.ts\.net\b")
    for name in names:
        path = ROOT / name
        if path.is_symlink():
            errors.append(f"Symlink requires explicit review: {name}")
            continue
        if (path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".dump"}
                or forbidden_parts.intersection(path.relative_to(ROOT).parts)
                or (path.name.startswith(".env") and path.name != ".env.example")):
            errors.append(f"Sensitive/runtime path visible to Git: {name}")
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # The binary policy: self-hosted font subsets, so the app needs no
            # third-party request for its typeface and works offline, and the
            # app icon at the sizes a home-screen manifest needs, rendered from
            # frontend/public/icon.svg by scripts/icons.ts.
            if name.startswith("frontend/public/fonts/") and path.suffix == ".woff2":
                continue
            if re.fullmatch(r"frontend/public/icon-\d+\.png", name):
                continue
            errors.append(f"Binary file requires an explicit review policy: {name}")
            continue
        if any(pattern.search(content) for pattern in secret_patterns):
            errors.append(f"Possible secret in {name} (value suppressed)")
        if name != "scripts/check_repository.py":
            for candidate in ipv4.findall(content):
                if any(int(octet) > 255 for octet in candidate.split(".")):
                    continue  # a four-part version string, not an address
                if routable_exceptions.match(candidate):
                    continue
                errors.append(
                    f"Routable IP address in {name} (value suppressed). This "
                    "repository is public: keep it in "
                    "~/.config/private-finances/server-access.md instead."
                )
            if tailnet_host.search(content):
                errors.append(
                    f"Tailscale hostname in {name} (value suppressed). This "
                    "repository is public: keep it in "
                    "~/.config/private-finances/server-access.md instead."
                )
        # A resolved merge leaves no markers. Catching them here costs milliseconds;
        # discovering them through a failed TypeScript build costs a whole build.
        if conflict_marker.search(content) and name != "scripts/check_repository.py":
            errors.append(f"Unresolved merge conflict marker in {name}")
        if path.suffix == ".md":
            for target in re.findall(r"\]\(([^)]+)\)", content):
                target = target.strip().strip("<>").split("#", 1)[0]
                if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                    continue
                if not (path.parent / unquote(target)).exists():
                    errors.append(f"Broken local link in {name}: {target}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Foundation checks passed ({len(names)} Git-visible files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
