// The expected wording of the band's rows (`rows`, the band's alone) and of every move (`moves`,
// which the plugin's Codex notice says too), read by tests/band.test.ts and by plugin/codex_test.go, which
// reads what follows `export default` as JSON: keep it JSON (double quotes, no trailing commas).
export default {
  "about": "Why a session moved off d••• to k•••, worded from its switch record: the band's move row reads 'Switched d••• → k••• · ' and `why` (its short form ends in `short` instead), and the Codex notice says the same `why`.",
  "rows": [
    { "name": "waiting for a retry", "row": "waiting", "args": ["d•••", { "kind": "overloaded", "status": 529 }, 50000, false, 75, "k•••", false], "text": "d••• returned HTTP 529 · retrying it in about 50s; k••• is next if needed", "short": "d••• returned HTTP 529 · retrying in 50s" },
    { "name": "waiting, the retry due now", "row": "waiting", "args": ["d•••", { "kind": "overloaded", "status": 529 }, 0, false, 75, "k•••", false], "text": "d••• returned HTTP 529 · retrying it now; k••• is next if needed", "short": "d••• returned HTTP 529 · retrying now" },
    { "name": "waiting, no other account with quota", "row": "waiting", "args": ["d•••", { "kind": "overloaded", "status": 529 }, 50000, false, 75, null, true], "text": "d••• returned HTTP 529 · retrying it in about 50s; no other account has quota", "short": "d••• returned HTTP 529 · retrying in 50s" },
    { "name": "waiting past the give-up", "row": "waiting", "args": ["d•••", { "kind": "server", "status": 503 }, 119000, true, 75, "k•••", false], "text": "d••• returned HTTP 503 · waiting up to 75s for it; k••• is next if needed", "short": "d••• returned HTTP 503 · waiting up to 75s" },
    { "name": "a retry running", "row": "running", "args": ["d•••", { "kind": "hang", "wait_ms": 135000 }, 40000, "k•••", false], "text": "d••• hung for 2m 15s · retrying it, 40s so far; k••• is next if needed", "short": "d••• hung · retrying it, 40s so far" },
    { "name": "no answer, an account to take over", "row": "hangWatch", "args": [45000, true], "text": "no answer for 45s · if it fails, a retry or another account takes over", "short": "no answer for 45s" },
    { "name": "no answer, none to take over", "row": "hangWatch", "args": [45000, false], "text": "no answer for 45s" },
    { "name": "a retry that worked after a 529", "row": "kept", "args": ["d•••", { "kind": "overloaded", "status": 529 }, 61000, 400000], "text": "Stayed on d••• after HTTP 529 · the retry 61s later worked; cache kept", "short": "Stayed on d••• · retry worked" },
    { "name": "a retry that worked after a lost connection", "row": "kept", "args": ["d•••", { "kind": "connection" }, 100, 400000], "text": "Stayed on d••• after a lost connection · the retry worked; cache kept", "short": "Stayed on d••• · retry worked" },
    { "name": "a retry that worked after a hang, reading no cache", "row": "kept", "args": ["d•••", { "kind": "hang", "wait_ms": 135000 }, 300, 0], "text": "Stayed on d••• after a 2m 15s hang · the retry worked", "short": "Stayed on d••• · retry worked" },
    { "name": "resting, a move next turn", "row": "movesNext", "args": ["d•••", "resting after 2 failures", "k•••", "3% used"], "text": "d••• resting after 2 failures · moves to k••• (3% used) on the next turn", "short": "d••• resting · moves to k••• next turn" },
    { "name": "no answer, a move next turn", "row": "movesNext", "args": ["d•••", "got no answer", "k•••", "3% used"], "text": "d••• got no answer · moves to k••• (3% used) on the next turn", "short": "d••• got no answer · moves next turn" },
    { "name": "switch now, asked", "row": "pressAsk", "args": ["k•••", "rewrites 160k tokens, ≈$1.28 at API prices ($0.03 warm)"], "text": "Switch to k••• now? This turn stops; your next message starts cold there: it rewrites 160k tokens, ≈$1.28 at API prices ($0.03 warm)", "short": "Switch to k•••? Stops turn; cold" },
    { "name": "moved by you while waiting, the turn stopped", "row": "moved", "args": ["d•••", "k•••", { "why": "by you after waiting 2m 55s", "short": "by you" }, true], "text": "Switched d••• → k••• · by you after waiting 2m 55s; send a message to go on", "short": "Switched d••• → k••• · send a message to go on" },
    { "name": "moved by you while waiting, nothing stopped", "row": "moved", "args": ["d•••", "k•••", { "why": "by you after waiting 2m 55s", "short": "by you" }], "text": "Switched d••• → k••• · by you after waiting 2m 55s", "short": "Switched d••• → k••• · by you" },
    { "name": "a press whose stop is not confirmed yet", "row": "stopUnconfirmed", "args": ["k•••"], "text": "Switched to k•••; the turn's stop is not confirmed yet" },
    { "name": "a refused press", "row": "pressRefused", "args": ["k•••", "k••• cannot take the session now"], "text": "Could not switch to k•••: k••• cannot take the session now", "short": "Could not switch to k•••" },
    { "name": "a press with no answer", "row": "pressUnanswered", "args": [], "text": "No answer from the proxy within 5s; the turn keeps waiting" }
  ],
  "moves": [
    {
      "name": "a hang (2026-10-11, once worded 'd••• was unavailable')",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "hang",
          "wait_ms": 135000,
          "count": 1
        }
      },
      "why": "d••• hung for 2m 15s",
      "short": "d••• hung"
    },
    {
      "name": "a hang whose retry got no answer",
      "switch": { "kind": "failed", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "hang", "wait_ms": 135000, "count": 1, "retries": 1, "last_retry": { "kind": "request", "status": 499, "wait_ms": 45000 } } },
      "why": "d••• hung for 2m 15s; the retry got no answer",
      "short": "d••• hung"
    },
    {
      "name": "a hang whose retry answered, then was cancelled",
      "switch": { "kind": "failed", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "hang", "wait_ms": 135000, "count": 1, "retries": 1, "last_retry": { "kind": "request", "status": 499, "wait_ms": 45000, "answered": true } } },
      "why": "d••• hung for 2m 15s; the retry was cancelled",
      "short": "d••• hung"
    },
    {
      "name": "a hang whose retry lost its connection",
      "switch": { "kind": "failed", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "hang", "wait_ms": 135000, "count": 1, "retries": 1, "last_retry": { "kind": "connection", "wait_ms": 300 } } },
      "why": "d••• hung for 2m 15s; the retry lost its connection",
      "short": "d••• hung"
    },
    {
      "name": "a 503 whose retry returned 529",
      "switch": { "kind": "failed", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "server", "status": 503, "wait_ms": 400, "count": 1, "retries": 1, "last_retry": { "kind": "overloaded", "status": 529, "wait_ms": 900 } } },
      "why": "d••• returned HTTP 503; the retry returned HTTP 529",
      "short": "d••• returned HTTP 503"
    },
    {
      "name": "two hangs",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "hang",
          "wait_ms": 135000,
          "count": 2
        }
      },
      "why": "d••• hung twice",
      "short": "d••• hung"
    },
    {
      "name": "a 529",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "overloaded",
          "status": 529,
          "wait_ms": 900,
          "count": 1
        }
      },
      "why": "d••• returned HTTP 529",
      "short": "d••• returned HTTP 529"
    },
    {
      "name": "two 529s",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "overloaded",
          "status": 529,
          "wait_ms": 900,
          "count": 2
        }
      },
      "why": "d••• returned HTTP 529 twice",
      "short": "d••• returned HTTP 529 twice"
    },
    {
      "name": "a lost connection",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "connection",
          "wait_ms": 300,
          "count": 1
        }
      },
      "why": "d••• lost its connection",
      "short": "d••• lost its connection"
    },
    {
      "name": "a timeout",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "timeout",
          "status": 504,
          "wait_ms": 20000,
          "count": 1
        }
      },
      "why": "d••• timed out",
      "short": "d••• timed out"
    },
    {
      "name": "a 502",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "server",
          "status": 502,
          "wait_ms": 400,
          "count": 1
        }
      },
      "why": "d••• returned HTTP 502",
      "short": "d••• returned HTTP 502"
    },
    {
      "name": "a rate limit",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "rate",
          "status": 429,
          "wait_ms": 200,
          "count": 1
        }
      },
      "why": "d••• was rate-limited",
      "short": "d••• was rate-limited"
    },
    {
      "name": "another status",
      "switch": {
        "kind": "failed",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "other",
          "status": 418,
          "wait_ms": 200,
          "count": 1
        }
      },
      "why": "d••• failed (HTTP 418)",
      "short": "d••• failed (HTTP 418)"
    },
    {
      "name": "a refused sign-in",
      "switch": {
        "kind": "sign-in",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "sign-in",
          "status": 401,
          "wait_ms": 300,
          "count": 1
        }
      },
      "why": "d••• refused sign-in (HTTP 401)",
      "short": "d••• refused sign-in (HTTP 401)"
    },
    {
      "name": "a model it does not serve",
      "switch": {
        "kind": "model",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "kind": "model",
          "status": 404,
          "wait_ms": 300,
          "count": 1,
          "model": "claude-opus-5-5"
        }
      },
      "why": "d••• cannot serve opus-5-5",
      "short": "d••• cannot serve opus-5-5"
    },
    {
      "name": "no failure seen",
      "switch": {
        "kind": "left-out",
        "reason": "previous account unavailable; weekly quota resets soonest"
      },
      "why": "the proxy left d••• out; no failure recorded",
      "short": "reason unknown"
    },
    {
      "name": "used up",
      "switch": {
        "kind": "quota",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "reason": "weekly quota used up"
        }
      },
      "why": "d••• weekly quota used up",
      "short": "d••• weekly quota used up"
    },
    {
      "name": "an idle move",
      "switch": {
        "kind": "idle",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "reason": "5-hour quota low"
        }
      },
      "why": "d••• 5-hour quota low; moved while idle",
      "short": "d••• 5-hour quota low"
    },
    {
      "name": "a removed account",
      "switch": {
        "kind": "gone",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "reason": "removed"
        }
      },
      "why": "d••• was removed",
      "short": "d••• was removed"
    },
    {
      "name": "a disabled account",
      "switch": {
        "kind": "gone",
        "reason": "previous account unavailable; weekly quota resets soonest",
        "cause": {
          "reason": "disabled"
        }
      },
      "why": "d••• is disabled",
      "short": "d••• is disabled"
    },
    {
      "name": "two 529s, and it rests",
      "switch": { "kind": "rest", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "overloaded", "status": 529, "wait_ms": 900, "count": 2 } },
      "until_in": 300000,
      "why": "d••• returned HTTP 529 twice; resting, back in 5m",
      "short": "d••• resting"
    },
    {
      "name": "two hangs, and it rests",
      "switch": { "kind": "rest", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "hang", "wait_ms": 135000, "count": 2 } },
      "until_in": 300000,
      "why": "d••• hung twice; resting, back in 5m",
      "short": "d••• resting"
    },
    {
      "name": "failures of several kinds, and it rests",
      "switch": { "kind": "rest", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "count": 2 } },
      "until_in": 240000,
      "why": "d••• resting after 2 failures",
      "short": "d••• resting"
    },
    {
      "name": "a rest that has ended",
      "switch": { "kind": "rest", "reason": "previous account unavailable; weekly quota resets soonest", "cause": { "kind": "overloaded", "status": 529, "count": 2 } },
      "until_in": -60000,
      "why": "d••• returned HTTP 529 twice",
      "short": "d••• returned HTTP 529 twice"
    },
    {
      "name": "the user's own switch",
      "switch": {
        "kind": "user",
        "reason": "switched by user"
      },
      "why": "switched by you",
      "short": "switched by you"
    },
    {
      "name": "the user's own switch from a waiting turn (Switch now)",
      "switch": {
        "kind": "user",
        "reason": "switched by user",
        "cause": { "kind": "hang", "wait_ms": 135000, "retries": 1, "waited_ms": 175000 }
      },
      "why": "by you after waiting 2m 55s",
      "short": "by you"
    },
    {
      "name": "an older plugin's user switch",
      "switch": {
        "reason": "switched by user"
      },
      "why": "switched by you",
      "short": "switched by you"
    },
    {
      "name": "an older plugin's idle move",
      "switch": {
        "reason": "moved while idle; weekly quota resets soonest"
      },
      "why": "moved while idle",
      "short": "moved while idle"
    },
    {
      "name": "an older plugin's quota move",
      "switch": {
        "reason": "previous account unavailable; weekly quota resets soonest"
      },
      "why": "reason not recorded",
      "short": "reason not recorded"
    },
    {
      "name": "an older plugin's failure move",
      "switch": {
        "reason": "previous account unavailable; 5-hour quota low"
      },
      "why": "reason not recorded",
      "short": "reason not recorded"
    }
  ]
}
