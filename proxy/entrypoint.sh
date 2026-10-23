#!/bin/sh
# Renders the domain allowlist from PROXY_ALLOW_DOMAINS, validates the config, runs squid.
#
# PROXY_ALLOW_DOMAINS  space-separated list.
#                      "example.com"  = exactly that host
#                      ".example.com" = the domain and all its subdomains
#                      Never list both forms of the same domain (squid refuses to start).
set -eu

LIST=/run/squid/allowed_domains.txt
: > "$LIST"

for d in ${PROXY_ALLOW_DOMAINS:-}; do
  d=$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]')
  printf '%s' "$d" | grep -Eq '^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
    || { echo "proxy: rejected domain '$d'" >&2; exit 1; }
  echo "$d" >> "$LIST"
  echo "proxy: allow $d"
done

if [ ! -s "$LIST" ]; then
  echo "allowlist.invalid" > "$LIST"
  echo "proxy: allowlist empty, all requests are denied"
fi

if ! squid -k parse -f /etc/squid/squid.conf >/dev/null 2>&1; then
  squid -k parse -f /etc/squid/squid.conf >&2 || true
  exit 1
fi
exec squid -N -f /etc/squid/squid.conf
