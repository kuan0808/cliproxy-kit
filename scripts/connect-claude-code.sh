#!/usr/bin/env bash
# Point Claude Code at CLIProxyAPI and install the quota band, on this machine or another one:
#   bash <(curl -fsSL https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/scripts/connect-claude-code.sh) [proxy URL]
# The URL defaults to http://127.0.0.1:8317. The script asks for a client key of the proxy
# (one of its api-keys), checks the proxy answers to it, writes the proxy into Claude Code's user
# settings (the file as it was is kept beside it) and installs the band from this repository's
# plugin marketplace. Running it again changes only the key and the address.
set -euo pipefail
# Scheme and host are case-insensitive, so they are written in lower case (HTTP:// is http://);
# the rest keeps its case.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
raw=${1:-http://127.0.0.1:8317}
raw=${raw%/}
scheme=$(lower "${raw%%://*}")
rest=${raw#*://}
authority=${rest%%[/?#]*}
host=${authority##*@}
[[ $raw == *://* && ($scheme == http || $scheme == https) ]] ||
  { echo "The address must start with http:// or https://." >&2; exit 1; }
base=$scheme://${authority%"$host"}$(lower "$host")${rest#"$authority"}
dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
settings=$dir/settings.json
umask 077

for tool in curl jq claude; do
  command -v "$tool" >/dev/null || { echo "$tool is needed: install it, then run this again." >&2; exit 1; }
done
version=$(claude --version | awk '{print $1}')
[ "$(printf '%s\n' 2.1.287 "$version" | sort -V | head -1)" = 2.1.287 ] ||
  { echo "Claude Code $version is older than 2.1.287, the first to run mods: run claude update." >&2; exit 1; }

local_proxy=false
[[ $base =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] && local_proxy=true
# The key goes with every request: across a network, only over an encrypted connection.
if ! $local_proxy && [[ $base == http://* ]] && [ "${ALLOW_HTTP:-}" != 1 ]; then
  echo "The key would cross the network unencrypted: use an https address (for example through" >&2
  echo "tailscale serve), or set ALLOW_HTTP=1 if the network already encrypts it (a VPN)." >&2
  exit 1
fi

read -rsp 'Client key for the proxy: ' key; echo
# The key reaches curl on stdin, so no process listing shows it.
status() { printf 'Authorization: Bearer %s\n' "$key" | curl -s -o /dev/null -w '%{http_code}' -m 10 -H @- "$1" || true; }
case $(status "$base/v1/models") in
  200) echo "The proxy at $base answers to the key." ;;
  401) echo "The proxy at $base refused the key." >&2; exit 1 ;;
  *) echo "No answer from $base: check the address, and that this machine can reach it." >&2; exit 1 ;;
esac

# edit applies a jq filter to the settings, which stay as they were if it fails.
edit() {
  jq "$@" "$settings" > "$settings.tmp" || { rm -f "$settings.tmp"; exit 1; }
  mv "$settings.tmp" "$settings"
}
mkdir -p "$dir"
if [ -s "$settings" ]; then cp -p "$settings" "$settings.bak-$(date +%Y%m%d-%H%M%S)"; else echo '{}' > "$settings"; fi
# shellcheck disable=SC2016 # a jq filter, not shell
KEY=$key edit --arg base "$base" '.env += {
  ANTHROPIC_BASE_URL: $base,
  ANTHROPIC_AUTH_TOKEN: env.KEY,
  CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
  ENABLE_TOOL_SEARCH: "true",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false"
}'
echo "Claude Code now uses the proxy: $settings"

claude plugin marketplace add kuan0808/cliproxy-kit
claude plugin install quota-band@cliproxy-kit
# Auto-update is read only from user settings, and adding the marketplace writes its entry anew,
# so it is set last.
edit '.extraKnownMarketplaces["cliproxy-kit"].autoUpdate = true'

# Unless a snapshot of the plugin reads here (a proxy on this machine, run as this user), the band
# reads the quota over the network, with this key. The plugin writes the snapshot with Go's
# encoding/json and replaces it whole, so only its shape can differ: it reads when it has every part
# the band's parseSnap requires.
snapshot_ok='def obj: type == "object";
  .schema_version == 1 and (.sequence | type) == "number" and (.boot_id | type) == "string"
  and (.generated_at | type) == "string" and (.config | obj) and (.config.fallback_map | obj)
  and (.providers | obj) and (.sessions | obj) and (.context_lengths | obj) and (.acks | type) == "array"
  and all(.providers[]; obj and (.credentials | type) == "array"
    and all(.credentials[]; obj and (.id | type) == "string" and (.windows | type) == "array"))'
if ! $local_proxy || ! jq -e "$snapshot_ok" "$HOME/.cache/cliproxy-kit/snapshot.json" >/dev/null 2>&1; then
  case $(status "$base/v0/resource/plugins/quota-pilot/band") in
    200) ;;
    404) echo "Note: quota-pilot does not answer at $base yet; install it on the proxy for the band to show quota." ;;
    *) echo "Note: for the band to show quota here, add this key to quota-pilot's band_tokens on the proxy." ;;
  esac
fi
echo "Done: start a new Claude Code session, and the band shows above the prompt."
