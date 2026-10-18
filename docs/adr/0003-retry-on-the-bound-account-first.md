# Retry on the bound account before any failover, by declining the pick

Before another account may take a failed request, quota-pilot has the bound account tried again (up to
2 retries, 1 after a hang, each starting within 75 seconds) by declining the proxy's pick of any other
account: the proxy's own request-retry round tries the bound account again for the failures it retries
(connection errors, 408, 429, 5xx it lists), at once when the account is not cooling, and Claude Code's
own retries carry the rest (529, other 5xx, a bare deadline, every case when the proxy runs no further
round, and any wait through a cooldown, only for Claude Code sessions of 100k tokens or more); a
failure nothing would retry is not declined, and Codex sessions are never declined, as quota-pilot
cannot see the proxy's `request-retry` setting. The pick carries no request identity, so an episode is
per binding and model, and every request of that binding waits with it. A hang gets one retry, as a
hang may come from one stuck connection, which a hang that ends at the connection leaves unusable, so
the retry gets another (one that ends with a late status may reuse it); a retry that hangs is not
retried, and once a hang's retry has failed without an answer the bound account is skipped until
something succeeds. We chose declining because a scheduler cannot pick an account the proxy did not
offer, and the retry is the only way to avoid a failover's cold write, as a failover's move stands
(ADR-0001).

## Considered Options

- Fail over at once (the old behaviour): fastest turn, a cold write every time an account fails.
- Retry only fast failures, quietly: would not help the failures that keep the account out for a minute.
- Hold the request inside the pick: the proxy builds the candidate list before the pick, so waiting
  there cannot bring the bound account back.
- Never retry after a hang: the fastest move, but a stuck connection would cost a cold write every time.

## Consequences

The retry relies on CLIProxyAPI behaviour pinned by a contract test (a declined pick after a failed
attempt ends the round with that error; the next round offers the bound account; a declined pick alone
answers 503) and on Claude Code retrying 5xx for more than two minutes. A wait shows in the band and as
Claude Code's own `API error · Retrying` line. Nothing cuts a hang's retry short if it hangs too:
through a proxy Claude Code has no first-byte limit, only its request timeout (`API_TIMEOUT_MS`, 10
minutes), so the band counts the retry's seconds and offers `switch to k•••`, which moves the session
and stops the waiting turn at once, so the next message goes there (ADR-0005); Esc during that retry,
then sending again, also moves the session on.
