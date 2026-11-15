# An agent reads the pool with a client key, and that read may poll the providers

An agent deciding whether there is quota to start work could read only the one account it is
signed in to, so it reported quota as too low while the proxy's other accounts still had plenty.
quota-pilot already holds every account's windows and ranks them, so it answers
`GET /v0/resource/plugins/quota-pilot/pool` under the band's client-key rule: every account the
host holds and, per model asked, the accounts that serve it (the host's registry, through
`host.auth.models`), each one's weekly figure and a verdict against the caller's floor
([The pool](../architecture.md#the-pool)). The GET may make the plugin read the providers: the
accounts not read within twice `idle_poll_minutes`, or holding a weekly window whose reset has
passed, within 10 seconds and at most once a minute whoever asks. `quota-pool` is transport only:
it sends the request with a key from its environment and prints the answer unchanged.

## Considered Options

- The management snapshot: it has the figures, but the management key administers the whole proxy,
  no agent should hold it, and no agent's environment has it.
- A reader of its own beside the proxy: it would need every account's token on the agent's machine
  and repeat quota-pilot's readings and window rules, which two copies would then have to agree on.
- No read on demand: the answer would be as old as the last poll, which pauses while the proxy is
  idle, so an agent asking after a quiet hour would find every account stale and the pool
  unmeasured.
- The command inside the band plugin (`bin/`): installed and updated for free, but claude.ai and
  Cowork do not install a plugin with that folder, so it would cut the band's own reach, and other
  harnesses need a standalone file anyway.

## Consequences

Every client key the proxy accepted reads what the band reads and more: each Codex account's credit
balance, how many models each account has registered, why a read failed and the plugin's version;
and it can make the plugin read early, at most once a minute. The README's privacy section says so.
A resource handler now polls, so a `/pool` answer can take up to 10 seconds. Agents are built on
the document, which is what makes this hard to undo: fields are only added under `schema_version`
1, and a field that changes meaning raises it. The resource handler answers only the paths it
knows, so a missed branch never falls through to the management snapshot.
