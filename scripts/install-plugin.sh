#!/usr/bin/env bash
# Build quota-pilot and its page from this checkout, install it into the plugin folder of the
# CLIProxyAPI on this machine, enable it and restart the proxy, which loads a plugin library only
# when it starts; then check that the proxy runs this build. A copy installed from the plugin store
# is moved aside into ~/.cache/cliproxy-kit, and the plugin's settings stay.
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
# Trailing slashes would start every route below with //.
url=${url%"${url##*[!/]}"}
mgmt=$url/v8/management
[[ $url =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] ||
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
go vet ./...
go test ./...
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
# The plugin reports this as its version, so the check at the end knows the proxy runs this build.
stamp=dev-$(date -u +%Y%m%d%H%M%S)
go build -buildmode=c-shared -ldflags "-X main.version=$stamp" -o "$build/quota-pilot.$ext" .

# The proxy prefers a versioned library, which the plugin store installs in <dir>/<goos>/<goarch>,
# to this unversioned one, takes an unversioned one there before one here, and while the store's
# record in the plugin's settings (plugins.configs.quota-pilot.store) names a version, loads only
# that version. So for this build to load, those copies and that record go, kept in a backup folder.
# The panel's delete is not used: it also removes the plugin's other settings (band_tokens,
# fallback_map, thresholds), which stay.
backup=$HOME/.cache/cliproxy-kit/install-backup-$(date +%Y%m%d-%H%M%S)
undo=
# fail ends the install, saying how to go back to the store's copy when it was moved aside.
fail() {
  echo "$1" >&2
  [ -z "$undo" ] || printf 'The plugin store copy is kept in %s. To go back to it:%s\nthen restart CLIProxyAPI.\n' "$backup" "$undo" >&2
  exit 1
}
platform=$dir/$(go env GOOS)/$(go env GOARCH)
for copy in "$platform/quota-pilot.$ext" "$platform"/quota-pilot-v*."$ext" "$dir"/quota-pilot-v*."$ext"; do
  [ -f "$copy" ] || continue
  # Kept at its place under the plugin folder: copies of one name in two folders stay apart.
  kept=$backup/${copy#"$dir"/}
  (umask 077 && mkdir -p "${kept%/*}")
  mv "$copy" "$kept" || fail "Could not move $copy aside."
  undo+=$(printf '\n  mv %q %q' "$kept" "$copy")
done
settings=$(printf '%s' "$config" | python3 -c '
import json, sys
entry = ((json.load(sys.stdin).get("plugins") or {}).get("configs") or {}).get("quota-pilot") or {}
print(json.dumps(entry) if "store" in entry else "")')
if [ -n "$settings" ]; then
  (umask 077 && mkdir -p "$backup" && printf '%s\n' "$settings" > "$backup/quota-pilot.json")
  undo+=$(printf "\n  curl -X PUT -H 'Authorization: Bearer <management key>' --data @%q %q" \
    "$backup/quota-pilot.json" "$mgmt/config/plugins/configs/quota-pilot")
fi

mkdir -p "$dir"
cp "$build/quota-pilot.$ext" "$dir/.quota-pilot.tmp" && mv -f "$dir/.quota-pilot.tmp" "$dir/quota-pilot.$ext"
echo "Installed $dir/quota-pilot.$ext"
if [ -n "$settings" ]; then
  api -o /dev/null -X DELETE "$mgmt/config/plugins/configs/quota-pilot/store" ||
    fail "The proxy did not remove the plugin store's record of quota-pilot."
fi
[ -z "$undo" ] || echo "The plugin store's copy of quota-pilot is moved aside, into $backup; its settings stay."

api -o /dev/null -X PATCH -H 'Content-Type: application/json' "$mgmt/config" \
  -d '{"plugins":{"enabled":true,"configs":{"quota-pilot":{"enabled":true}}}}' ||
  fail "The proxy did not enable quota-pilot."

if [ -n "${CPA_RESTART_CMD:-}" ]; then
  sh -c "$CPA_RESTART_CMD"
elif command -v brew >/dev/null && brew services list 2>/dev/null | grep -Eq '^cliproxyapi +started'; then
  brew services restart cliproxyapi >/dev/null
elif command -v systemctl >/dev/null && systemctl --user is-active --quiet cliproxyapi 2>/dev/null; then
  systemctl --user restart cliproxyapi
else
  echo "Restart CLIProxyAPI now to load it, or set CPA_RESTART_CMD to how you restart it."
  echo "The panel's Plugins page then shows quota-pilot $stamp."
  exit 0
fi
# The proxy lists the version of the library it registered: this build's, or the check fails.
plugins=
for _ in $(seq 60); do
  plugins=$(api "$mgmt/plugins") && [[ $plugins == *"\"$stamp\""* ]] && break
  sleep 0.5
done
printf '%s' "$plugins" | STAMP=$stamp python3 -c '
import json, os, sys
try:
    found = [x for x in json.load(sys.stdin).get("plugins", []) if x.get("id") == "quota-pilot"]
except ValueError:
    found = []
p = found[0] if found else {}
version = (p.get("metadata") or {}).get("version")
if p.get("effective_enabled") and version == os.environ["STAMP"]:
    print("quota-pilot %s is loaded and enabled, from %s" % (version, p.get("path")))
    sys.exit(0)
print("quota-pilot is not running this build (%s): the proxy lists %s" % (os.environ["STAMP"], {
    "version": version, **{k: p.get(k) for k in ("path", "registered", "enabled", "effective_enabled")}} if p else "no quota-pilot"),
    file=sys.stderr)
sys.exit(1)' || fail "The proxy's log says why it did not load $dir/quota-pilot.$ext."
