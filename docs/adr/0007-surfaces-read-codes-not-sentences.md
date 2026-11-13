# The surfaces read the plugin's codes, never its sentences

quota-pilot is the only place that decides (which account, which model, why), and the band and the
page only show it ([quota-pilot](../architecture.md#quota-pilot)). Until 0.1.19 they found out what
was decided by matching the plugin's English (`switch_reason` starting with `resting`, a reason
ending in `used up`, a map of seven sentences in the ledger), so rewording either side silently
changed which row showed and whether a turn counted as cold. From 0.2.0 every fact a surface acts
on travels as a code beside the sentence (`reason_code`, `switch_kind`, `route_stop`, the parsed
`fallback_rules`), each surface words it itself, and the sentences stay only for older bands and
the log.

## Considered Options

- Keep matching, with a shared fixture of sentences: catches a reworded sentence in tests, but two
  surfaces in two languages still parse prose, and a new reason needs three edits.
- Raise `schema_version` and drop the sentences: every band older than the plugin would refuse the
  snapshot, and bands update days apart from the plugin.

## Consequences

A band is released before the plugin it describes reaches the proxy, so a band works with the
plugin of the release before it: it reads a code when it is there, and one function keeps the old
matching for a plugin that sends none. That function is deleted only by a release that raises the
band's stated minimum plugin version. The band ([quota-band](../architecture.md#quota-band))
carries that minimum as one constant and says so, once, when the proxy runs an older quota-pilot.
