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
            errors.append(f"Binary file requires an explicit review policy: {name}")
            continue
        if any(pattern.search(content) for pattern in secret_patterns):
            errors.append(f"Possible secret in {name} (value suppressed)")
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
