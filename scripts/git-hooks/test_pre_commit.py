"""Checks the hook reads every secret a proxy configuration holds: python3 scripts/git-hooks/test_pre_commit.py"""
import importlib.util
import os
import re
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
print('ok')
