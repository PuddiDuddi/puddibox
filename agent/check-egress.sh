#!/bin/bash
# Verifies the container reaches the internet ONLY through the allowlisting proxy. Fails closed.
#
# Env:
#   HTTPS_PROXY                 required
#   EGRESS_ALLOWED_TEST_HOST    allowlisted host that must work via the proxy (api.anthropic.com)
#   EGRESS_BLOCKED_TEST_HOST    non-allowlisted host that must fail (example.com)
#   ANTHROPIC_BASE_URL          set = token mode: the Claude API must be reachable only through
#                               this API proxy, and api.anthropic.com must be blocked
set -uo pipefail

: "${HTTPS_PROXY:?HTTPS_PROXY not set}"
ALLOWED="${EGRESS_ALLOWED_TEST_HOST:-api.anthropic.com}"
BLOCKED="${EGRESS_BLOCKED_TEST_HOST:-example.com}"
fail() { echo "egress: FAIL, $1" >&2; exit 1; }

# TCP probe: succeeds only if something accepts the connection.
probe() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# 1. No direct route out: by name, by IP, on another port, over IPv6.
curl -s --noproxy '*' --max-time 5 -o /dev/null "https://$BLOCKED" \
  && fail "direct internet access to $BLOCKED without the proxy"
curl -sk --noproxy '*' --max-time 5 -o /dev/null "https://1.1.1.1" \
  && fail "direct internet access by IP without the proxy"
curl -s --noproxy '*' --max-time 5 -o /dev/null "http://1.1.1.1" \
  && fail "direct internet access on port 80 without the proxy"
curl -sk -6 --noproxy '*' --max-time 5 -o /dev/null "https://[2606:4700:4700::1111]" \
  && fail "direct internet access over IPv6 without the proxy"

# 2. No DNS for outside names. The proxy resolves names itself; a resolver that answers for
#    outside names can carry data out inside the queries.
getent hosts "$BLOCKED" >/dev/null 2>&1 \
  && fail "external DNS lookup works ($BLOCKED); DNS queries can carry data out"

# 3. No access to the host or LAN through the gateway, no cloud metadata endpoint, and no
#    access to the Windows host through the wslc host name (session.hostLoopback in
#    %LOCALAPPDATA%\wslc\settings.yaml; "none" disables it). Ports: Windows services and
#    common local dev servers.
targets="169.254.169.254"
gw_hex=$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route 2>/dev/null || true)
if [ -n "$gw_hex" ] && [ "$gw_hex" != "00000000" ]; then
  targets="$targets $(printf '%d.%d.%d.%d' "0x${gw_hex:6:2}" "0x${gw_hex:4:2}" "0x${gw_hex:2:2}" "0x${gw_hex:0:2}")"
fi
HOST_NAME="host.wslc.internal"
host_ips=$(getent ahostsv4 "$HOST_NAME" 2>/dev/null | awk '{ print $1 }' | sort -u || true)
if [ -n "$host_ips" ]; then
  echo "egress: WARNING, $HOST_NAME resolves ($(echo $host_ips)); set 'hostLoopback: none' in wslc settings.yaml" >&2
  targets="$targets $host_ips"
fi
open=$(for t in $targets; do
         for p in 22 80 135 443 445 3000 3389 5000 5432 5985 6379 8000 8080 8888 9000; do
           (probe "$t" "$p" && echo "$t:$p") &
         done
       done; wait)
[ -z "$open" ] || fail "reachable from the sandbox: $(echo $open)"

# 4. The proxy denies hosts that are not on the allowlist, and bare IP addresses.
curl -s --max-time 10 -o /dev/null "https://$BLOCKED" \
  && fail "the proxy allowed non-allowlisted $BLOCKED"
curl -sk --max-time 10 -o /dev/null "https://1.1.1.1" \
  && fail "the proxy allowed CONNECT to a bare IP address"

# 5. The proxy allows the Claude API (any HTTP response means the TLS tunnel works).
curl -s --max-time 15 -o /dev/null "https://$ALLOWED" \
  || fail "$ALLOWED is not reachable through the proxy"

# 6. Token mode: the API proxy answers, and api.anthropic.com is closed. Through an open
#    api.anthropic.com, a request with an attacker's API key carries data to the attacker.
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  curl -s --noproxy '*' --max-time 10 -o /dev/null "$ANTHROPIC_BASE_URL/" \
    || fail "the API proxy $ANTHROPIC_BASE_URL does not answer"
  curl -s --max-time 10 -o /dev/null "https://api.anthropic.com" \
    && fail "api.anthropic.com is reachable through the egress proxy in token mode"
fi

echo "egress: proxy-only egress verified"
