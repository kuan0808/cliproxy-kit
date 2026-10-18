#!/bin/sh
# The Claude Code check for Switch now (docs/architecture.md, "Upstream behaviour it relies on"):
# run by hand on the Claude Code version in use, never in CI. A stub upstream on 127.0.0.1 and a
# throwaway config folder with a dummy key: no account and no proxy is reached.
#
#   sh mod/tests/claude-check/run.sh
#
# It checks that $.turn.abort, as the band calls it on a press, closes the stalled request at once;
# that the stopped turn's end reports `aborted`; that the next message's request carries the stopped
# turn's finished tool call and its result; that a background task started before the stop keeps
# running; and it reports what becomes of a message queued during the wait.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
port=${CHECK_PORT:-18999}
stub=''
trap 'if [ -n "$stub" ]; then kill "$stub" 2>/dev/null || true; fi; rm -rf "$work"' EXIT

# claude_in DIR NEXT ARGS...: Claude Code in DIR's own folder, reaching only the stub.
claude_in() {
  dir=$1 next=$2
  shift 2
  (cd "$dir/cwd" && env -u ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL="http://127.0.0.1:$port" ANTHROPIC_API_KEY=sk-check-dummy \
    CLAUDE_CONFIG_DIR="$dir/cfg" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CHECK_STALL_MS=3000 CHECK_LOG="$dir/check.log" CHECK_NEXT="$next" \
    claude -p --allowedTools Bash --plugin-dir "$here/press" --model claude-opus-5-5 "$@")
}

# start NAME SCRIPT: a folder for one run, and the stub answering it.
start() {
  dir="$work/$1"
  mkdir -p "$dir/cfg" "$dir/cwd"
  python3 -I "$here/stub.py" "$port" "$2" "$dir/requests.json" >"$dir/stub.log" 2>&1 &
  stub=$!
  sleep 1
}

stop() {
  kill "$stub" 2>/dev/null || true
  wait "$stub" 2>/dev/null || true
  stub=''
}

count() { python3 -I -c 'import json, sys; print(len(json.load(open(sys.argv[1]))))' "$1" 2>/dev/null || echo 0; }

# The stop: the tool calls run, the next request hangs, the check mod stops the turn after 3 s and
# then sends the next message, whose answer comes 5 s later, past the background task's end.
start stop tools,hang,slow
claude_in "$work/stop" 1 'CHECK-PROMPT run the tools' </dev/null >"$work/stop/out.txt" 2>&1 || true
stop

# A message queued while the request hangs, then the stop.
start queued tools,hang,ok,ok
{
  printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"CHECK-PROMPT run the tools"}]}}'
  until [ "$(count "$work/queued/requests.json")" -ge 2 ]; do sleep 0.2; done
  sleep 0.5
  printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"CHECK-PROMPT queued"}]}}'
  sleep 12
} | claude_in "$work/queued" '' --input-format stream-json --output-format stream-json --verbose >"$work/queued/out.txt" 2>&1 || true
stop

python3 -I - "$work" "$(claude --version 2>/dev/null || echo unknown)" <<'PY'
import json, os, re, sys
work, version = sys.argv[1], sys.argv[2]
def read(*p):
    try:
        return open(os.path.join(work, *p)).read()
    except OSError:
        return ''
def requests(name):
    try:
        return json.loads(read(name, 'requests.json'))
    except ValueError:
        return []
def has(messages, kind, text=''):
    for m in messages:
        content = m.get('content')
        for b in content if isinstance(content, list) else [{'type': 'text', 'text': content}]:
            body = json.dumps(b)
            if b.get('type') == kind and text in body:
                return True
    return False
stub, log, reqs = read('stop', 'stub.log'), read('stop', 'check.log'), requests('stop')
closed = re.search(r'main #2 closed by the client after ([\d.]+)s', stub)
stopped = re.search(r'^abort (\S+)$', log, re.M)
checks = [
    ('the abort closes the stalled request at once', bool(closed) and float(closed.group(1)) < 4.5),
    ("the stopped turn's end reports aborted", bool(stopped) and f'complete {stopped.group(1)} aborted' in log),
    ("the next message's request carries the stopped turn's finished tool call and its result",
     len(reqs) >= 3 and has(reqs[2], 'tool_use', 'toolu_check1') and has(reqs[2], 'tool_result', 'check-tool-ran')),
    ('a background task started before the stop keeps running', os.path.exists(os.path.join(work, 'stop', 'cwd', 'bg-done.txt'))),
]
queued = requests('queued')
after = next((i + 1 for i, r in enumerate(queued) if has(r, 'text', 'CHECK-PROMPT queued')), 0)
stopped_q = re.search(r'^complete \S+ aborted$', read('queued', 'check.log'), re.M)
print(f'Claude Code {version}')
for name, ok in checks:
    print(f"{'pass' if ok else 'FAIL'}  {name}")
when = 'after the stop' if stopped_q else 'and the turn was not stopped'
print(f"note  a message queued during the wait: {f'sent with request {after}, {when}' if after else 'not sent'}")
if not all(ok for _, ok in checks):
    for name in ('stop', 'queued'):
        print(f'--- {name}: stub log\n{read(name, "stub.log")}--- {name}: check log\n{read(name, "check.log")}--- {name}: output\n{read(name, "out.txt")[-2000:]}')
    sys.exit(1)
PY
