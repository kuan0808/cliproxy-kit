#!/usr/bin/env bash
# quota-pool: the quota of every account CLIProxyAPI routes to, read from quota-pilot's /pool
# resource with a client key of the proxy. Transport only: it sends the request and prints the
# answer unchanged; quota-pilot decides every figure. Run quota-pool --help for the details.
# An inherited trace would print the key with the line that hands it to curl.
set +x
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: quota-pool [--model <id>]... [--floor <percent>] [--help]

Prints quota-pilot's pool document: every account CLIProxyAPI holds and, for each model asked,
the accounts that serve it, the weekly quota each has left, and a verdict against the floor.

  --model <id>       a model, as the proxy lists it for clients (repeat for more than one)
  --floor <percent>  a percent from 0 to 100; gives each model a verdict, and needs --model
  --help             this text

The proxy and its client key, as a pair, never mixed:
  QUOTA_POOL_URL with QUOTA_POOL_KEY, else
  ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN, else with ANTHROPIC_API_KEY.
Over http:// an address other than 127.0.0.1 or localhost is refused, unless ALLOW_HTTP=1.

Reading the output:
  Exit 0 means only that the proxy answered HTTP 200; the body is printed as it came. Parse all of
  stdout as one JSON document: it is a reading only when it parses, schema_version is 1, and it
  has models, each with model, verdict, unmeasured_because and rows. Anything else is the pool
  unmeasured ("unmeasured: unreadable document").
  verdict: enough, short, unmeasured (see unmeasured_because) or not_pooled; null without --floor.
  Exit 2 is a usage error. Exit 3 prints one JSON object {"error", "code", "help"}, code one of
  NO_PROXY_URL, KEY_OVER_HTTP, PROXY_UNREACHABLE, KEY_NOT_ACCEPTED, POOL_NOT_SUPPORTED, PROXY_ERROR.

Names: ask with a name the proxy lists for clients. A name no account has registered answers
unmeasured with name_not_registered, even when the proxy would serve it through a prefix or an
alias. A listed name that hides its model family is judged on the all-models week alone.
EOF
}

usage_error() {
  printf 'quota-pool: %s (see quota-pool --help)\n' "$1" >&2
  exit 2
}

# fail prints the one JSON object of exit 3; the address in its text has no userinfo.
fail() {
  printf '{"error": %s, "code": "%s", "help": %s}\n' "$(json "$1")" "$2" "$(json "$3")"
  exit 3
}

json() {
  local s=${1//[[:cntrl:]]/}
  s=${s//\\/\\\\}
  printf '"%s"' "${s//\"/\\\"}"
}

models=()
floor=
floor_given=false
while [ $# -gt 0 ]; do
  case $1 in
    --model | --floor)
      [ $# -ge 2 ] || usage_error "$1 needs a value"
      set -- "$1=$2" "${@:3}"
      ;;
    --model=*)
      models+=("${1#--model=}")
      shift
      ;;
    --floor=*)
      $floor_given && usage_error "--floor is given once"
      floor=${1#--floor=} floor_given=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done
if $floor_given; then
  [ ${#models[@]} -gt 0 ] || usage_error "--floor needs --model"
  [[ $floor =~ ^[0-9]+(\.[0-9]+)?$ ]] || usage_error "--floor is a percent from 0 to 100"
  whole=${floor%%.*}
  while [[ $whole == 0?* ]]; do whole=${whole#0}; done
  if [ ${#whole} -gt 3 ] || [ "$whole" -gt 100 ] || { [ "$whole" -eq 100 ] && [[ ${floor#"$whole"} == *[1-9]* ]]; }; then
    usage_error "--floor is a percent from 0 to 100"
  fi
fi

if [ -n "${QUOTA_POOL_URL:-}" ]; then
  raw=$QUOTA_POOL_URL key=${QUOTA_POOL_KEY:-}
elif [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  raw=$ANTHROPIC_BASE_URL key=${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}
else
  fail "no proxy address" NO_PROXY_URL "set QUOTA_POOL_URL and QUOTA_POOL_KEY, or ANTHROPIC_BASE_URL with its token"
fi
while [[ $raw == */ ]]; do raw=${raw%/}; done
# Scheme and host are case-insensitive; the rest keeps its case. Userinfo is never printed.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
scheme=$(lower "${raw%%://*}")
rest=${raw#*://}
authority=${rest%%[/?#]*}
host=$(lower "${authority##*@}")
shown=$scheme://$host${rest#"$authority"}
if [[ $raw != *://* || ($scheme != http && $scheme != https) ]]; then
  fail "the proxy address $shown does not start with http:// or https://" NO_PROXY_URL "set QUOTA_POOL_URL or ANTHROPIC_BASE_URL to the proxy's http(s) address"
fi
base=$scheme://${authority%"${authority##*@}"}$host${rest#"$authority"}
# The key goes with the request: across a network, only over an encrypted connection.
if [ "$scheme" = http ] && ! [[ $scheme://$(lower "$authority") =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] && [ "${ALLOW_HTTP:-}" != 1 ]; then
  fail "the key would cross the network unencrypted to $shown" KEY_OVER_HTTP "use an https address, or set ALLOW_HTTP=1 if the network already encrypts it (a VPN)"
fi

# -q first: curl reads no .curlrc, which could print the header or follow a redirect with it. The
# key reaches curl on stdin, as a header file, so no process listing shows it. No -L.
query=()
for m in ${models[@]+"${models[@]}"}; do query+=(--data-urlencode "model=$m"); done
$floor_given && query+=(--data-urlencode "floor=$floor")
# ponytail: the body goes through a shell variable, so a NUL byte in it is dropped; a JSON document
# has none, and a temporary file would put the balance on disk.
reply=$({ [ -z "$key" ] || printf 'Authorization: Bearer %s\n' "$key"; } |
  curl -q -sS -m 20 -G -H @- -w '\n%{http_code}' ${query[@]+"${query[@]}"} "$base/v0/resource/plugins/quota-pilot/pool") ||
  fail "the proxy did not answer at $shown" PROXY_UNREACHABLE "start CLIProxyAPI, or set QUOTA_POOL_URL and QUOTA_POOL_KEY"
status=${reply##*$'\n'}
body=${reply%$'\n'*}
case $status in
  200)
    printf '%s' "$body"
    exit 0
    ;;
  401) fail "the proxy at $shown did not accept the key" KEY_NOT_ACCEPTED "use a client key the proxy accepted for a request in the last week" ;;
  404) fail "the proxy at $shown has no pool to read" POOL_NOT_SUPPORTED "one of: quota-pilot older than 0.2.1, quota-pilot turned off, a proxy that serves no plugin resources (Home), or another service at that address" ;;
  *) fail "the proxy at $shown answered HTTP $status" PROXY_ERROR "check that the address is the proxy itself; a redirect is not followed" ;;
esac
