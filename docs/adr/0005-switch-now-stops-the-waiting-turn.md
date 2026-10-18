# Switch now switches the session, then stops the waiting turn

While a turn waits on a failing account (a hang, its retry, or a wait for a retry), the band offers
`switch to k•••`. A press sends today's switch; only after quota-pilot has applied it does the band stop
the turn (`$.turn.abort`), which cancels the stalled request through Claude Code's own cancel. Nothing
is sent for the user: their next message, any text, carries the conversation, the stopped turn's
finished steps included, to the new account. The band says so (`send a message to go on`). We chose to
switch first so that a refused switch leaves the turn waiting rather than gone, and to stop rather than
send the turn again because sending it again could not be made safe from the band's side. The retry
after a hang stays the default; the button is for whoever would rather not wait.

## Considered Options

- Send the stopped turn again automatically, one line from quota-band: nothing to retype, but the band cannot see when the proxy has really dropped the old request (Claude Code's abort
  resolves before the proxy has seen the cancel), whether Claude Code still holds a message the user
  queued, or whether its own line entered (a hook may answer for a call; the engine wraps a plugin's
  prompt). Each guard added a signal across two processes, completion events, message digests, turn
  events, and each brought new races, so it was dropped.
- Restart the stalled step in place (a second `next(e)` in the band's `turn.step` hook): same turn, but
  the stalled request is never cancelled. Against a stub upstream with Claude Code 2.1.302 it stayed
  open until the process exited.
- Esc, then send again by hand: works only during a hang's retry (the `hung` mark). Kept as the
  keyboard route.
- Switch automatically after some seconds: decides for the user what waiting is worth; the retry is
  the default and the press is the user's choice.
- Stop the turn first, then switch: a refused switch would leave the turn gone with nothing to show.

## Consequences

The user types one message after a press, and the band says so until a turn has started. An old request
that still picks k••• in the moment before the stop reaches the proxy (its attempt drops and the proxy's
next round picks, or a retry sent just before the stop arrives late) is cancelled with its turn; if the
next message reaches k••• before that request has begun answering, both may pay a cold write there, as a
cache entry is readable only once its response has begun. That rare second write is a known limit. The
band takes the stopped turn's own `turn.complete`, however late, as proof that it stopped, since a hook
may hold the abort or the end back; until it comes the band says the stop is not yet confirmed and never
calls the abort again. The press is one operation: in asking and sending it goes void at the step's first
content, the step's or the turn's end, a session change, a refusal or 5 s without an acknowledgement, so
a late acknowledgement never stops a later turn; in stopping only a session change voids it. quota-pilot
checks the target again when it applies the switch, so a press made on a stale screen is refused. A
script beside the band's tests rechecks the abort on the Claude Code version in use before a release
that touches the press.
