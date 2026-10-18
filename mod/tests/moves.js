// The expected wording of every move, read by tests/band.test.ts and by plugin/codex_test.go, which
// reads what follows `export default` as JSON: keep it JSON (double quotes, no trailing commas).
export default {
  "about": "Why a session moved off d••• to k•••, worded from its switch record: the band's move row reads 'Switched d••• → k••• · ' and `why` (its short form ends in `short` instead), and the Codex notice says the same `why`.",
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
      "name": "the user's own switch",
      "switch": {
        "kind": "user",
        "reason": "switched by user"
      },
      "why": "switched by you",
      "short": "switched by you"
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
