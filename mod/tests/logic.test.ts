import { describe, expect, test } from 'claude-code/testing'

import {
  bandErrorText,
  barFill,
  cacheState,
  fmtDuration,
  fmtTokens,
  latestModels,
  layout,
  parseModels,
  tileWidths,
  tilesSpan,
  kindLabel,
  likelyAccount,
  nextUp,
  otherAccounts,
  offerCacheActions,
  parseSnap,
  pickAlert,
  pooled,
  blockedOthers,
  cannotTake,
  missingText,
  providerOfModel,
  switchTargets,
  readBand,
  resetText,
  sessionAccount,
  settlePending,
  repoOf,
  nextTurnMoves,
  weeklyFor,
  currentModel,
} from '../hooks/logic'
import type { CacheInfo, Pending, SessionInfo, Snap } from '../types'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const iso = (ms: number) => new Date(NOW + ms).toISOString()
const H = 3_600_000

const SNAP: Snap = {
  schema_version: 1,
  boot_id: 'b1',
  sequence: 7,
  generated_at: iso(-5_000),
  config: { cross_provider: 'off', fallback_map: { claude: 'codex:gpt-6-sol' }, min_five_hour_left_percent: 10, idle_poll_minutes: 10 },
  providers: {
    claude: {
      health: 'healthy',
      credentials: [
        {
          id: 'claude-d', auth_index: '1', label: 'd•••', order: 1, tier: 1, reason: 'weekly quota resets soonest', sessions: 2,
          windows: [
            { kind: '5h', label: '5-hour', remaining: 0.12, reset_at: iso(3 * H + 20 * 60_000), observed_at: iso(-60_000), stale: false },
            { kind: '7d', label: 'Weekly', remaining: 0.58, reset_at: iso(27 * H), observed_at: iso(-60_000), stale: false },
          ],
        },
        {
          id: 'claude-k', auth_index: '2', label: 'k•••', order: 2, tier: 1, reason: 'weekly quota resets soonest', sessions: 0,
          windows: [
            { kind: '5h', label: '5-hour', remaining: 0.97, reset_at: iso(H), observed_at: iso(-60_000), stale: false },
            { kind: '7d', label: 'Weekly', remaining: 0.93, reset_at: iso(98 * H), observed_at: iso(-60_000), stale: false },
          ],
        },
      ],
    },
  },
  sessions: {
    s1: {
      provider: 'claude', model: 'claude-opus-5-5', auth_id: 'claude-d', auth_label: 'd•••', binding_reason: 'weekly quota resets soonest',
      switch_imminent: false, totals: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      last: { input: 10, output: 5, cache_read: 400_000, cache_creation: 12_000 }, last_seen: iso(-10_000),
    },
  },
  acks: [],
  context_lengths: { 'claude-opus-5-5': 1_000_000, 'gpt-6-sol': 272_000 },
}

const SESSION: SessionInfo = {
  id: 's1', model: 'opus[1m]', effort: 'high', cwd: '/Users/me/Documents/developer/jesse',
  contextTokens: 420_000, contextWindow: 1_000_000, rateLimits: [],
  proxied: true, home: '/Users/me',
}

const WARM: CacheInfo = { lastAt: NOW - 8 * 60_000, prompt: 412_000, read: 400_000, creation: 12_000, input: 10, ttlMs: H, lastAnswer: '' }

const MODELS = [
  'claude-opus-5-5:anthropic', 'claude-opus-5:anthropic', 'claude-sonnet-5-5:anthropic', 'claude-fable-5-1:anthropic',
  'claude-haiku-4-5-20251001:anthropic', 'gpt-6.1-sol:openai', 'gpt-6-sol:openai', 'gpt-6-astra:openai', 'gpt-6-luna:openai',
  'gpt-5.6-terra:openai', 'gpt-5.5:openai', 'gpt-image-2.5:openai', 'codex-auto-review:openai',
].map(s => ({ id: s.split(':')[0]!, owned_by: s.split(':')[1]!, created: 0 }))

describe('formatting', () => {
  test('durations, tokens and bars', async () => {
    expect(fmtDuration(3 * H + 20 * 60_000)).toBe('3h 20m')
    expect(fmtDuration(27 * H)).toBe('1d 3h')
    expect(fmtDuration(52 * 60_000)).toBe('52m')
    expect(fmtDuration(59 * 60_000 + 58_000)).toBe('1h')
    expect(fmtDuration(2 * H - 10_000)).toBe('2h')
    expect(fmtTokens(412_345)).toBe('412k')
    expect(fmtTokens(1_234_567)).toBe('1.2M')
    expect(barFill(0.001, 20)).toBe(1)
    expect(barFill(0, 20)).toBe(0)
    expect(barFill(1.4, 20)).toBe(20)
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtDuration(13 * H + 5 * 60_000)).toBe('13h')
  })
})

describe('cache', () => {
  test('warm, expiring, cold and unknown', async () => {
    expect(cacheState(WARM, NOW).state).toBe('warm')
    expect(cacheState({ ...WARM, lastAt: NOW - 57 * 60_000 }, NOW).state).toBe('expiring')
    // A 5-minute TTL is not 'expiring' the moment a reply lands.
    expect(cacheState({ ...WARM, ttlMs: 5 * 60_000, lastAt: NOW - 10_000 }, NOW).state).toBe('warm')
    expect(cacheState({ ...WARM, ttlMs: 5 * 60_000, lastAt: NOW - 4 * 60_000 }, NOW).state).toBe('expiring')
    expect(cacheState({ ...WARM, lastAt: NOW - 2 * H }, NOW).state).toBe('cold')
    expect(cacheState({ ...WARM, lastAt: 0 }, NOW).state).toBe('unknown')
  })

  test('compact and handoff are offered only when a rewrite is coming', async () => {
    const acct = sessionAccount(SNAP, 's1')
    expect(offerCacheActions('warm', acct)).toBe(false)
    expect(offerCacheActions('expiring', acct)).toBe(true)
    const imminent = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, switch_imminent: true } } }
    expect(offerCacheActions('warm', sessionAccount(imminent, 's1'))).toBe(true)
  })
})

describe('accounts', () => {
  test('pooled quota and next account', async () => {
    const view = SNAP.providers.claude!
    expect(pooled(view)).toEqual({ left: 76, parts: [58, 93], stale: false })
    expect(nextUp(view, 'claude-d', NOW)).toBe('next up: k••• 7% used')
    const used = { ...view, credentials: view.credentials.map(c => c.id === 'claude-k' ? { ...c, tier: 3, reason: 'weekly quota used up', back_at: iso(98 * H), windows: c.windows.map(w => w.kind === '7d' ? { ...w, remaining: 0 } : w) } : c) }
    expect(blockedOthers(used, 'claude-d', NOW)).toBe('k••• weekly quota used up, back in 4d 2h')
    expect(nextUp(used, 'claude-d', NOW)).toBe('k••• back in 4d 2h')
    // Only its 5-hour window stops it: back when that one resets, not at the weekly reset.
    const fiveOnly = { ...view, credentials: view.credentials.map(c => c.id === 'claude-k' ? { ...c, tier: 3, reason: '5-hour quota used up', back_at: iso(2 * H) } : c) }
    expect(nextUp(fiveOnly, 'claude-d', NOW)).toBe('k••• back in 2h')
    const disabled = { ...view, credentials: view.credentials.map(c => c.id === 'claude-k' ? { ...c, disabled: true, tier: 3, reason: 'disabled', back_at: iso(2 * H) } : c) }
    expect(blockedOthers(disabled, 'claude-d', NOW)).toBe('k••• disabled')
    expect(nextUp(disabled, 'claude-d', NOW)).toBe('single account')
    expect(resetText('now')).toBe('resetting now')
    expect(resetText('')).toBe('no reset pending')
  })

  test('a second credential of one account adds no quota to the pool, and is not another account', async () => {
    const [d] = SNAP.providers.claude!.credentials
    const view = { health: 'healthy', credentials: [d!, { ...d!, id: 'claude-d2', same_as: 'claude-d' }] }
    expect(pooled(view)).toMatchObject({ parts: [Math.round(d!.windows[1]!.remaining * 100)] })
    // Neither from the account nor from its second credential is the other one offered.
    expect(nextUp(view, 'claude-d', NOW)).toBe('single account')
    expect(nextUp(view, 'claude-d2', NOW)).toBe('single account')
    expect(switchTargets(view, 'claude-d')).toEqual([])
    const both = { ...SNAP.providers.claude!, credentials: [...SNAP.providers.claude!.credentials, { ...d!, id: 'claude-d2', same_as: 'claude-d' }] }
    expect(otherAccounts(both, 'claude-d2').map(c => c.id)).toEqual(['claude-k'])
  })

  test('the account a new session gets is the one the plugin ranks first for its model', async () => {
    expect(likelyAccount({ ...SNAP, expected: { claude: 'claude-k' } }, 'claude')?.cred.id).toBe('claude-k')
    // From a plugin that says none: the first in its routing order.
    expect(likelyAccount(SNAP, 'claude')?.cred.id).toBe('claude-d')
    expect(likelyAccount(SNAP, 'codex')).toBe(null)
    expect([kindLabel('5h'), kindLabel('7d'), kindLabel('7d_fable')]).toEqual(['5-hour', 'Weekly', 'Weekly Fable'])
  })

  test('missing readings are unknown, not empty', async () => {
    const view = SNAP.providers.claude!
    const fresh = { ...view, credentials: view.credentials.map(c => c.id === 'claude-k' ? { ...c, windows: [] } : c) }
    // An account not read yet leaves the whole unknown: its quota could be anything.
    expect(pooled(fresh)).toEqual({ left: null, parts: [58, null], stale: false })
    expect(nextUp(fresh, 'claude-d', NOW)).toBe('next up: k••• —')
    const off = { ...view, credentials: view.credentials.map(c => c.id === 'claude-k' ? { ...c, disabled: true } : c) }
    expect(pooled(off)).toEqual({ left: 58, parts: [58], stale: false })
    const stale = { ...view, credentials: view.credentials.map(c => ({ ...c, windows: c.windows.map(w => ({ ...w, stale: true })) })) }
    expect(pooled(stale).stale).toBe(true)
  })

  test('the weekly window that limits the model', async () => {
    const cred = SNAP.providers.claude!.credentials[1]!
    const withFable = { ...cred, windows: [...cred.windows, { kind: '7d_fable', label: 'Weekly Fable', remaining: 0.2, observed_at: iso(0), stale: false }] }
    expect(weeklyFor(withFable, 'claude-fable-5-1')?.label).toBe('Weekly Fable')
    expect(weeklyFor(withFable, 'claude-opus-5-5[1m]')?.label).toBe('Weekly')
    expect(weeklyFor(cred, 'claude-fable-5-1')?.kind).toBe('7d')
  })

  test('the model the next turn runs', async () => {
    expect(currentModel('opus[1m]', 'claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(currentModel('sonnet', 'claude-opus-5-5')).toBe('sonnet') // right after /model, before a reply
    expect(currentModel('claude-sonnet-5-5', 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
    expect(currentModel('opus', '')).toBe('opus')
  })

  test('the next turn moving after a switch', async () => {
    const moved = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, auth_id: 'claude-k', served_auth_id: 'claude-d' } } }
    expect(nextTurnMoves(sessionAccount(moved, 's1'))).toBe(true)
    const settled = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, served_auth_id: 'claude-d' } } }
    expect(nextTurnMoves(sessionAccount(settled, 's1'))).toBe(false)
    expect(nextTurnMoves(sessionAccount(SNAP, 's1'))).toBe(false)
  })

  test('layout follows width and height', async () => {
    expect(layout(141, 20, false)).toBe('tiles6')
    expect(layout(140, 20, false)).toBe('tiles5')
    expect(layout(118, 20, false)).toBe('tiles5')
    expect(layout(117, 20, false)).toBe('grid')
    expect(layout(70, 20, false)).toBe('grid')
    expect(layout(69, 20, false)).toBe('compact')
    expect(layout(100, 6, false)).toBe('compact') // two rows of tiles need the height
    expect(layout(200, 2, false)).toBe('compact')
    expect(layout(200, 20, true)).toBe('compact')
  })

  test('tiles fill the band up to their widest and never overflow it', async () => {
    for (const width of [118, 141, 153, 160, 213, 400]) {
      const mode = layout(width, 20, false) as 'tiles6' | 'tiles5'
      const ws = tileWidths(mode, width)
      expect(ws[0]! >= 24).toBe(true)
      expect(Math.max(...ws) - Math.min(...ws) <= 2).toBe(true)
      expect(tilesSpan(mode, width)).toBe(Math.min(width, ws.length * 49 - 1))
    }
    expect(tileWidths('tiles6', 153)).toEqual([25, 25, 25, 25, 24, 24])
    expect(tileWidths('tiles6', 160)).toEqual([26, 26, 26, 26, 26, 25])
    expect(tileWidths('tiles6', 141)).toEqual([24, 22, 22, 24, 22, 22])
  })

  test('alerts: stale data, imminent switch, exhausted provider', async () => {
    expect(pickAlert(SNAP, sessionAccount(SNAP, 's1'), true, NOW)).toBe(null)
    expect(pickAlert({ ...SNAP, generated_at: iso(-10 * 60_000) }, null, true, NOW)?.text).toMatch(/old/)
    // A used-up account often answers a while longer; a disabled one is not offered at all.
    const imminent = (switch_reason: string) => ({ ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, switch_imminent: true, switch_reason, next_auth_id: 'claude-k' } } })
    const usedUp = imminent('weekly quota used up')
    expect(pickAlert(usedUp, sessionAccount(usedUp, 's1'), true, NOW)?.text).toBe('weekly quota used up on d••• · moves to k••• (7% used) once d••• stops answering')
    const disabled = imminent('disabled')
    expect(pickAlert(disabled, sessionAccount(disabled, 's1'), true, NOW)?.text).toBe('disabled on d••• · moves to k••• (7% used) on the next turn')
    const exhausted = { ...SNAP, providers: { claude: { ...SNAP.providers.claude!, health: 'exhausted' } } }
    expect(pickAlert(exhausted, sessionAccount(exhausted, 's1'), true, NOW)?.action).toBe('route')
    const at = iso(-5 * 60_000)
    const used = { ...SNAP.providers.claude!, credentials: SNAP.providers.claude!.credentials.map(c => c.id === 'claude-d' ? { ...c, tier: 3, reason: 'weekly quota used up' } : c) }
    const switched = {
      ...SNAP,
      providers: { claude: used },
      sessions: { s1: { ...SNAP.sessions.s1!, auth_id: 'claude-k', last_switch: { from: 'claude-d', to: 'claude-k', at, reason: 'previous account unavailable; weekly quota resets soonest' } } },
    }
    const alert = pickAlert(switched, sessionAccount(switched, 's1'), true, NOW)
    expect(alert).toEqual({ level: 'info', text: 'Switched d••• → k••• · d••• weekly quota used up', action: 'dismiss', key: at })
    expect(pickAlert(switched, sessionAccount(switched, 's1'), true, NOW, at)).toBe(null)
    const later = { ...switched, generated_at: iso(20 * 60_000) }
    expect(pickAlert(later, sessionAccount(later, 's1'), true, NOW + 20 * 60_000)).toBe(null)
  })

  test("the switch list leaves out accounts that cannot serve the session's model, and says why", async () => {
    const view = SNAP.providers.claude!
    expect(switchTargets(view, 'claude-d').map(c => c.id)).toEqual(['claude-k'])
    // k's own Opus quota is used up: it cannot take an Opus session, whatever its weekly reading.
    expect(switchTargets(view, 'claude-d', ['claude-k'])).toEqual([])
    const k = {
      ...view.credentials[1]!,
      windows: [...view.credentials[1]!.windows, { kind: '7d_opus', label: 'Weekly Opus', remaining: 0, reset_at: iso(30 * H), observed_at: iso(-60_000), stale: false }],
    }
    expect(cannotTake(k, 'claude-opus-5-5', NOW)).toBe('k••• Weekly Opus used up, back in 1d 6h')
    expect(cannotTake(view.credentials[1]!, 'claude-opus-5-5', NOW)).toBe('k••• cannot serve claude-opus-5-5 now')
    expect(cannotTake({ ...k, disabled: true }, 'claude-opus-5-5', NOW)).toBe('k••• disabled')
  })

  test('a meter without a reading says whether the account has no such window', async () => {
    const d = SNAP.providers.claude!.credentials[0]!
    expect(missingText({ ...d, windows: [d.windows[1]!], absent: ['5h'] }, '5h')).toBe('no such limit')
    expect(missingText({ ...d, windows: [d.windows[1]!] }, '5h')).toBe('not reported yet')
    expect(missingText({ ...d, windows: [] }, '5h')).toBe('after the first reply')
    expect(missingText(undefined, '7d')).toBe('after the first reply')
  })

  test('snapshot parsing rejects other schemas and junk', async () => {
    expect(parseSnap(JSON.stringify(SNAP))?.sequence).toBe(7)
    expect(parseSnap('{"schema_version":2,"sequence":1}')).toBe(null)
    expect(parseSnap('{"schema_version":1,"sequence":1}')).toBe(null)
    expect(parseSnap(JSON.stringify({ ...SNAP, providers: { claude: { health: 'healthy' } } }))).toBe(null)
    expect(parseSnap('{not json')).toBe(null)
  })

  test('a repository is named by its git remote, the same on every device', async () => {
    expect(repoOf('git@github.com:kuan0808/cliproxy-kit.git')).toBe('github.com/kuan0808/cliproxy-kit')
    expect(repoOf('https://x-access-token:secret@GitHub.com/kuan0808/cliproxy-kit')).toBe('github.com/kuan0808/cliproxy-kit')
    expect(repoOf('ssh://git@git.example.com:2222/team/app.git')).toBe('git.example.com/team/app')
    expect(repoOf('/srv/git/app.git')).toBe('')
    // A path of this machine names no repository the same everywhere.
    for (const local of ['../origin.git', 'file:///srv/git/app.git', 'C:\\repos\\app.git', 'C:/repos/app.git']) expect(repoOf(local)).toBe('')
    expect(repoOf('work:team/app.git')).toBe('work/team/app') // an ssh alias
    expect(repoOf('git@x:team/app.git')).toBe('x/team/app')
    expect(repoOf('git@host:./team/app.git')).toBe('host/team/app')
    expect(repoOf(null)).toBe('')
  })

  test("the proxy's /band answer, or why there is none", async () => {
    expect(readBand(200, JSON.stringify(SNAP)).snap?.sequence).toBe(7)
    expect(readBand(401, '{"error":"a client key the proxy accepted in the last week is required"}').error).toEqual({ kind: 'status', status: 401 })
    expect(readBand(200, '<html>').error).toEqual({ kind: 'body' })
    expect(bandErrorText({ kind: 'status', status: 401 })).toBe('quota data comes once this key has sent a request through the proxy')
    expect(bandErrorText({ kind: 'status', status: 404 })).toMatch(/no quota-pilot band route \(404\)/)
    expect(bandErrorText({ kind: 'status', status: 502 })).toBe('the proxy answered HTTP 502 for quota data')
    expect(bandErrorText({ kind: 'body' })).toMatch(/not in a form this band reads/)
    expect(bandErrorText({ kind: 'network', message: 'connect ECONNREFUSED' })).toBe('cannot reach the proxy for quota data: connect ECONNREFUSED')
  })

  test('pending commands settle by acknowledgement, restart or time', async () => {
    const sent = (id: string, at = NOW): Pending => ({ id, text: `Switch to ${id}`, boot: 'b1', at })
    const ack = (command_id: string, status: string, reason?: string) => ({ command_id, status, reason, at: iso(0) })
    // Waiting, and nothing has answered yet.
    expect(settlePending([sent('a')], SNAP, NOW + 30_000)).toEqual({ left: [sent('a')], notice: null })
    expect(settlePending([sent('a')], { ...SNAP, acks: [ack('a', 'applied')] }, NOW)).toEqual({ left: [], notice: { text: 'Switch to a: done', isError: false } })
    expect(settlePending([sent('a'), sent('b')], { ...SNAP, acks: [ack('a', 'rejected', 'unknown account')] }, NOW))
      .toEqual({ left: [sent('b')], notice: { text: 'Switch to a: unknown account', isError: true } })
    // A new run of the proxy cannot acknowledge what the last one was sent; its own rejection still wins.
    const restarted = { ...SNAP, boot_id: 'b2' }
    expect(settlePending([sent('a')], restarted, NOW)).toEqual({ left: [], notice: { text: 'Switch to a: the proxy restarted before confirming it', isError: true } })
    expect(settlePending([sent('a')], { ...restarted, acks: [ack('a', 'rejected', 'proxy restarted since the command was written')] }, NOW).notice?.text)
      .toBe('Switch to a: proxy restarted since the command was written')
    // Unanswered for a minute, with or without a snapshot.
    for (const snap of [SNAP, null]) {
      expect(settlePending([sent('a')], snap, NOW + 61_000)).toEqual({ left: [], notice: { text: 'Switch to a: no answer from the proxy; is it running?', isError: true } })
    }
  })
})

describe('models', () => {
  test('the newest model of each line, newest first', async () => {
    expect(latestModels(MODELS, 'codex')).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
    expect(latestModels(MODELS, 'claude')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])
    expect(latestModels(MODELS, 'kimi')).toEqual([])
    expect(parseModels(JSON.stringify({ data: [{ id: 'gpt-6-sol', owned_by: 'openai', created: 1 }, { nope: 1 }] }))).toEqual([{ id: 'gpt-6-sol', owned_by: 'openai', created: 1 }])
    expect(parseModels('not json')).toBe(null)
  })

  test("the provider of a model, Claude Code's aliases included", async () => {
    for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'opusplan', 'default', 'best']) {
      expect(providerOfModel(model)).toBe('claude')
    }
    expect(providerOfModel('gpt-6.1-sol')).toBe('codex')
    expect(providerOfModel('codex-auto-review')).toBe('codex')
    expect(providerOfModel('kimi-k2')).toBe('')
    expect(providerOfModel('defaults')).toBe('')
  })
})

