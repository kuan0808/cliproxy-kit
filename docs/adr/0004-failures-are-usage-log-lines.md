# Failures and binding events share the usage log

Every failed attempt, retry and move is recorded in the usage log (`usage/YYYY-MM.jsonl`, three
months), a failed attempt in exactly one of three ways: one that carries tokens keeps its request line
(its usage and any reading) with the failure added; one without tokens but with a quota reading stays
today's `poll: true` reading line with the failure added; one with neither, and every retry and move,
is a pure `poll: true` line, so every reader that counts requests keeps skipping it. No line holds error text, headers or request content. One log keeps one writer,
one retention and one place to read an incident from. The readers change in one way: a pure failure or
event line is left out of every report (it adds no account, provider, capacity or coverage), so the
report's numbers do not move; only the events query and the failure-only session rows read it.

## Considered Options

- A separate failure file: a second writer and pruner for a handful of lines a day.
- Memory only: lost at a restart, and the next diagnosis would again have nothing.
