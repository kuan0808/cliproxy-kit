# quota-pilot rests failing accounts itself, counting failure moments

CLIProxyAPI's cooldown does not protect against hangs and dropped connections, the failures that cost
minutes, and cannot tell new sessions from bound ones, so quota-pilot rests an account itself after
two failure moments within 15 minutes with no success between, then keeps it on trial until a
success ([When an account fails](../architecture.md#when-an-account-fails)). Only hangs, lost
connections, timeouts, 529s and 5xx failures count, which keeps rest independent of the proxy's
verdict on every other failure. Counting moments rather than requests keeps one dropped connection,
which fails every request on it at once, from benching a healthy account.

## Considered Options

- Count every failed request (three at once rest the account): one two-minute stall would move every
  session on the account for good although it recovered.
- Rely on CLIProxyAPI's cooldown only: it cools per model, for a fixed time per status (by default 60
  seconds after 408, 5xx and most others, 30 minutes after 401, 402 and 403, 12 hours after 404, an
  exponential backoff after 429, or what a Retry-After or its configuration says), not at all after a
  dropped connection or a timeout that carries no status, and with no memory of repeated 5xx
  failures. That leaves no protection against hangs and dropped connections, which are exactly the
  failures that cost minutes.
- Count every kind but request, quota and model, classifying each failure as the proxy would: needs a
  port of every proxy rule that turns a failure into a request fault or a cooldown, including the
  user's config. Whether a 429, a sign-in refusal or another 4xx is the account's fault at all
  depends on executor error types (a fast-mode entitlement 429 is a request fault), the request's
  kind (compact) and the proxy's own request-scoped error rules, none of which reach quota-pilot;
  counting them would rest healthy accounts whenever quota-pilot's copy of that verdict missed a rule.
- Rests as short as an HTTP load balancer's (Envoy ejects for 30 s, growing to 5 minutes): a failure
  here costs a hang of minutes or a cold write, and only new sessions and the sessions on the account
  are affected.

## Consequences

Rest lives in memory and never changes the proxy's state; it only changes quota-pilot's choice among
offered accounts, and never leaves a provider with no account. One success ends a rest at once, so an
account that alternates failure and success never rests, and each of its failures still gets its
retry.
