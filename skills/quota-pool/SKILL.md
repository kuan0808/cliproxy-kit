---
name: quota-pool
description: Read the pooled quota of every account a CLIProxyAPI proxy routes to, per model, with the quota-pool CLI and the proxy's quota-pilot plugin. Use when deciding whether there is quota to start work on a model served through CLIProxyAPI, or when asked how much quota the proxy's Claude or Codex accounts have left.
---

# quota-pool

`quota-pool` reads quota-pilot's pool document from the proxy with its client key. Run
`quota-pool --help` for the options and the environment it reads.

One call answers one decision: `quota-pool --model <each model the work needs> --floor <percent>`.

## Reading the output

1. Parse all of stdout as one JSON document. It is a reading only when it parses, `schema_version`
   is 1, and it has `models`, each entry with `model`, `verdict`, `unmeasured_because` and `rows`.
   Anything else is the pool unmeasured: say "unmeasured: unreadable document". Exit 0 means only
   that the proxy answered HTTP 200.
2. Exit 3 prints one JSON object with `error`, `code` and `help`: the pool is unmeasured; say so
   with the code. Exit 2 is a usage error in the call.
3. Each model's `verdict`, given `--floor`:
   - `enough`: at least one counting account is read and at or above the floor.
   - `short`: there is a counting account, and every one is read and below the floor.
   - `unmeasured`: `unmeasured_because` says why: `inventory` or `registry` (the proxy's picture
     of its accounts is incomplete), `name_not_registered`, or `unread` (no read account is at
     or above the floor and some account is not read, or no account counts).
   - `not_pooled`: only providers quota-pilot does not read have the name.
   Without `--floor`, `verdict` is `null` and the figures stay.
4. `rows` has one entry per account. `counts` says whether it counts, `why_not` why not, and
   `weekly_left` is the percent of its weekly quota left when `weekly_read` is true. The ranking
   fields (`tier`, `blocked`, `reason`) are the proxy's estimate of where a new session goes and
   enter no verdict. `accounts` holds each account's windows with `read_at` and `stale`, and
   `read_failure` when its last read failed.

## Names

- Ask with a name the proxy lists for clients. A name no account has registered answers
  `unmeasured` with `name_not_registered`, even when the proxy would serve it through a prefix or
  an alias.
- A listed name that hides its model family (an alias) is judged on the all-models week alone, so
  `enough` for it does not show that the model's own week has quota left.

## Codex credits

On a Codex account, branch on `credits.state` (`unlimited`, `some`, `none`, `unknown`) and
`credits.stale`. `credits.balance` is the provider's figure as read, in its own credits: do not
copy it into a commit, a PR, an issue, a report or any other file.
