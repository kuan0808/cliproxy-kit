# A model's fallback is an automatic route, named by the one fallback map

A model can run out before its account does (Fable's weekly limit), and a session asking for it then
fails until someone picks another model. quota-pilot runs what `fallback_map` names for that model
in its place, by itself within a provider, once the model is used up on every account
([Running another model](../architecture.md#running-another-model-when-one-is-used-up)).
We chose to extend the map that already sent a used-up provider's sessions elsewhere, so there is
one rule and one place to read it, and to act in the proxy, where every request passes.

## Considered Options

- CLIProxyAPI alone: it has no ordered fallback from one model to another when a model's allowance
  runs out; its alias pools rotate across upstream names and fail over only before output.
- The band switches `/model`: Claude Code would know which model it runs, but only between turns
  and only in a session that has the band, so the refused turn fails first, and subagents and
  sessions without a prompt are not covered.
- A second setting, an ordered list for each model: two maps, two triggers and two orders to
  explain, for what following one map again already gives (`claude-fable` to Opus, `claude` to
  Codex).
- A built-in order of models with no setting: which model may stand in for which is a choice of
  price and quality, the owner's.
- Going back as soon as the model can serve again: a second cold write the user did not choose,
  against ADR-0001's reasoning; the route ends by itself only once the session's cache is gone.

## Consequences

Claude Code still believes it runs the model it asked for: the band says which model answers and
offers `back`. Requests are not rewritten, so a target must take the request built for the model it
replaces, as Opus 5.5 does for Fable 5.2. A fallback within Claude relies on the proxy's
`upstream.claude.model-level-cooling: true`; with the default the account that refused Fable is
held back for every model.
