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
The account chosen to serve a session's conversation thread.
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
none is known. The band calls it `next`.
_Avoid_: fallback account

**Failover**:
A request served by another account after its bound account failed or was left out; its success moves
the session there.
_Avoid_: switch, fallback (a fallback runs another model)

**Fallback**:
The model a session runs in place of the one it asks for, by a fallback rule and without the user's
press, while that one is used up on every account.
_Avoid_: failover (another account, same model), downgrade

**Move**:
A change of binding quota-pilot makes; quota-pilot never undoes one on its own.
_Avoid_: switch, migration, detour

**Switch**:
A change of binding the user makes from the band.
_Avoid_: move

**Switch now**:
A switch made with `switch to k•••` while a turn waits; the
[band's press contract](docs/architecture.md#quota-band) defines when it stops the turn.
_Avoid_: skip, force failover, resend

**Cold turn**:
A turn whose prompt cache on the account that serves it is gone, so the whole conversation is written
again.
_Avoid_: cache miss (in prose), cold start

### Quota

**Window**:
A span over which a provider meters an account: 5-hour, Weekly, or a model's own week (Weekly Fable).
_Avoid_: bucket, period

**Reading**:
A window's used share as the provider last reported it, with the time it was read.
_Avoid_: poll, sample

**Used up**:
A window with nothing left in its latest reading; freshness and reset rules live in
[Choosing an account](docs/architecture.md#choosing-an-account).
_Avoid_: exhausted (in prose), depleted

**Low**:
An account with too little quota left to rank as ready;
[Choosing an account](docs/architecture.md#choosing-an-account) defines the thresholds.
_Avoid_: nearly used up

**Label**:
An account's short public name (`k•••`).
_Avoid_: alias, masked email

### Running another model

**Route**:
A session's standing order to run another model than the one it asks for, kept by quota-pilot until it
ends.
_Avoid_: redirect, override

**Fallback rule**:
One entry of the fallback map: what runs in place of a provider's models, or of one model.
_Avoid_: mapping

**Use**:
The user's choice of a route, from the band.
_Avoid_: route (as a verb), switch (a switch changes the account)

**Back**:
The end of a route, after which the session runs the model it asks for; the band says `back` of nothing
else.
_Avoid_: return, unroute (in prose)

**Stop**:
Why a fallback rule cannot run now, as quota-pilot or the ledger found it.
_Avoid_: blocker, error

### Surfaces

**Ledger**:
The page's view of every account with its windows, its place in the order and its fallback rules.
_Avoid_: dashboard, accounts page

**Usage view**:
The page's view of where quota went, by project and session.
_Avoid_: report (the report is the data behind it), analytics

**Band**:
quota-band's rows above the Claude Code prompt: one row of words over a row of tiles.
_Avoid_: status bar, banner

**Tile**:
One box of the band: Account, a window, Context, Cache or Accounts.
_Avoid_: card (the desktop app's drawing of a tile), widget

**Pane**:
The band's list of every account, window, fallback rule and setting, opened with `quota`.
_Avoid_: panel (the panel is CLIProxyAPI's), sidebar

**Notice**:
What came of the user's own press; [quota-band](docs/architecture.md#quota-band) defines its lifetime
and priority.
_Avoid_: toast, alert

**Alert**:
A row that says something is wrong or about to change; it stays while that is true.
_Avoid_: warning (in prose), notice

**Note**:
A row that tells what quota-pilot did; the user dismisses it.
_Avoid_: notice, log

### Words in zh-TW

One word per thing in every zh-TW text (the page's locale, `README.zh-TW.md`):

| English | zh-TW | Not |
| --- | --- | --- |
| plugin | 外掛 | 插件 |
| session | session | 工作階段 |
| quota | 額度 | 配額 |
| account | 帳號 | 憑證 |
| window (of quota) | 時段 | 視窗 |

A name the panel itself shows is quoted as the panel shows it.
