"""Checks what the backfill recovers from transcripts: python3 scripts/test_usage_backfill.py"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from importlib.machinery import SourceFileLoader
from pathlib import Path

tmp = Path(tempfile.mkdtemp())
os.environ['HOME'] = str(tmp / 'home')
os.environ['CLAUDE_CONFIG_DIR'] = str(tmp / 'claude')
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'usage-backfill.py')
spec = importlib.util.spec_from_loader('backfill', SourceFileLoader('backfill', path))
bf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bf)
assert bf.PROJECTS == tmp / 'claude' / 'projects', bf.PROJECTS

assert [bf.provider(m) for m in ('claude-opus-5-5', 'gpt-6.1-sol', 'GPT-5.5', 'gpt-5-codex', 'codex-mini-latest', 'o3', 'o4-mini', '', 'mystery')] == \
    ['claude', 'codex', 'codex', 'codex', 'codex', 'codex', 'codex', '', '']

# Every request within one local hour, three hours ago.
hour = int(time.time()) // 3600 * 3600 - 3 * 3600
T0, T1, T2, T3 = ((hour + 60 * n) * 1000 for n in (1, 2, 3, 4))


def entry(session, msg, t, model, counts, sidechain=False):
    i, o, cr, cw = counts
    return {'type': 'assistant', 'timestamp': datetime.fromtimestamp(t / 1000, timezone.utc).isoformat().replace('+00:00', 'Z'),
            'sessionId': session, 'isSidechain': sidechain,
            'message': {'id': msg, 'model': model, 'usage': {'input_tokens': i, 'output_tokens': o,
                        'cache_read_input_tokens': cr, 'cache_creation_input_tokens': cw}}}


def write(name, entries):
    f = bf.PROJECTS / 'proj' / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(''.join(json.dumps(e, separators=(',', ':')) + '\n' for e in entries))


OPUS, SOL = 'claude-opus-5-5', 'gpt-6.1-sol'
write('A.jsonl', [
    entry('A', 'msg_0', T0, OPUS, (10, 1, 0, 0)),
    # One response streamed over two entries: the first has no usage yet.
    entry('A', 'msg_R', T1, OPUS, (0, 0, 0, 0)),
    entry('A', 'msg_R', T1 + 50, OPUS, (5, 50, 100, 20)),
    # A Codex model through the proxy, in a Claude Code session.
    entry('A', 'msg_G', T2, SOL, (7, 3, 0, 0)),
])
# A fork of A, begun at msg_R: its copies, one without usage, count in A.
write('B.jsonl', [
    entry('B', 'msg_R', T1, OPUS, (0, 0, 0, 0)),
    entry('B', 'msg_R', T1 + 50, OPUS, (5, 50, 100, 20)),
    entry('B', 'msg_B', T3, 'mystery', (1, 1, 0, 0)),
])
# A subagent that began with a partial copy of A's last response.
write('A/subagents/agent-x.jsonl', [
    entry('A', 'msg_G', T2, SOL, (7, 1, 0, 0), sidechain=True),
    entry('A', 'msg_S', T3, OPUS, (2, 2, 0, 0), sidechain=True),
])

history = Path(os.environ['HOME']) / '.cache' / 'cliproxy-kit' / 'usage' / 'history.jsonl'


def backfill():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return bf.main()


assert backfill() == 0
got = history.read_text()
rows = [json.loads(line) for line in got.splitlines()]
want = [
    {'t': T1, 'f': T0, 's': 'A', 'acct': '', 'p': 'claude', 'm': OPUS, 'i': 15, 'o': 51, 'cr': 100, 'cw': 20, 'n': 2},
    {'t': T2, 'f': T2, 's': 'A', 'acct': '', 'p': 'codex', 'm': SOL, 'i': 7, 'o': 3, 'cr': 0, 'cw': 0, 'n': 1},
    {'t': T3, 'f': T3, 's': 'A', 'acct': '', 'p': 'claude', 'm': OPUS, 'i': 2, 'o': 2, 'cr': 0, 'cw': 0, 'n': 1, 'a': True},
    {'t': T3, 'f': T3, 's': 'B', 'acct': '', 'p': '', 'm': 'mystery', 'i': 1, 'o': 1, 'cr': 0, 'cw': 0, 'n': 1},
]
assert rows == want, rows

# The same lines whatever order the transcripts are read in.
glob = Path.glob
Path.glob = lambda self, pattern: reversed(list(glob(self, pattern)))
try:
    assert backfill() == 0
finally:
    Path.glob = glob
assert history.read_text() == got

# A fork copies its parent's whole history, so both begin with the same response: the later file is
# the fork, and the copies count in the parent whatever the names.
bf.PROJECTS = tmp / 'forks' / 'projects'
write('z-parent.jsonl', [entry('P', 'msg_P1', T0, OPUS, (1, 1, 0, 0)), entry('P', 'msg_P2', T1, OPUS, (1, 1, 0, 0))])
write('a-fork.jsonl', [entry('F', 'msg_P1', T0, OPUS, (1, 1, 0, 0)), entry('F', 'msg_P2', T1, OPUS, (1, 1, 0, 0)),
                       entry('F', 'msg_F1', T2, OPUS, (1, 1, 0, 0))])
born = bf.born
bf.born = lambda p: {'z-parent.jsonl': 1.0, 'a-fork.jsonl': 2.0}[p.name]
try:
    assert backfill() == 0
finally:
    bf.born = born
counted = {(r['s'], r['n']) for r in map(json.loads, history.read_text().splitlines())}
assert counted == {('P', 2), ('F', 1)}, counted
got = history.read_text()

# No transcripts: the history recovered before stays.
bf.PROJECTS = tmp / 'elsewhere' / 'projects'
assert backfill() == 1
assert history.read_text() == got
print('ok')
