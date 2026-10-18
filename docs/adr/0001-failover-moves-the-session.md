# A failover moves the session; quota-pilot does not bring it back

When another account answers a session's request after its bound account failed, the binding moves to
that account, the move is recorded with its cause, and the band offers `switch back`; quota-pilot never
moves the session back on its own. A return is only worth it when the old account can still serve the
conversation from its prompt cache, and that cannot be known from the proxy: it depends on Anthropic's
exact matching (model, request settings such as effort or speed, the message history, where the
breakpoints sit, each entry's own lifetime) and on which request a pick is for, which CLIProxyAPI's
pick does not say. A wrong guess costs a second cold write, while staying on the account that just
answered costs nothing more, as its cache is warm.

## Considered Options

- Return while "cheap": every check of whether the old cache can still be read had a case it got wrong,
  and the only way to tell the pick which request it serves (an internal header from the request
  interceptor) cannot be removed before the request goes upstream: the plugin host merges an
  interceptor's headers but drops its `ClearHeaders`.
- Return as a best guess, logging the cost: keeps a known risk of the very cost this sets out to cut.

## Consequences

The cache is protected before a failover instead, by the retry rule (ADR-0003). The move notice offers
`switch back`, so going back stays one press away and is the user's choice.
