"""Checks the hook reads every secret a proxy configuration holds, and the client keys Claude Code and
Codex send to the proxy: python3 scripts/git-hooks/test_pre_commit.py"""
import importlib.util
import json
import os
import re
import tempfile
from importlib.machinery import SourceFileLoader

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pre-commit')
spec = importlib.util.spec_from_loader('hook', SourceFileLoader('hook', path))
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

conf = r'''
host: ""
port: 8317
api-keys: # client keys
  - plain-key-one # the laptop
  # - retired-key
  - "\x41scii\U0000002Dkey\/x"
  - 'it''s-a-key'
  - mid#hash-key
  - 0x1F2E3D4C
  - &shared shared-key-1
remote-management:
  secret-key: "$2a$10$hashed"
claude-api-key:
  - api-key: upstream-key-1
    base-url: https://api.example.com
plugins:
  configs:
    quota-pilot:
      band_tokens: [ "inline]one" , inline-two, # user's laptop
        'inline-three', *shared ]
      min_five_hour_left_percent: 25
'''
got = hook.config_secrets(conf)
want = ['plain-key-one', 'Ascii-key/x', "it's-a-key", 'mid#hash-key', '0x1F2E3D4C', 'shared-key-1',
        '$2a$10$hashed', 'upstream-key-1', 'inline]one', 'inline-two', 'inline-three', 'shared-key-1']
assert got == want, got
assert hook.config_secrets('') == []

# Keys put together here, so this file does not hold one the hook would refuse.
shapes = re.compile('|'.join(hook.SHAPES), re.IGNORECASE)
assert shapes.search('Authorization: Bearer sk-' + 'proj-' + 'X' * 24)
assert shapes.search('ANTHROPIC_API_KEY=sk-' + 'ant-api03-' + 'X' * 20)
assert not shapes.search('the task-reassignment-handler-for-sessions')

# Client keys of no secret's shape, kept only in Claude Code's and Codex's settings or the
# environment, in the folders CLAUDE_CONFIG_DIR and CODEX_HOME name. Nothing of this machine is read.
tmp = tempfile.mkdtemp()
for folder in ('home', 'claude', 'codex'):
    os.makedirs(os.path.join(tmp, folder))
claude_key, codex_key, env_key, named_key = ('client-' + name + '-' + 'Q' * 10 for name in ('claude', 'codex', 'env', 'named'))
email = 'tester' + '.' + 'x' * 3 + '@example.test'
assert not any(shapes.search(k) for k in (claude_key, codex_key, env_key, named_key))
with open(os.path.join(tmp, 'claude', 'settings.json'), 'w') as f:
    json.dump({'env': {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:8317', 'ANTHROPIC_AUTH_TOKEN': claude_key}}, f)
with open(os.path.join(tmp, 'claude', '.claude.json'), 'w') as f:
    json.dump({'oauthAccount': {'emailAddress': email}}, f)
with open(os.path.join(tmp, 'codex', 'config.toml'), 'w') as f:
    f.write('model_provider = "cliproxyapi"\n\n[model_providers.cliproxyapi]\n'
            'base_url = "http://127.0.0.1:8317/v1"\n'
            f'experimental_bearer_token = "{codex_key}"\nenv_key = "PROXY_CLIENT_KEY_VARIABLE"\n')
os.environ.update(HOME=os.path.join(tmp, 'home'), CLAUDE_CONFIG_DIR=os.path.join(tmp, 'claude'),
                  CODEX_HOME=os.path.join(tmp, 'codex'), ANTHROPIC_AUTH_TOKEN=env_key, CLIPROXY_CONFIG='',
                  PROXY_CLIENT_KEY_VARIABLE=named_key)
os.environ.pop('ANTHROPIC_API_KEY', None)
hook.HOME = os.environ['HOME']
hook.run = lambda *cmd: ''  # no keychain, no Tailscale
details = hook.private_details()
assert {claude_key, codex_key, env_key, named_key, email} <= details, 'a client key or account was missed'
assert 'PROXY_CLIENT_KEY_VARIABLE' not in details, "Codex's env_key names a variable: its value is the key"
assert hook.toml('') is None
print('ok')
