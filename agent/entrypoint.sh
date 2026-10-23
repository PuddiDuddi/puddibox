#!/bin/bash
# Root phase: verify the sandbox, fail closed on anything unexpected, then drop privileges.
#
# Env (set by claude-box.ps1):
#   GIT_READONLY=1          /workspace/.git must be read-only
#   VSCODE_READONLY=1       /workspace/.vscode must be read-only
#   CLAUDE_DIR_READONLY=1   /workspace/.claude must be read-only
#   EGRESS_MODE=proxy       verify proxy-only egress (default); "none" skips the check
set -euo pipefail

fail() { echo "sandbox: FAIL, $1" >&2; exit 1; }

# The checks below need root. Starting as another user would skip them, so refuse.
[ "$(id -u)" = "0" ] \
  || fail "the container must start as root (it verifies the sandbox, then drops to user claude)"

# 1. .venv must be its own volume. Otherwise the agent would write into the Windows venv
#    on the bind mount, which VS Code later executes on the host.
awk '$2 == "/workspace/.venv" { found = 1 } END { exit !found }' /proc/mounts \
  || fail "/workspace/.venv is not a separate volume; refusing to start"

# 2. Paths the host executes or trusts must be read-only.
check_ro() {
  local dir="$1"
  [ -d "$dir" ] || fail "$dir is missing (the launcher should mount it)"
  if touch "$dir/.sandbox-rw-probe" 2>/dev/null; then
    rm -f "$dir/.sandbox-rw-probe"
    fail "$dir is writable; it must be mounted read-only"
  fi
}
[ "${GIT_READONLY:-1}" = "1" ] && check_ro /workspace/.git
[ "${VSCODE_READONLY:-1}" = "1" ] && check_ro /workspace/.vscode
[ "${CLAUDE_DIR_READONLY:-1}" = "1" ] && check_ro /workspace/.claude

# 3. Volumes are created root-owned, and a new volume gets a copy of the image content at its
#    mount point. Hand every file and folder in them to the agent user. Only regular files and
#    folders on the volume itself (-xdev), and -h never follows a link, so a link that the agent
#    plants cannot redirect the chown to a file outside the volume.
rmdir /workspace/.venv/lost+found 2>/dev/null || true
for vol in /workspace/.venv "$CLAUDE_CONFIG_DIR" "$UV_CACHE_DIR"; do
  find "$vol" -xdev \( -type f -o -type d \) ! -user claude -exec chown -h claude:claude {} +
done

# 4. Network: the only way out must be the allowlisting proxy.
case "${EGRESS_MODE:-proxy}" in
  proxy) /usr/local/bin/check-egress.sh ;;
  none)  echo "sandbox: WARNING, EGRESS_MODE=none, network isolation NOT verified" >&2 ;;
  *)     fail "unknown EGRESS_MODE '${EGRESS_MODE}'" ;;
esac

# 5. Token mode: mark onboarding as done. Onboarding tests the connection to api.anthropic.com
#    directly (not through ANTHROPIC_BASE_URL), which is closed in token mode, and then asks
#    for a login although CLAUDE_CODE_OAUTH_TOKEN is set. Runs as claude, because the agent
#    controls this volume and could plant a link there for root to follow.
if [ -n "${ANTHROPIC_BASE_URL:-}" ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  setpriv --reuid=claude --regid=claude --init-groups --no-new-privs -- python3 -I -c '
import json, os, sys
p = os.path.join(os.environ["CLAUDE_CONFIG_DIR"], ".claude.json")
try:
    with open(p) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except (OSError, ValueError) as e:
    sys.exit(f"sandbox: WARNING, cannot read {p}: {e}")
if cfg.get("hasCompletedOnboarding") is not True:
    cfg["hasCompletedOnboarding"] = True
    with open(p, "w") as f:
        json.dump(cfg, f, indent=2)
' || true
fi

echo "sandbox: checks passed, starting as user claude"

# 6. Drop to the unprivileged user with no capabilities and no way to regain them.
exec setpriv --reuid=claude --regid=claude --init-groups \
     --inh-caps=-all --bounding-set=-all --no-new-privs \
     -- "$@"
