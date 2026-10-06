/**
 * A quota-pilot snapshot in the plugin's wire format (`plugin/core/snapshot.go`).
 * Identities are fictional.
 */

export const NOW_MS = Date.parse('2026-10-04T00:00:00Z');

export const rawSnapshot = {
  schema_version: 1,
  boot_id: 'boot-1',
  sequence: 37,
  generated_at: '2026-10-03T23:59:48Z',
  config: {
    cross_provider: 'off',
    fallback_map: { claude: 'codex:gpt-6-sol' },
    min_five_hour_left_percent: 10,
    idle_poll_minutes: 10,
  },
  providers: {
    // Go encodes maps with sorted keys; the ledger must still put Claude first.
    codex: {
      health: 'healthy',
      credentials: [
        {
          id: 'codex-carol@example.com-pro.json',
          auth_index: 'c1',
          label: 'c•••',
          email: 'carol@example.com',
          order: 1,
          tier: 1,
          reason: 'weekly quota resets soonest',
          sessions: 0,
          windows: [
            {
              kind: '7d',
              label: 'Weekly',
              remaining: 0.9299999999999999,
              reset_at: '2026-10-10T00:02:34Z',
              observed_at: '2026-10-03T23:59:00Z',
              stale: false,
            },
          ],
        },
      ],
    },
    claude: {
      health: 'healthy',
      credentials: [
        {
          id: 'claude-alice@example.com.json',
          auth_index: 'a1',
          label: 'a•••',
          email: 'alice@example.com',
          plan: 'Max 20x',
          order: 1,
          tier: 3,
          reason: 'weekly quota used up',
          unavailable: true,
          sessions: 2,
          windows: [
            {
              kind: '7d_fable',
              label: 'Weekly Fable',
              remaining: 1,
              reset_at: '2026-11-05T07:59:00Z',
              observed_at: '2026-10-03T20:00:00Z',
              stale: true,
            },
            {
              kind: '5h',
              label: '5-hour',
              remaining: 0.98,
              // Unset Go time.Time: no reset known.
              reset_at: '0001-01-01T00:00:00Z',
              observed_at: '2026-10-03T23:59:00Z',
              stale: false,
            },
            {
              kind: '7d',
              label: 'Weekly',
              remaining: 0,
              reset_at: '2026-10-04T11:59:59Z',
              observed_at: '2026-10-03T23:59:00Z',
              stale: false,
            },
          ],
        },
        {
          id: 'claude-bob@example.com.json',
          auth_index: 'b1',
          label: 'b•••',
          email: 'bob@example.com',
          order: 2,
          tier: 1,
          reason: 'weekly quota resets soonest',
          sessions: 0,
          windows: [
            {
              kind: '5h',
              label: '5-hour',
              remaining: 0.7,
              reset_at: '2026-10-04T01:10:00Z',
              observed_at: '2026-10-03T23:59:00Z',
              stale: false,
            },
            {
              kind: '7d',
              label: 'Weekly',
              remaining: 0.63,
              reset_at: '2026-10-10T00:00:00Z',
              observed_at: '2026-10-03T23:59:00Z',
              stale: false,
            },
          ],
        },
      ],
    },
  },
  sessions: {},
  acks: [],
  context_lengths: {},
};
