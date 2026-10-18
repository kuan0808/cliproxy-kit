# cliproxy-kit

A Claude Code and Codex kit around CLIProxyAPI: quota-pilot chooses which account serves each session's
requests and records where quota went; quota-band and the usage page show it.

## Language

### Accounts and sessions

**Account**:
A provider sign-in the proxy holds and serves requests with; quota and prompt caches belong to it.
_Avoid_: credential (in prose), auth, key

**Session**:
One Claude Code conversation or Codex thread, as the proxy knows it by its session id.
_Avoid_: conversation (when the proxy's unit is meant), chat

**Binding**:
The account a session's thread is tied to, where its prompt cache lives.
_Avoid_: affinity, pin, assignment

**Bound account**:
The account a session's binding names.
_Avoid_: home account, original account, own account

**Pick**:
quota-pilot's choice of an account for one attempt, among the accounts the proxy offers.
_Avoid_: selection, routing decision

**Attempt**:
One try of a request on one account; a request may take several.
_Avoid_: call, retry (for the attempt itself)

### Failures

**Failure kind**:
Why an attempt failed, as quota-pilot tells it: request, model, hang, connection, timeout, overloaded,
server, rate, quota, sign-in or other.
_Avoid_: error type, cause code

**Hang**:
An attempt that had no response in its first 30 seconds and failed upstream after waiting 30 seconds
or more; a client's cancel is never one.
_Avoid_: stall, timeout (a timeout is a quick failure with a timeout status)

**Failure moment**:
An account's hangs, lost connections, timeouts and 529 or 5xx failures within ten seconds of the first
of them, counted as one; other failures never make one.
_Avoid_: incident, burst, failure event

**Rest**:
quota-pilot's own pause of an account after two failure moments within 15 minutes with no success
between them, during which new sessions avoid it and sessions on it move.
_Avoid_: cooldown (the proxy's), circuit breaker, ban, cooling

**Trial**:
The time after a rest until the account's next success, during which one failure moment rests it again,
for longer.
_Avoid_: probation, half-open

**Cooldown**:
CLIProxyAPI's own pause of one model on one account after a failure, during which the proxy does not
offer that account.
_Avoid_: rest

**Refusal**:
A 429 from an account read as used up.
_Avoid_: rate limit (a 429 on an account with quota left)

### Moving between accounts

**Retry**:
Another attempt of a request on its bound account, which quota-pilot asks for before any failover;
the proxy's request-retry round and Claude Code's own retries are the mechanisms that carry it.
_Avoid_: request-retry, retry round (the mechanisms, not the retry)

**Retry episode**:
The span after a bound account fails during which quota-pilot keeps that binding's requests on it: up
to two retries, one after a hang, each starting within 75 seconds of the failure's end.
_Avoid_: retry window, hold

**Takeover account**:
The account a failover of a session would go to now, as far as the proxy's own listings show; none when
none is known.
_Avoid_: next account, fallback account

**Failover**:
A request served by another account after its bound account failed or was left out; its success moves
the session there.
_Avoid_: switch, fallback (the fallback map moves sessions to another provider)

**Move**:
A change of binding quota-pilot makes; quota-pilot never undoes one on its own.
_Avoid_: switch, migration, detour

**Switch**:
A change of binding the user makes from the band.
_Avoid_: move

**Switch now**:
A switch made with `switch to k•••` while a turn waits: once the switch is applied, the band stops the
waiting turn, and the user's next message goes to the new account.
_Avoid_: skip, force failover, resend

**Cold turn**:
A turn whose prompt cache on the account that serves it is gone, so the whole conversation is written
again.
_Avoid_: cache miss (in prose), cold start
