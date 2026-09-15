#!/bin/sh
# Compare the deployed release with origin/main. Read-only: it never changes the
# server or the repository. Deriving this by hand takes several commands and is
# easy to get subtly wrong, so it lives here instead.
set -eu
HOST="${PF_SSH_HOST:-radar}"
git fetch -q origin
deployed=$(ssh -o BatchMode=yes "$HOST" 'sudo -n grep -E "^RELEASE_SHA=" /etc/private-finances/app.env | cut -d= -f2')
main=$(git rev-parse origin/main)
printf 'deployed: %s\n' "$deployed"
printf 'main:     %s\n' "$main"
if [ "$deployed" = "$main" ]; then
  echo 'status:   up to date'
  exit 0
fi
if ! git cat-file -e "$deployed^{commit}" 2>/dev/null; then
  echo 'status:   deployed commit is UNKNOWN locally — fetch or investigate'
  exit 1
fi
if git merge-base --is-ancestor "$deployed" "$main"; then
  echo 'status:   behind origin/main'
else
  echo 'status:   DIVERGED — deployed commit is not an ancestor of main'
fi
echo
echo 'undeployed commits:'
git log --oneline "$deployed..$main"
echo
echo 'changed files (excluding docs):'
git diff --name-only "$deployed" "$main" | grep -v '^docs/' || echo '  (none)'
echo
echo 'schema statements in the diff:'
git diff "$deployed" "$main" -- src/ \
  | grep -E '^\+.*(ALTER TABLE|CREATE TABLE|ADD COLUMN|DROP COLUMN|DROP CONSTRAINT|ADD CONSTRAINT)' \
  | sed 's/^+[[:space:]]*/  /' || echo '  (none)'
