"""Checks quota-pool against a local stub of the proxy: the key never shows, the address and key
are taken as a pair, the query arrives encoded, no redirect is followed, and each answer comes out
as the contract says: python3 scripts/test_quota_pool.py

Nothing of this machine is read and no proxy is reached: each run has an environment of its own,
with a made-up key, and a curl on PATH that notes its arguments before running the real one."""
import json
import os
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'quota-pool.sh')
KEY = 'made-up-pool-key-' + 'Q' * 12
OTHER = 'made-up-other-key-' + 'W' * 12
DOC = '{"schema_version":1,"models":[]}\n'
POOL = '/v0/resource/plugins/quota-pilot/pool'

seen = []  # (path, raw query, Authorization) of each request the stub got
reply = {'status': 200, 'headers': {}, 'body': DOC.encode()}


class Stub(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = urlsplit(self.path)
        seen.append((parts.path, parts.query, self.headers.get('Authorization')))
        self.send_response(reply['status'])
        for name, value in reply['headers'].items():
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(reply['body'])))
        self.end_headers()
        self.wfile.write(reply['body'])

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
url = f'http://127.0.0.1:{port}'

tmp = tempfile.mkdtemp()
home = os.path.join(tmp, 'home')
os.makedirs(home)
# A curl that notes its arguments, one per line, then runs the real one; with CURL_STOP set it stops
# there, as a curl that could not connect does.
real_curl = shutil.which('curl')
bin_dir = os.path.join(tmp, 'bin')
os.makedirs(bin_dir)
argv_log = os.path.join(tmp, 'curl-argv')
with open(os.path.join(bin_dir, 'curl'), 'w') as f:
    f.write(f'#!/bin/sh\nprintf "%s\\n" "$@" >> "{argv_log}"\n[ -z "${{CURL_STOP:-}}" ] || exit 7\nexec "{real_curl}" "$@"\n')
os.chmod(os.path.join(bin_dir, 'curl'), stat.S_IRWXU)


def run(*args, env=None, shell=('bash',)):
    """Runs quota-pool with only the environment given (and PATH, HOME): never the caller's."""
    seen.clear()
    if os.path.exists(argv_log):
        os.remove(argv_log)
    full = {'PATH': bin_dir + os.pathsep + os.environ['PATH'], 'HOME': home}
    full.update(env or {})
    p = subprocess.run([*shell, SCRIPT, *args], env=full, capture_output=True, timeout=30)
    argv = open(argv_log).read() if os.path.exists(argv_log) else ''
    return p.returncode, p.stdout, p.stderr.decode(), argv


def failed(code, got):
    status, out, err, _ = got
    assert status == 3, (status, out, err)
    doc = json.loads(out)
    assert set(doc) == {'error', 'code', 'help'} and doc['code'] == code, doc
    return doc


pair = {'QUOTA_POOL_URL': url, 'QUOTA_POOL_KEY': KEY}

# A reading: the body exactly as served, the key in the header and nowhere else.
status, out, err, argv = run('--model', 'claude-opus-5-5', env=pair)
assert (status, out) == (0, DOC.encode()), (status, out, err)
assert seen == [(POOL, 'model=claude-opus-5-5', 'Bearer ' + KEY)], seen
assert KEY not in argv and KEY not in err and argv.startswith('-q\n'), argv

# Not under an inherited trace either, nor with a .curlrc that prints headers, writes a trace or
# follows redirects, in CURL_HOME or in HOME.
curl_home = os.path.join(tmp, 'curl-home')
os.makedirs(curl_home)
trace = os.path.join(tmp, 'trace.txt')
for folder in (curl_home, home):
    with open(os.path.join(folder, '.curlrc'), 'w') as f:
        f.write(f'verbose\ntrace-ascii = "{trace}"\nlocation\n')
for shell, extra in ((('bash', '-x'), {}), (('bash',), {'SHELLOPTS': 'xtrace'}), (('bash',), {'CURL_HOME': curl_home})):
    status, out, err, argv = run('--model', 'm', env={**pair, **extra}, shell=shell)
    assert status == 0 and KEY not in err and KEY.encode() not in out and KEY not in argv, (shell, extra, err)
    assert 'Authorization' not in err and not os.path.exists(trace), (shell, extra, err)

# The pairs are never mixed: a QUOTA_POOL_URL without its key sends none, and a QUOTA_POOL_KEY
# without its address is not sent to the other one.
run(env={'QUOTA_POOL_URL': url, 'ANTHROPIC_AUTH_TOKEN': OTHER, 'ANTHROPIC_API_KEY': OTHER})
assert seen == [(POOL, '', None)], seen
run(env={'QUOTA_POOL_KEY': KEY, 'ANTHROPIC_BASE_URL': url + '/', 'ANTHROPIC_AUTH_TOKEN': OTHER})
assert seen == [(POOL, '', 'Bearer ' + OTHER)], seen
run(env={'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_AUTH_TOKEN': '', 'ANTHROPIC_API_KEY': KEY})
assert seen == [(POOL, '', 'Bearer ' + KEY)], seen

# The query arrives encoded, whatever the model id holds.
odd = 'claude-opus-5-5[1m] & x=1'
run('--model', odd, '--model', 'gpt-6-sol', '--floor', '15.5', env=pair)
assert parse_qs(seen[0][1]) == {'model': [odd, 'gpt-6-sol'], 'floor': ['15.5']}, seen
assert '&' not in seen[0][1].split('&')[0][len('model='):], seen

# An address is http(s), and over http only the loopback names go without ALLOW_HTTP=1.
failed('NO_PROXY_URL', run(env={}))
failed('NO_PROXY_URL', run(env={'QUOTA_POOL_URL': 'ftp://127.0.0.1', 'QUOTA_POOL_KEY': KEY}))
failed('NO_PROXY_URL', run(env={'QUOTA_POOL_URL': '127.0.0.1:8317', 'QUOTA_POOL_KEY': KEY}))
for address in ('http://127.0.0.2:9', 'http://localhost.example:9', 'http://localhost@remote.example:9',
                'http://user:hunter2@127.0.0.1:9', 'http://192.168.0.9:9/'):
    got = run(env={'QUOTA_POOL_URL': address, 'QUOTA_POOL_KEY': KEY})
    doc = failed('KEY_OVER_HTTP', got)
    assert got[3] == '' and '@' not in doc['error'] and 'hunter2' not in doc['error'], (address, doc)
    got = run(env={'QUOTA_POOL_URL': address, 'QUOTA_POOL_KEY': KEY, 'ALLOW_HTTP': '1', 'CURL_STOP': '1'})
    assert got[3] != '' and json.loads(got[1])['code'] != 'KEY_OVER_HTTP', (address, got)
status, out, err, argv = run(env={'QUOTA_POOL_URL': f'HTTP://LocalHost:{port}', 'QUOTA_POOL_KEY': KEY})
assert status == 0 and seen == [(POOL, '', 'Bearer ' + KEY)], (status, err, seen)
got = run(env={'QUOTA_POOL_URL': 'https://remote.example:9', 'QUOTA_POOL_KEY': KEY, 'CURL_STOP': '1'})
assert got[3] != '' and json.loads(got[1])['code'] == 'PROXY_UNREACHABLE', got

# A body that is no reading still comes out as it was, with exit 0: the reader's parse fails.
for body in (b'<!doctype html><title>Sign in</title>\n', b'{"schema_version":1,"mod', b''):
    reply['body'] = body
    status, out, err, _ = run(env=pair)
    assert (status, out) == (0, body), (body, status, out, err)
reply['body'] = DOC.encode()

# Each other answer is exit 3 with its code; a redirect is not followed.
for answer, code in ((401, 'KEY_NOT_ACCEPTED'), (404, 'POOL_NOT_SUPPORTED'), (500, 'PROXY_ERROR'), (302, 'PROXY_ERROR')):
    reply.update(status=answer, headers={'Location': url + '/elsewhere'} if answer == 302 else {})
    doc = failed(code, run(env=pair))
    assert len(seen) == 1 and str(port) in doc['error'], (answer, seen, doc)
reply.update(status=200, headers={})
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    closed = s.getsockname()[1]
doc = failed('PROXY_UNREACHABLE', run(env={'QUOTA_POOL_URL': f'http://127.0.0.1:{closed}', 'QUOTA_POOL_KEY': KEY}))
assert doc['error'] == f'the proxy did not answer at http://127.0.0.1:{closed}', doc

# A usage error is exit 2, said on stderr, and sends nothing.
for args in (('--floor', '15'), ('--model',), ('--floor',), ('--bogus',), ('-h',), ('--model=m',),
             ('--floor=15',), ('--model', 'm', '--floor=15'), ('--model', 'm', '--floor', '15', '--floor', '20'),
             *(('--model', 'm', '--floor', bad) for bad in ('', '-1', '+5', '1e1', 'NaN', '100.5', '101',
               '0100.1', '100.000000000000001', '0100.000000000000001', '000101', '9' * 400, '.5', '5.'))):
    status, out, err, argv = run(*args, env=pair)
    assert status == 2 and out == b'' and err.startswith('quota-pool: ') and seen == [] and argv == '', (args, status, out, err)
for good in ('0', '100', '100.00', '0100.00', '000100.000', '007', '15.25', '99.99', '0' * 400 + '100.00'):
    status, _, err, _ = run('--model', 'm', '--floor', good, env=pair)
    assert status == 0, (good, err)
    assert parse_qs(seen[0][1]) == {'model': ['m'], 'floor': [good]}, seen
status, out, err, _ = run('--help', env=pair)
assert status == 0 and out.startswith(b'Usage: quota-pool') and seen == [], (status, err)

server.shutdown()
shutil.rmtree(tmp)
print('quota-pool: all checks passed')
