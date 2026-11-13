# CLIProxyAPI 8.0.66 is the oldest proxy the kit supports

The retry on the bound account ([ADR-0003](0003-retry-on-the-bound-account-first.md)) is carried by
the proxy's own request-retry rounds after quota-pilot declines a pick. CLIProxyAPI 8.0.44 to 8.0.65
end the request at a declined pick instead, with a 503 and quota-pilot's reason; 8.0.66 brought the
rounds back for a decline that follows a failed attempt (upstream commit `ecebc71345`, issue
router-for-me/CLIProxyAPI#7434), and its own tests now guard it. quota-pilot is built against the
newest CLIProxyAPI v8, keeps declining, and supports 8.0.66 and later: the retry then works as
ADR-0003 says, and nothing of the retry changes. Established by running, on 2026-11-14, against
8.0.69 ([Upstream behaviour it relies on](../architecture.md#upstream-behaviour-it-relies-on)).

## Considered Options

- Answer the pick with an error where quota-pilot declines it: the proxy treats an error as a
  failed pick, not a stop, so the retry would stay inside the request on the versions that end it
  at a decline as well (shown through the plugin's real interface on 8.0.64, 8.0.69 and 8.0.16). It
  adds a second way to decline whose only use is proxies older than the fix, every such answer is
  logged by the proxy as a warning, and it rests on how the proxy happens to treat a pick's error,
  which nothing upstream promises, where the decline is the contract upstream restored on request
  and tests.
- Keep the decline and call the oldest proxy that loads quota-pilot (8.0.49) supported, with
  8.0.49 to 8.0.65 as a limitation: "supported" would include proxies on which no retry stays
  inside its request.

## Consequences

It amends ADR-0003's consequences: the retry relies on the proxy contract of 8.0.66 and later. A
quota-pilot built against the newest proxy declares plugin schema 10, which CLIProxyAPI 8.0.48 and
older refuse to load (`plugin schema version 10 is not supported` in the proxy's log), so it does
not run there at all. CLIProxyAPI 8.0.49 to 8.0.65 load it, and there a retry's decline ends its
request with the 503: every retry is one of Claude Code's own, which sends the request again up to
10 times over about three minutes. Updating
needs the proxy first: an older quota-pilot, built for 8.0.16, loads and keeps its retries on 8.0.66
and later, so the proxy can be updated before quota-pilot and not the other way round. A release
that carries this raises the oldest CLIProxyAPI it needs, so it moves the version's middle number
([AGENTS.md](../../AGENTS.md)): this release is 0.2.0.
