#!/usr/bin/env bash
# Build quota-pilot and its page from this checkout, install it into the plugin folder of the
# CLIProxyAPI on this machine, enable it and restart the proxy, which loads a plugin library only
# when it starts.
# To use a released build instead, install quota-pilot from the plugin store (see README).
#
#   CPA_URL             the proxy on this machine, default http://127.0.0.1:8317
#   CPA_MANAGEMENT_KEY  its management key; else the macOS Keychain item cliproxyapi-management;
#                       else asked for
#   CPA_PLUGINS_DIR     its plugin folder; else plugins.dir from its config, when that is
#                       absolute or under ~
#   CPA_RESTART_CMD     how to restart it; else Homebrew's or systemd's service, when one runs it
set -euo pipefail
kit=$(cd "$(dirname "$0")/.." && pwd)
url=${CPA_URL:-http://127.0.0.1:8317}
mgmt=$url/v8/management
[[ $url =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]] ||
  { echo "CPA_URL must be the proxy on this machine: the library is installed here." >&2; exit 1; }
case $(uname -s) in
  Darwin) ext=dylib ;;
  Linux) ext=so ;;
  *) echo "Build on macOS or Linux, or install a released build from the plugin store." >&2; exit 1 ;;
esac

key=${CPA_MANAGEMENT_KEY:-}
if [ -z "$key" ] && command -v security >/dev/null; then
  key=$(security find-generic-password -s cliproxyapi-management -w 2>/dev/null || true)
fi
if [ -z "$key" ]; then read -rsp 'Management key: ' key; echo; fi
# The key reaches curl as a header file, so no process listing shows it.
api() { curl -sf -m 10 -H @<(printf 'Authorization: Bearer %s\n' "$key") "$@"; }

config=$(api "$mgmt/config") || { echo "No answer from $mgmt with that key." >&2; exit 1; }
dir=${CPA_PLUGINS_DIR:-$(printf '%s' "$config" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("plugins") or {}).get("dir") or "")')}
case $dir in
  "~"*) dir=$HOME${dir#"~"} ;;
  /*) ;;
  *) echo "plugins.dir is '${dir:-plugins}', relative to where the proxy runs: set CPA_PLUGINS_DIR to that folder." >&2; exit 1 ;;
esac

# The page in the panel: tested, linted and built into plugin/page, which the plugin embeds.
(cd "$kit/ui" && bun install --frozen-lockfile && bun run verify)

cd "$kit/plugin"
test -z "$(gofmt -l .)" || { echo "gofmt needed:" >&2; gofmt -l . >&2; exit 1; }
go vet ./... && go test ./...
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
go build -buildmode=c-shared -o "$build/quota-pilot.$ext" .
mkdir -p "$dir"
cp "$build/quota-pilot.$ext" "$dir/.quota-pilot.tmp" && mv -f "$dir/.quota-pilot.tmp" "$dir/quota-pilot.$ext"
echo "Installed $dir/quota-pilot.$ext"
for copy in "$dir"/*/*/quota-pilot-v*."$ext"; do
  [ -e "$copy" ] && echo "Note: a plugin store copy is installed too ($copy); remove it in the panel to run this build."
done

api -o /dev/null -X PATCH -H 'Content-Type: application/json' "$mgmt/config" \
  -d '{"plugins":{"enabled":true,"configs":{"quota-pilot":{"enabled":true}}}}'

if [ -n "${CPA_RESTART_CMD:-}" ]; then
  sh -c "$CPA_RESTART_CMD"
elif command -v brew >/dev/null && brew services list 2>/dev/null | grep -Eq '^cliproxyapi +started'; then
  brew services restart cliproxyapi >/dev/null
elif command -v systemctl >/dev/null && systemctl --user is-active --quiet cliproxyapi 2>/dev/null; then
  systemctl --user restart cliproxyapi
else
  echo "Restart CLIProxyAPI now to load it, or set CPA_RESTART_CMD to how you restart it."
  exit 0
fi
for _ in $(seq 40); do api -o /dev/null "$url/management.html" && break; sleep 0.5; done
api "$mgmt/plugins" | python3 -c '
import json, sys
p = [x for x in json.load(sys.stdin).get("plugins", []) if x.get("id") == "quota-pilot"]
ok = bool(p) and p[0].get("effective_enabled")
print("quota-pilot is loaded and enabled" if ok else "quota-pilot is not active: %s" % p)
sys.exit(0 if ok else 1)'
