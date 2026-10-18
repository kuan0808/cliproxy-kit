# quota-pilot rests failing accounts itself, counting failure moments

An account rests (new sessions avoid it whenever another account can serve, sessions on it move) after
two failure moments within 15 minutes with no success in between, where the failures within ten
seconds of a moment's first failure are one moment; the rest lasts 5 minutes. Then the account is on
trial: one more failure moment before a success rests it again at once, however long after the last
one, for 10, 20, 40, then 60 minutes; one success ends it. CLIProxyAPI already cools an account after a
failure, but per model, for a fixed time per status (by default 60 seconds after 408, 5xx and most
others, 30 minutes after 401, 402 and 403, 12 hours after 404, an exponential backoff after 429, or what
a Retry-After or its configuration says), not at all after a dropped connection or a timeout that
carries no status, and with no memory of repeated 5xx failures; and it cannot tell new sessions from
bound ones. Counting moments rather than requests keeps one dropped connection, which fails every
request on it at once, from benching a healthy account; a failure's moment is when it ended, so
requests that hung from different times and failed together are one moment. The rests are longer than
an HTTP load balancer's (Envoy ejects for 30 s, growing to 5 minutes) because a failure here costs a
hang of minutes or a cold write, and only new sessions and the sessions on the account are affected;
one success still ends a rest at once, so an account that alternates failure and success never rests,
and each of its failures still gets its retry.

Only hangs, lost connections, timeouts, 529s and 5xx failures count toward rest. After a 429, a
sign-in refusal or another 4xx the proxy already cools the account for as long as it judges, and
whether such a failure is the account's fault at all is the proxy's verdict: it depends on executor
error types (a fast-mode entitlement 429 is a request fault), the request's kind (compact) and the
proxy's own request-scoped error rules, none of which reach quota-pilot. Counting them would rest
healthy accounts whenever quota-pilot's copy of that verdict missed a rule; leaving them out keeps rest
independent of it.

## Considered Options

- Count every failed request (three at once rest the account): one two-minute stall would move every
  session on the account for good although it recovered.
- Rely on CLIProxyAPI's cooldown only: no protection against hangs and dropped connections, which are
  exactly the failures that cost minutes.
- Count every kind but request, quota and model, classifying each failure as the proxy would: needs a
  port of every proxy rule that turns a failure into a request fault or a cooldown, including the
  user's config.

## Consequences

Rest lives in memory and never changes the proxy's state; it only changes quota-pilot's choice among
offered accounts, and never leaves a provider with no account.
