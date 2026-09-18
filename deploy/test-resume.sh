#!/bin/bash
# Proves that release.sh restores the imports and the Telegram worker whenever a
# step after the pause fails, and that it does not resume twice on success.
#
#   bash deploy/test-resume.sh
#
# No server is touched: `ssh` is replaced on PATH by a stub that answers each
# remote step and can be told to fail at one of them. Only git's own ssh — the
# `git fetch origin` release.sh opens with — reaches the network, so the check
# needs the repository's remote and nothing else.
#
# This is deliberately not part of `pnpm check`. It depends on two real commits
# being present locally, which a shallow CI checkout does not guarantee, and the
# thing it guards changes about once a year. Run it when release.sh changes.
set -uo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stub=$work/bin
mkdir -p "$stub"

cat > "$stub/ssh" <<'STUB'
#!/bin/bash
args="$*"
note() { echo "$1" >> "$PF_STUB_LOG"; }
case "$args" in
*git-upload-pack*|*git-receive-pack*) exec /usr/bin/ssh "$@" ;;
*"RELEASE_SHA"*"cut -d= -f2"*) note read-running-release; echo "$PF_DEPLOYED" ;;
*sha256sum*) note transfer; cat > "$PF_STUB_ARCHIVE"; shasum -a 256 "$PF_STUB_ARCHIVE" ;;
*"pnpm install"*) note build ;;
*"node --test"*) note tests ;;
*"pf-migrate-check"*) note rehearsal ;;
*"systemctl stop private-finances-telegram.service"*)
  note pause
  if [ "$PF_FAIL_AT" = pause ]; then echo 'an import is still running' >&2; exit 75; fi
  echo paused ;;
*switch-release.py*)
  note switch
  if [ "$PF_FAIL_AT" = switch ]; then echo 'switch failed' >&2; exit 1; fi ;;
*"systemctl start private-finances-telegram.service"*) note resume; echo resumed ;;
*"select max(version) from schema_versions"*) note verify ;;
*"rm -rf /tmp/pf-build"*) note cleanup ;;
*) note "UNMATCHED: $args" ;;
esac
STUB
chmod +x "$stub/ssh"

target=$(git -C "$repo" rev-parse origin/main)
# Any ancestor of the target stands in for the running release.
deployed=$(git -C "$repo" rev-list --max-count=1 --skip=3 "$target")
failures=0

# scenario, expected exit, whether the resume must have run, whether the banner
# announcing a restore must appear.
check() {
  local scenario=$1 want_status=$2 want_banner=$3
  local log=$work/steps-$scenario
  : > "$log"
  local out status
  out=$(cd "$repo" && PATH="$stub:$PATH" PF_STUB_LOG="$log" PF_STUB_ARCHIVE="$work/archive" \
    PF_DEPLOYED="$deployed" PF_FAIL_AT="$scenario" bash deploy/release.sh "$target" 2>&1)
  status=$?
  local steps banner
  steps=$(tr '\n' ' ' < "$log")
  banner=$(grep -c 'restoring the imports and the worker' <<< "$out")
  local problem=
  [ "$status" = "$want_status" ] || problem="exit $status, wanted $want_status"
  grep -q ' pause ' <<< " $steps " || problem="${problem:+$problem; }never paused"
  grep -q ' resume ' <<< " $steps " || problem="${problem:+$problem; }never resumed"
  [ "$banner" = "$want_banner" ] ||
    problem="${problem:+$problem; }restore banner $banner, wanted $want_banner"
  if [ -n "$problem" ]; then
    echo "FAIL  fail-at=$scenario: $problem" >&2
    echo "      steps: $steps" >&2
    failures=$((failures + 1))
  else
    echo "ok    fail-at=$scenario: exit $status, steps: $steps"
  fi
}

# A clean run resumes as its own step and the trap stays quiet.
check none 0 0
# The pause itself refusing is what happened on 18 September 2026: it stops the
# timers and the worker in its first lines and can still fail in its last.
check pause 75 1
# And a failure after the switch must not leave them down either.
check switch 1 1

if [ "$failures" != 0 ]; then
  echo "$failures scenario(s) failed" >&2
  exit 1
fi
echo 'release.sh restores what a failed step paused'
