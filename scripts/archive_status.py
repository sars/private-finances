#!/usr/bin/env python3
"""Move older STATUS.md entries into a monthly archive.

STATUS.md is read at the start of every session, so it must stay bounded. The
pinned "# Current state" section is never archived; the newest --keep dated
entries stay, and the rest are appended to docs/status-archive/<month>.md in
their existing order. Content is moved verbatim: this script never rewrites an
entry, except that relative Markdown links are re-pointed for the extra
directory level, so a moved entry's links keep resolving.
"""
import argparse
import re
from pathlib import Path

PINNED = '# Current state'
STATUS = Path('docs/STATUS.md')
ARCHIVE_DIR = Path('docs/status-archive')


def split_entries(text):
    """Return (pinned_prefix, [entry, ...]) splitting on top-level headings."""
    positions = [m.start() for m in re.finditer(r'^# ', text, flags=re.M)]
    if not positions:
        return text, []
    sections = [text[a:b] for a, b in zip(positions, positions[1:] + [len(text)])]
    prefix = text[: positions[0]]
    if sections and sections[0].startswith(PINNED):
        prefix += sections.pop(0)
    return prefix, sections


def reroot_links(text):
    """Re-point relative links: the archive sits one directory below docs/."""

    def fix(match):
        target = match.group(1).strip()
        bare = target.split('#', 1)[0]
        if (not bare or target.startswith(('#', '/', '../'))
                or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target)):
            return match.group(0)
        return f']({"../" + target})'

    return re.sub(r'\]\(([^)]+)\)', fix, text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--keep', type=int, default=10)
    parser.add_argument('--month', default=None, help='archive file stem, e.g. 2026-09')
    parser.add_argument('--check', action='store_true', help='report only, change nothing')
    args = parser.parse_args()
    text = STATUS.read_text()
    prefix, entries = split_entries(text)
    if len(entries) <= args.keep:
        print(f'STATUS.md holds {len(entries)} entries; keep={args.keep}; nothing to archive.')
        return
    kept, moved = entries[: args.keep], entries[args.keep :]
    print(f'entries={len(entries)} keep={len(kept)} archive={len(moved)}')
    if args.check:
        return
    month = args.month or re.search(r'(\d{4})-(\d{2})', moved[0]) or None
    if args.month is None:
        found = re.search(r'([A-Z][a-z]+ \d{1,2}, (\d{4}))', moved[0])
        month = f'{found.group(2)}-09' if found else 'undated'
    ARCHIVE_DIR.mkdir(exist_ok=True)
    target = ARCHIVE_DIR / f'{month}.md'
    header = (
        f'# Archived status entries — {month}\n\n'
        'Historical release records moved out of docs/STATUS.md to keep that file\n'
        'bounded. Entries are verbatim and describe the state at the time they were\n'
        'written; they are not current state. See docs/STATUS.md for that.\n\n'
    )
    existing = target.read_text() if target.exists() else header

    # Entries are separated by blank lines, so the last one carries trailing
    # newlines. `git show --check` in CI rejects a blank line at end of file.
    def tidy(text):
        return text.rstrip('\n') + '\n'

    target.write_text(tidy(existing + reroot_links(''.join(moved))))
    STATUS.write_text(tidy(prefix + ''.join(kept)))
    print(f'archived {len(moved)} entries to {target}')


if __name__ == '__main__':
    main()
