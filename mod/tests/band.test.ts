import { describe, expect, mock, test as kitTest } from 'claude-code/testing'
import type { EngineInterface, On, OpEventResult, RenderElement, RenderInput } from 'claude-code'
import type { Engine, FoundElement, MockClock, TestBody, TestOptions } from 'claude-code/testing'

/**
 * Every test may take a while on a loaded machine: the band refreshes on a 10-second clock, which
 * some tests run for hours. One that runs 6 seconds idle took 25 under a load average near 600.
 */
const test = (name: string, a: TestOptions | TestBody, b?: TestBody) =>
  typeof a === 'function' ? kitTest(name, { timeoutMs: 120_000 }, a) : kitTest(name, { timeoutMs: 120_000, ...a }, b!)

import type { BandError, Move, SessionInfo, Snap, SnapCred, SnapSwitch, SnapWindow, UiState } from '../types'
import { parseSnap, settingsOf, stepAfter, stepClock } from '../hooks/logic'
import { bandFacts, nextTurn } from '../hooks/view'
import { W } from '../hooks/wording'
import MOVES from './moves.js'

/** The expected wording of every move, which the plugin's Codex notice tests read too. */
const moves = (MOVES as { moves: { name: string; switch: Omit<SnapSwitch, 'from' | 'to' | 'at'>; until_in?: number; why: string; short: string }[] }).moves
/** The expected wording of the band's live rows and notes, by the wording table's row name. */
const rows = (MOVES as unknown as { rows: { name: string; row: keyof typeof W; args: unknown[]; text: string; short?: string }[] }).rows

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
          id: 'claude-d', auth_index: '1', label: 'd•••', plan: 'Max 20x', order: 1, tier: 1, reason: 'weekly quota resets soonest', sessions: 2,
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
      switch_imminent: false, totals: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, generation: 3,
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

const BAND = (bodyColumns: number, isWorking: boolean, maxRows = 20) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isCollapsed: false, isWorking, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows }, view: {} },
})

/** Answer every call the band makes at session start, as Claude Code and the proxy would. */
const LOCAL_ENV = { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'sk-local', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }

/** The transcript's titles, as grep finds them: a rename wins over Claude Code's title. */
const TITLED = '"aiTitle":"Login page"\n"customTitle":"Fix the \\"login\\" page"\n"aiTitle":"Later title"\n'
/** What the band's read of its transcript finds; a test sets it after `stubSession`. */
let transcript = TITLED
/** What the proxy's /band answers; a test sets it after `stubSession`. */
let snapshot: Snap
/** Whether each read of /band stamps the snapshot with the test clock's time, as a live proxy does. */
let stampReads = false
/** When set, how /band fails instead: refused, or not reached. */
let failure: OpEventResult<'http.fetch'> | Promise<OpEventResult<'http.fetch'>> | undefined
/** The reads the proxy takes and never answers, by URL: a connection accepted and then silent. */
let hang: RegExp | undefined
/** How many times the band read /band. */
let bandReads = 0
/** The proxy's model list. */
let models: { id: string; owned_by: string; created: number }[]
/** The URL and headers of the band's last read of /band, and every command its reads carried. */
let sentTo = ''
let sent: Record<string, string> = {}
/** The headers of every read of /band, in order, and the commands the band ran on this device. */
let reads: Record<string, string>[] = []
let runs: string[][] = []
let commands: Record<string, string>[] = []
/** The session's root and repository, as Claude Code reports them. */
let root: string
let repo: unknown
/** The session's id, which a `/clear` changes, and the rate limits Claude Code reports for a direct login. */
let currentId = SESSION.id
let selectedModel = SESSION.model
let limits: { kind: string; percentUsed: number; resetsAt?: string }[] = []
/** What the band's own model calls answer, and what it asked them. */
const FORK_OK = { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as OpEventResult<'model.fork'>
let forkReply = FORK_OK
let forks: string[] = []
/** What else happens while the band's model call runs, or while a reply streams: the reader acting meanwhile. */
let duringFork: (() => unknown) | undefined
let duringStep: (() => unknown) | undefined
/** What else happens while the band asks the session's id or the surfaces it draws on, at the test clock's time. */
let duringId: ((now: number) => unknown) | undefined
let duringSurfaces: (() => unknown) | undefined
let duringFetch: ((url: string) => Promise<void>) | undefined
/** The files the band wrote, the prompts it sent or put in the box. */
let files: Record<string, string> = {}
let submitted: string[] = []
let filled: string[] = []

/** How many of a one-line meter's cells are filled: the first run of its bar. */
const filledCells = (meter: FoundElement | undefined): number => {
  const bar = meter?.children[1] as { children: { children: string[] }[] } | undefined
  return bar?.children[0]?.children[0]?.length ?? -1
}

/** A user record of a transcript, as the band's read of it lists one. */
const userRecord = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } })

/** What the hooks beneath the band draw. Without a survey the engine draws nothing of its own. */
type Beneath = ($: EngineInterface, e: RenderInput<'AbovePrompt'>) => RenderElement
const ENGINE_ONLY: Beneath = () => ({ type: 'engine', ref: 0 })

function stubSession(
  on: On,
  snap: Snap,
  env: Record<string, string> = LOCAL_ENV,
  contextTokens = 420_000,
  beneath: Beneath = ENGINE_ONLY,
): MockClock {
  // Read as each call comes, so a test can point Claude Code elsewhere mid-session.
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  const clock = mock.clock(on, { now: NOW })
  transcript = TITLED
  snapshot = snap
  failure = undefined
  hang = undefined
  stampReads = false
  models = []
  sentTo = ''
  sent = {}
  reads = []
  runs = []
  commands = []
  root = SESSION.cwd
  repo = null
  currentId = SESSION.id
  selectedModel = SESSION.model
  limits = []
  forkReply = FORK_OK
  forks = []
  duringFork = undefined
  duringStep = undefined
  duringId = undefined
  duringSurfaces = undefined
  duringFetch = undefined
  files = {}
  submitted = []
  filled = []
  on('session.id', async () => {
    await duringId?.(clock.now())
    return { value: currentId }
  })
  on('session.surfaces', async () => {
    await duringSurfaces?.()
    return { value: ['desktop'] }
  })
  on('session.model', () => ({ value: selectedModel }))
  on('session.cwd', () => ({ value: SESSION.cwd }))
  on('session.usage', () => ({
    value: { startedAt: NOW - H, context: { tokens: contextTokens, window: 1_000_000, percent: contextTokens / 10_000 }, rateLimits: limits, cost: { usd: 4.2 } },
  }) as never)
  on('model.fork', async (_$, e) => {
    forks.push(e.prompt)
    await duringFork?.()
    return forkReply
  })
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('command.run', (_$, e) => {
    if (e.command === 'clear') currentId = 's2'
    return {} as never
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('prompt.read', () => ({ value: { text: filled[filled.length - 1] ?? '', cursor: 0 } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('process.run', (_$, e) => (runs.push([...e.argv]), {
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'date' ? '+0800\n'
        : e.argv[0] === 'sh' ? transcript
          : e.argv.includes('branch') ? 'main\n' : ' M a\n M b\n M c\n',
      stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  const ok = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', async (_$, e) => {
    const silent = hang?.test(e.url) ? new Promise<never>(() => undefined) : undefined
    if (!e.url.endsWith('/band')) {
      await duringFetch?.(e.url)
      return silent ?? ok({ data: models })
    }
    bandReads++
    sentTo = e.url
    sent = { ...(e.init?.headers as Record<string, string> | undefined) }
    reads.push(sent)
    if (sent['X-Band-Command']) commands.push(JSON.parse(decodeURIComponent(sent['X-Band-Command'])))
    await duringFetch?.(e.url)
    return silent ?? failure ?? ok(stampReads ? { ...snapshot, generated_at: new Date(clock.now()).toISOString() } : snapshot)
  })
  on('session.root', () => ({ value: root }))
  on('session.repo', () => ({ value: repo as never }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.start', () => ({ cwd: SESSION.cwd }))
  // Nothing sits beneath a test's hooks: this one stands for the engine, or for another mod.
  on('ui.render', { component: 'AbovePrompt' }, beneath)
  return clock
}

test('band draws its cards from the snapshot, in cells or as cards in the desktop app, and opens the switch menu', async ($, on) => {
  stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    expect(await ui.find({ text: /d•••/ })).toBeDefined()
    expect(await ui.find({ text: /Accounts/ })).toBeDefined()
    expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ text: /^Max 20x$/ })).toBeDefined() // the plan, not the routing reason
      expect(await ui.find({ text: /^opus-5-5 1M$/ })).toBeDefined()
    } else {
      // The account card says the plan and the model under the account; meters are rings.
      expect(await ui.find({ text: /^Max 20x$/ })).toBeDefined()
      expect(await ui.find({ text: /^opus-5-5 1M$/ })).toBeDefined()
      expect(await ui.find({ text: /^420k of 1M$/ })).toBeDefined()
      expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(6)
      expect(await ui.find({ text: /━/ })).toBeUndefined() // no meter drawn in characters
    }
    expect(await ui.find({ key: 'quota' })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeUndefined() // a handoff replaced compacting
    await ui.press({ key: 'switch' })
    expect(await ui.find({ text: /Switch this session to:/ })).toBeDefined()
    expect(await ui.find({ key: 'to-claude-k' })).toBeDefined()
    await ui.press({ key: 'no' })
    expect(await ui.find({ text: /Switch this session to:/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('band is one row while Claude works, or when narrow or short, and tiles again when idle', async ($, on) => {
  stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const [cols, working, rows] of [[160, true, 20], [60, false, 20], [160, false, 2]] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(cols, working, rows) })
    expect(await ui.find({ text: /Accounts/ })).toBeUndefined()
    expect(await ui.find({ text: /d•••/ })).toBeDefined()
    await ui.unmount()
  }
  const row = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  expect(await row.find({ text: /^3h 20m$/ })).toBeDefined() // the 5-hour reset next to its percentage
  expect(await row.find({ text: /^1d 3h$/ })).toBeDefined()
  expect(await row.find({ text: /^—$/ })).toBeDefined() // no cache countdown before a reply
  expect(await row.find({ text: /^opus-5-5 1M$/ })).toBeDefined()
  await row.unmount()
  // A middling terminal keeps every tile, in two rows.
  const grid = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(100, false) })
  expect(await grid.find({ text: /^Accounts$/ })).toBeDefined()
  expect(await grid.find({ text: /^Cache$/ })).toBeDefined()
  await grid.unmount()
  // Narrow with room for two rows: who and what on one, the meters on the other.
  const two = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(60, true) })
  expect(await two.find({ text: /^opus-5-5 1M$/ })).toBeDefined()
  expect(await two.find({ text: /^5h$/ })).toBeDefined()
  expect(await two.find({ key: 'line-1' })).toBeDefined()
  await two.unmount()
  // Narrow with a single row: quota and context stay, the model name goes first.
  const one = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(44, true, 1) })
  expect(await one.find({ text: /^5h$/ })).toBeDefined()
  expect(await one.find({ text: /^opus-5-5 1M$/ })).toBeUndefined()
  await one.unmount()
  const idle = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await idle.find({ text: /Accounts/ })).toBeDefined()
  await idle.unmount()
})

test('a fresh session reads its context as used, empty and filling, in both views', async ($, on) => {
  // A new session's own prompt, tools and instructions: 62k of a 1M window.
  stubSession(on, SNAP, LOCAL_ENV, 62_400)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const cards = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await cards.find({ text: /^6%$/ })).toBeDefined()
  expect(await cards.find({ text: /left/ })).toBeUndefined()
  await cards.unmount()
  const line = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  expect(await line.find({ text: /^ctx$/ })).toBeDefined()
  expect(await line.find({ text: /^6%$/ })).toBeDefined()
  // The 5-hour meter reads 88% used where 12% is left.
  expect(await line.find({ text: /^88%$/ })).toBeDefined()
  await line.unmount()
})

test('band keeps what hooks beneath it draw, under it, and folds to one line to leave them room', async ($, on) => {
  // Another mod's band beneath this one, such as pasted image thumbnails.
  stubSession(on, SNAP, LOCAL_ENV, undefined, ($, e) => $.ui.resolve(e).Text({ children: '[Image #1]' }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const working of [false, true]) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, working) })
    expect(await ui.find({ text: /d•••/ })).toBeDefined()
    expect(await ui.find({ text: /^\[Image #1\]$/ })).toBeDefined()
    expect(await ui.find({ text: /^Accounts$/ })).toBeUndefined()
    await ui.unmount()
  }
  // Narrow, the band keeps to one row and leaves the rest to what lies beneath.
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(60, true) })
  expect(await narrow.find({ key: 'line-0' })).toBeDefined()
  expect(await narrow.find({ key: 'line-1' })).toBeUndefined()
  await narrow.unmount()
  // The cards stay one press away, with what lies beneath still under them.
  const idle = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  await idle.press({ key: 'view-cards' })
  expect(await idle.find({ text: /^Accounts$/ })).toBeDefined()
  expect(await idle.find({ text: /^\[Image #1\]$/ })).toBeDefined()
  await idle.unmount()
})

test('band whose proxy stopped shows its last snapshot, and why nothing newer came', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  failure = { deny: 'connect ECONNREFUSED 127.0.0.1:8317' }
  await clock.advance(3 * 60_000)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /cannot reach the proxy for quota data/ })).toBeDefined()
  // The accounts it last said still show, not an empty band.
  expect(await ui.find({ text: /next up: k•••/ })).toBeDefined()
  await ui.unmount()
})

test('band that gets no quota data from the proxy says why', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  // A key that has sent no request through the proxy yet.
  failure = { value: { status: 401, ok: false, headers: {}, text: '{"error":"a client key the proxy accepted in the last week is required"}' } }
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /quota data comes once this key has sent a request through the proxy/ })).toBeDefined()
  await ui.unmount()
  const pane = await $.ui.mount({
    plugin: 'quota-band', surface: 'terminal', component: 'Pane', requestId: 'quota',
    props: { title: 'Accounts and quota', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  expect(await pane.find({ text: /once this key has sent a request/ })).toBeDefined()
  expect(await pane.find({ text: /Is the proxy plugin running/ })).toBeUndefined()
  await pane.unmount()
  // Then the proxy cannot be reached at all.
  failure = { deny: 'connect ECONNREFUSED 100.64.0.1:8317' }
  await clock.advance(10_000)
  const line = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  expect(await line.find({ text: /cannot reach the proxy for quota data: .*connect ECONNREFUSED/ })).toBeDefined()
  await line.unmount()
})

test('a switch the proxy restarts under, or never answers, does not stay pending', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const notice = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
    const row = await ui.find({ key: 'notice' })
    await ui.unmount()
    return row?.text ?? ''
  }
  const switchToK = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
    await ui.press({ key: 'switch' })
    await ui.press({ key: 'to-claude-k' })
    await ui.unmount()
  }
  await switchToK()
  expect(await notice()).toMatch(/Switch to k•••…/)
  // The proxy restarts before acknowledging it: the new run never will.
  snapshot = { ...SNAP, boot_id: 'b2', sequence: 1 }
  await clock.advance(10_000)
  expect(await notice()).toMatch(/Switch to k•••: the proxy restarted before confirming it/)
  // Again, and nothing reads it: a minute on it expires.
  await switchToK()
  await clock.advance(50_000)
  expect(await notice()).toMatch(/Switch to k•••…/)
  await clock.advance(20_000)
  expect(await notice()).toMatch(/Switch to k•••: no answer from the proxy; is it running\?/)
})

test('a routed session keeps back beside switch, for another account or model of the route', async ($, on) => {
  const codexCred = (id: string, label: string) =>
    ({ id, auth_index: id, label, order: 1, tier: 1, reason: 'weekly quota resets soonest', sessions: 0, windows: [] })
  const routed: Snap = {
    ...SNAP,
    providers: { ...SNAP.providers, codex: { health: 'healthy', credentials: [codexCred('codex-a', 'a•••'), codexCred('codex-b', 'b•••')] } },
    sessions: {
      s1: {
        ...SNAP.sessions.s1!, provider: 'codex', model: 'gpt-6.1-sol', requested_model: 'claude-opus-5-5', auth_id: 'codex-a', auth_label: 'a•••',
        route: { provider: 'codex', model: 'gpt-6.1-sol', auto: false, at: iso(-60_000) },
      },
    },
  }
  stubSession(on, routed)
  models = [
    { id: 'gpt-6.1-sol', owned_by: 'openai', created: 3 }, { id: 'gpt-6-astra', owned_by: 'openai', created: 1 },
    { id: 'claude-opus-5-5', owned_by: 'anthropic', created: 2 },
  ]
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /^→ gpt-6.1-sol$/ })).toBeDefined()
  expect(await ui.find({ key: 'unroute' })).toBeDefined()
  await ui.press({ key: 'switch' })
  expect(await ui.find({ key: 'to-codex-b' })).toBeDefined()
  expect(await ui.find({ key: 'prov-claude' })).toBeUndefined() // `back to Claude` is that way
  await ui.press({ key: 'prov-codex' })
  expect(await ui.find({ text: /^gpt-6.1-sol \(now\)$/ })).toBeDefined()
  await ui.press({ key: 'model-gpt-6-astra' })
  expect(commands).toMatchObject([{ action: 'route', provider: 'codex', model: 'gpt-6-astra', session: 's1' }])
  await ui.unmount()
})

test('a narrow band keeps a way into the switch menu', async ($, on) => {
  stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const [cols, rows] of [[60, 20], [44, 1]] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(cols, true, rows) })
    expect(await ui.find({ key: 'view-cards' })).toBeUndefined() // too narrow for cards
    await ui.press({ key: 'switch' })
    expect(await ui.find({ key: 'to-claude-k' })).toBeDefined()
    await ui.press({ key: 'no' })
    await ui.unmount()
  }
})

test('the one-line cache meter shows what is left of the cache, as its card does', async ($, on) => {
  const clock = stubSession(on, SNAP)
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'Done.', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 12_000 },
    } as never
  })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const cells = async () => {
    const line = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
    const meter = await line.find({ key: 'meter-cache' })
    await line.unmount()
    return filledCells(meter)
  }
  expect(await cells()).toBe(0) // nothing cached before a reply
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: SESSION.model } as never)) void chunk
  expect(await cells()).toBe(5) // the whole hour left
  // Eight minutes on, the proxy rewriting its snapshot as it does at least once a minute.
  for (let minute = 0; minute < 8; minute++) {
    snapshot = { ...SNAP, generated_at: new Date(clock.now()).toISOString() }
    await clock.advance(60_000)
  }
  expect(await cells()).toBe(4) // 52 of 60 minutes
})

test('band names the account a session on a Claude Code alias will get, before the proxy has seen it', async ($, on) => {
  // Claude Code reports the model as /model shows it: `opus[1m]`.
  stubSession(on, { ...SNAP, sessions: {} })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /^Max 20x · expected$/ })).toBeDefined()
  expect(await ui.find({ text: /^no quota data$/ })).toBeUndefined()
  await ui.unmount()
})

test('band on another device reads the snapshot over the network and sends its commands with it', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  // No settings hook beneath; the session started in jesse, then /cd moved its root elsewhere.
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  repo = { root: '/Users/me/Documents/developer', remote: 'git@github.com:me/jesse.git', internal: false }
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(sentTo).toBe('https://mac.tailnet.ts.net:8317/v0/resource/plugins/quota-pilot/band')
  expect(sent.Authorization).toBe('Bearer sk-device')

  // The proxy cannot read this device's transcript: the band says what the session is, in
  // headers. Resumed, no event says a title, so the transcript's is read (a rename wins).
  await $.classic.SessionStart({ session_id: SESSION.id, transcript_path: '/Users/me/.claude/projects/p/s1.jsonl', source: 'resume' })
  root = '/Users/me/elsewhere'
  await clock.advance(10_000)
  expect(sent).toEqual({
    Authorization: 'Bearer sk-device',
    'X-Band-Session': 's1',
    'X-Band-Model': 'opus%5B1m%5D',
    'X-Band-Title': 'Fix%20the%20%22login%22%20page',
    'X-Band-Cwd': '%2FUsers%2Fme%2FDocuments%2Fdeveloper%2Fjesse',
    'X-Band-Root': '%2FUsers%2Fme%2FDocuments%2Fdeveloper',
    'X-Band-Repo': 'github.com%2Fme%2Fjesse',
  })
  // A title a hook event says is the one sent, and the folder it started in stays.
  await $.classic.UserPromptSubmit({ session_id: SESSION.id, prompt: 'hi', session_title: 'Login revamp' })
  await clock.advance(10_000)
  expect(sent['X-Band-Title']).toBe('Login%20revamp')
  expect(sent['X-Band-Cwd']).toBe('%2FUsers%2Fme%2FDocuments%2Fdeveloper%2Fjesse')

  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
  // A switch goes with the next read of /band, for this session, and settles by the snapshot's
  // acknowledgement.
  await ui.press({ key: 'switch' })
  await ui.press({ key: 'to-claude-k' })
  await ui.unmount()
  expect(commands).toMatchObject([{ session: 's1', boot_id: 'b1', action: 'switch', auth_id: 'claude-k' }])
  snapshot = { ...SNAP, acks: [{ command_id: commands[0]!.command_id!, session: 's1', status: 'applied', at: new Date().toISOString() }] }
  await clock.advance(10_000)
  const after = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect((await after.find({ key: 'notice' }))?.text).toMatch(/Switch to k•••: done/)
  expect(commands).toHaveLength(1) // sent once
  await after.unmount()
})

test('band forgets the conversation it leaves, on a resume as on a clear', async ($, on) => {
  stubSession(on, SNAP)
  // A reply that wrote and read the prompt cache, as the engine reports it.
  const WROTE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 12_000 }
  let usage = WROTE
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const cacheText = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
    const waiting = await ui.find({ text: /^waiting$/ })
    await ui.unmount()
    return waiting ? 'waiting' : 'warm'
  }
  // A reply that neither read nor wrote the cache, as one under the smallest cached prompt, says
  // nothing of it.
  usage = { input_tokens: 900, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: SESSION.model } as never)) void chunk
  expect(await cacheText()).toBe('waiting')
  usage = WROTE
  for (const reason of ['clear', 'resume'] as const) {
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: SESSION.model } as never)) void chunk
    expect(await cacheText()).toBe('warm')
    await $.session.end({ reason, sessionId: SESSION.id } as never)
    expect(await cacheText()).toBe('waiting')
  }
})

test('band reads a proxy without api-keys with no key of its own', async ($, on) => {
  stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(sentTo).toBe('https://mac.tailnet.ts.net:8317/v0/resource/plugins/quota-pilot/band')
  expect(sent.Authorization).toBeUndefined()
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
  await ui.unmount()
})

test('band reloaded mid-session learns its transcript from the next prompt', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  on('classic.UserPromptSubmit', () => ({}))
  root = '/Users/me/notes'
  // No start event: the band loaded after the session began.
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(sent['X-Band-Title']).toBeUndefined()
  await $.classic.UserPromptSubmit({ session_id: SESSION.id, prompt: 'hi', transcript_path: '/Users/me/.claude/projects/p/s1.jsonl' })
  await clock.advance(10_000)
  expect(sent['X-Band-Title']).toBe('Fix%20the%20%22login%22%20page')
  expect(sent['X-Band-Cwd']).toBe('%2FUsers%2Fme%2Fnotes')
  expect(sent['X-Band-Root']).toBeUndefined()
  expect(sent['X-Band-Repo']).toBeUndefined()
})

test('band on another device names a session Claude Code has not titled by its first request', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  on('classic.SessionStart', () => ({}))
  root = '/Users/me'
  // Claude Code titles no request under ten characters: "hi" leaves the session untitled. What
  // it writes first (a caveat, a command, an image) is passed over, as the proxy's Mac does.
  const requests = [
    userRecord('Caveat: The messages below were generated by the user while running local commands.'),
    userRecord('<command-name>/model</command-name>'),
    userRecord([{ type: 'image', source: {} }, { type: 'text', text: '  ⁣hi\nthere' }]),
    userRecord('a later request'),
  ].join('\n') + '\n'
  transcript = requests
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await $.classic.SessionStart({ session_id: SESSION.id, transcript_path: '/Users/me/.claude/projects/p/s1.jsonl', source: 'startup' })
  await clock.advance(10_000)
  expect(sent['X-Band-Title']).toBe('hi')
  // A longer request later gets the session Claude Code's title, which then names it.
  transcript = '"aiTitle":"Greeting and setup"\n' + requests
  await clock.advance(60_000)
  expect(sent['X-Band-Title']).toBe('Greeting%20and%20setup')
})

test('quota pane lists every window kind for every account and says what the settings do', async ($, on) => {
  const snap: Snap = {
    ...SNAP,
    providers: {
      claude: {
        ...SNAP.providers.claude!,
        credentials: SNAP.providers.claude!.credentials.map(c =>
          c.id === 'claude-k'
            ? { ...c, windows: [...c.windows, { kind: '7d_fable', label: 'Weekly Fable', remaining: 1, reset_at: iso(30 * 24 * H), observed_at: iso(-60_000), stale: false }] }
            : { ...c, absent: ['7d_opus'] }),
      },
    },
  }
  stubSession(on, snap)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'quota-band', surface, component: 'Pane', requestId: 'quota',
      props: { title: 'Accounts and quota', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    } as never)
    expect(await pane.find({ text: /^not reported yet$/ })).toBeDefined() // d••• has not said a Fable window
    // A limit no account reports, one says it has not: its row is there to say so.
    expect(await pane.find({ text: /^Weekly Opus$/ })).toBeDefined()
    expect(await pane.find({ text: /^no such limit$/ })).toBeDefined()
    expect(await pane.find({ text: /^this session$/ })).toBeDefined()
    expect(await pane.find({ text: /^use gpt-6-sol \(Codex\)$/ })).toBeDefined()
    expect(await pane.find({ text: /^off$/ })).toBeDefined()
    const unread = await pane.find({ key: 'w-claude-d-7d_fable' })
    expect((unread?.children[2] as { props: { width: number } })?.props.width).toBe(26)
    await pane.unmount()
  }
})

test('switch walks from the provider to its newest models and routes the session', async ($, on) => {
  const snap: Snap = {
    ...SNAP,
    providers: {
      ...SNAP.providers,
      codex: { health: 'healthy', credentials: [{ id: 'codex-k', auth_index: '3', label: 'k•••', order: 1, tier: 1, reason: 'weekly quota resets soonest', sessions: 0, windows: [] }] },
    },
  }
  stubSession(on, snap)
  models = [
    { id: 'gpt-6.1-sol', owned_by: 'openai', created: 3 }, { id: 'gpt-6-astra', owned_by: 'openai', created: 1 },
    { id: 'gpt-6-sol', owned_by: 'openai', created: 2 }, { id: 'gpt-image-2', owned_by: 'openai', created: 4 },
  ]
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  await ui.press({ key: 'switch' })
  expect(await ui.find({ text: /Switch this session to:/ })).toBeDefined()
  await ui.press({ key: 'prov-codex' })
  expect(await ui.find({ key: 'model-gpt-6.1-sol' })).toBeDefined()
  expect(await ui.find({ key: 'model-gpt-6-astra' })).toBeDefined()
  expect(await ui.find({ key: 'model-gpt-6-sol' })).toBeUndefined() // an older sol
  expect(await ui.find({ key: 'model-gpt-image-2' })).toBeUndefined()
  await ui.press({ key: 'model-gpt-6.1-sol' })
  expect(commands).toMatchObject([{ action: 'route', provider: 'codex', model: 'gpt-6.1-sol', session: 's1' }])
  await ui.unmount()
})


test('cards on request while Claude works, one line on request while it waits', async ($, on) => {
  stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const working = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  expect(await working.find({ text: /^Accounts$/ })).toBeUndefined()
  await working.press({ key: 'view-cards' })
  expect(await working.find({ text: /^Accounts$/ })).toBeDefined()
  await working.unmount()
  // Waiting is another stretch: cards again by default, and they fold to one line on request.
  const idle = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await idle.find({ text: /^Accounts$/ })).toBeDefined()
  await idle.press({ key: 'view-line' })
  expect(await idle.find({ text: /^Accounts$/ })).toBeUndefined()
  expect(await idle.find({ key: 'view-cards' })).toBeDefined()
  await idle.unmount()
  // Too narrow for cards: nothing to open.
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(60, true) })
  expect(await narrow.find({ key: 'view-cards' })).toBeUndefined()
  await narrow.unmount()
})


/** A reply that read 400k of the conversation from the cache and wrote 12k: the cache is warm. */
const WARM_STEP = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 12_000 }
/** One turn of the reader's: it starts, Claude replies, it ends. */
let turnNo = 0
const reply = async ($: Engine) => {
  const turnId = `t${++turnNo}`
  await $.turn.start({ text: 'go on', turnId } as never)
  for await (const chunk of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5' } as never)) void chunk
  await $.turn.complete({ turnId, answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
}
const stepReplies = (on: On) => on('turn.step', async function* (_$, e) {
  await duringStep?.()
  return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: WARM_STEP } as never
})

const routeSnapshotForReply = (target: string, sequence: number): Snap => ({
  ...SNAP,
  sequence,
  config: { ...SNAP.config, fallback_map: { 'claude-fable': target || 'claude-opus-5-5' } },
  sessions: { s1: {
    ...SNAP.sessions.s1!, model: target || 'claude-fable-5-2', requested_model: 'claude-fable-5-2',
    served_auth_id: 'claude-d',
    route: target ? { provider: 'claude', model: target, from: 'claude-fable-5-2', auto: true, at: iso(sequence > 7 ? 5_000 : -2 * H) } : undefined,
  } },
})
/** Moves the clock on minute by minute, the proxy writing its snapshot as it does. */
const minutes = async (clock: MockClock, n: number) => {
  for (let m = 0; m < n; m++) {
    snapshot = { ...snapshot, generated_at: new Date(clock.now()).toISOString() }
    await clock.advance(60_000)
  }
}
const rowText = async ($: Engine, key = 'alert') => {
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  const row = await ui.find({ key })
  await ui.unmount()
  return row?.text ?? ''
}
const composer = (text: string, extra: Record<string, unknown> = {}) => ({ text, origin: { kind: 'composer' }, wait: false, ...extra }) as never

test("band in the desktop app, signed in to Claude directly, shows that account's own limits and asks no proxy", async ($, on) => {
  stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  limits = [{ kind: 'five_hour', percentUsed: 31, resetsAt: iso(2 * H) }, { kind: 'seven_day', percentUsed: 12, resetsAt: iso(50 * H) }]
  await $.session.start({ cwd: SESSION.cwd, surface: 'desktop', isInteractive: true } as never)
  expect(sentTo).toBe('') // no /band read: there is no proxy
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    expect(await ui.find({ text: /proxy|quota-pilot|404/ })).toBeUndefined()
    expect(await ui.find({ text: /claude\.ai/ })).toBeDefined()
    expect(await ui.find({ text: /^31%$/ })).toBeDefined() // the 5-hour limit, as Claude Code reports it
    expect(await ui.find({ text: /^12%$/ })).toBeDefined()
    expect(await ui.find({ key: 'switch' })).toBeUndefined() // no accounts to switch to, or to list
    expect(await ui.find({ key: 'quota' })).toBeUndefined()
    expect(await ui.find({ text: /^Accounts$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('band on a direct login to a plan with no 5-hour limit leaves its tile out, once Claude Code has reported its limits', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const band = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
    const tiles = [(await ui.find({ key: 'five' }))?.text ?? '', (await ui.find({ key: 'week' }))?.text ?? '']
    await ui.unmount()
    return tiles
  }
  // Before any reply Claude Code reports no limit at all: nothing is known yet.
  expect((await band())[0]).toMatch(/after the first reply/)
  limits = [{ kind: 'seven_day', percentUsed: 12, resetsAt: iso(50 * H) }]
  await clock.advance(10_000)
  const [five, week] = await band()
  expect(five).toBe('')
  expect(week).toMatch(/12%/)
  const desk = await $.ui.mount({ plugin: 'quota-band', surface: 'desktop', ...BAND(100, false) })
  const rows = (await desk.find({ key: 'cards' }))?.children as { children: unknown[] }[]
  expect(rows.map(r => r.children.length)).toEqual([2, 2])
  expect(await desk.find({ key: 'five' })).toBeUndefined()
  expect(await desk.find({ key: 'fable' })).toBeUndefined()
  await desk.unmount()
  // The pane says it, once.
  const pane = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...PANE_MOUNT } as never)
  expect((await pane.findAll({ type: 'Text', text: /Its plan has no 5-hour limit\.$/ })).length).toBe(1)
  await pane.unmount()
})

const WEEK: SnapWindow = { kind: '7d', label: 'Weekly', remaining: 0.36, reset_at: iso(62 * H), observed_at: iso(-60_000), stale: false }
const FABLE: SnapWindow = { kind: '7d_fable', label: 'Weekly Fable', remaining: 0.84, reset_at: iso(110 * H), observed_at: iso(-60_000), stale: false }
const FIVE = SNAP.providers.claude!.credentials[0]!.windows[0]!

/** The snapshot with both accounts on a plan of these windows, which says it has none of `absent`, and the session on `model`. */
const onPlan = (windows: SnapWindow[], absent: string[], model: string): Snap => ({
  ...SNAP,
  providers: { claude: { ...SNAP.providers.claude!, credentials: SNAP.providers.claude!.credentials.map(c => ({ ...c, plan: 'Ultra', windows, absent })) } },
  sessions: { s1: { ...SNAP.sessions.s1!, model } },
})

type Drawn = { props?: { key?: string }; children?: unknown[] }
const keyOf = (node: unknown) => String((node as Drawn).props?.key ?? '')
/** The band's tiles in a terminal `columns` wide, row by row, each by its key. */
const tileRows = async ($: Engine, columns: number): Promise<string[][]> => {
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(columns, false) })
  const tiles = await ui.find({ key: 'tiles' })
  await ui.unmount()
  const rows = (tiles?.children ?? []) as Drawn[]
  return rows.some(r => keyOf(r).startsWith('row-')) ? rows.map(r => (r.children ?? []).map(keyOf)) : [rows.map(keyOf)]
}

test('a plan without a 5-hour limit has no 5-hour tile, card or meter; the pane keeps per-account rows', async ($, on) => {
  stubSession(on, onPlan([WEEK], ['5h', '7d_fable', '7d_opus', '7d_sonnet'], 'claude-opus-5-5'))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const working of [false, true]) {
      const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, working) })
      expect(await ui.find({ text: /^(5-hour|5h)$/ })).toBeUndefined()
      expect(await ui.find({ text: /no such limit/ })).toBeUndefined()
      expect(await ui.find({ text: /^64%$/ })).toBeDefined() // the week stays
      await ui.unmount()
    }
  }
  expect(await tileRows($, 160)).toEqual([['account', 'week', 'fable', 'ctx', 'cache', 'all']])
  expect(await tileRows($, 100)).toEqual([['account', 'week', 'fable'], ['ctx', 'cache', 'all']])
  expect(await tileRows($, 80)).toEqual([['account', 'week', 'fable'], ['ctx', 'cache', 'all']])
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quota-band', surface, ...PANE_MOUNT } as never)
    for (const id of ['claude-d', 'claude-k']) {
      for (const kind of ['5h', '7d_fable', '7d_opus', '7d_sonnet']) {
        expect((await pane.find({ key: `w-${id}-${kind}` }))?.text).toMatch(/no such limit$/)
      }
    }
    expect((await pane.findAll({ type: 'Text', text: /^Weekly$/ })).length).toBe(2)
    await pane.unmount()
  }
})

for (const model of ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
  test(`a plan without a 5-hour limit shows Fable beside the week on ${model}, even with more left`, async ($, on) => {
    // As Claude's Ultra reports it: no 5-hour limit, and Fable's week with more left than the week.
    stubSession(on, onPlan([WEEK, FABLE], ['5h', '7d_opus', '7d_sonnet'], model))
    selectedModel = model
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
      const [week, fable] = [await ui.find({ key: 'week' }), await ui.find({ key: 'fable' })]
      expect(week?.text).toMatch(/Weekly.*64%.*resets in 2d 14h/)
      expect(week?.text).not.toMatch(/Fable/)
      expect(fable?.text).toMatch(/Weekly Fable.*16%.*resets in 4d 14h/)
      await ui.unmount()
      // On one line: the week, then Fable's.
      const line = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, true) })
      expect((await line.find({ key: 'meter-7d' }))?.text).toMatch(/64%/)
      expect((await line.find({ key: 'meter-fable' }))?.text).toMatch(/16%/)
      await line.unmount()
    }
    // In the place the 5-hour tile had.
    expect(await tileRows($, 160)).toEqual([['account', 'week', 'fable', 'ctx', 'cache', 'all']])
    // At their narrowest the tiles have no room for "used" beside "Weekly Fable": every figure goes without.
    const tight = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(142, false) })
    expect((await tight.find({ key: 'fable' }))?.text).toMatch(/^Weekly Fable16%━/)
    expect((await tight.find({ key: 'week' }))?.text).toMatch(/^Weekly64%━/)
    expect((await tight.find({ key: 'ctx' }))?.text).toMatch(/^Context42%━/)
    await tight.unmount()
    expect(await tileRows($, 100)).toEqual([['account', 'week', 'fable'], ['ctx', 'cache', 'all']])
  })
}

test("Fable stays visible when tighter and across model changes; other models keep their weekly limit", async ($, on) => {
  const tight = { ...FABLE, remaining: 0.1 }
  const clock = stubSession(on, onPlan([WEEK, tight], ['5h', '7d_opus', '7d_sonnet'], 'claude-fable-5-2'))
  selectedModel = 'claude-fable-5-2'
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect((await ui.find({ key: 'week' }))?.text).toMatch(/^Weekly64%/)
  expect((await ui.find({ key: 'fable' }))?.text).toMatch(/^Weekly Fable90%/)
  await ui.unmount()
  // Too narrow for both: the one with less left stays.
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(44, true, 1) })
  expect(await narrow.find({ key: 'meter-fable' })).toBeDefined()
  expect(await narrow.find({ key: 'meter-7d' })).toBeUndefined()
  await narrow.unmount()
  selectedModel = 'claude-opus-5-5'
  snapshot = { ...onPlan([WEEK, tight], ['5h', '7d_opus', '7d_sonnet'], 'claude-opus-5-5'), sequence: 8 }
  await clock.advance(10_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const opus = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    expect((await opus.find({ key: 'fable' }))?.text).toMatch(/^Weekly Fable90%/)
    expect((await opus.find({ key: 'week' }))?.text).toMatch(/^Weekly64%/)
    await opus.unmount()
  }
  // A model with a weekly limit of its own and no tile for it still shows that one while it is the tighter.
  snapshot = { ...onPlan([WEEK, FABLE, { ...tight, kind: '7d_opus', label: 'Weekly Opus' }], ['5h'], 'claude-opus-5-5'), sequence: 9 }
  await clock.advance(10_000)
  const own = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect((await own.find({ key: 'week' }))?.text).toMatch(/^Weekly Opus90%/)
  expect((await own.find({ key: 'fable' }))?.text).toMatch(/^Weekly Fable16%/)
  await own.unmount()
})

test('the expected account shows Fable before the first proxied request', async ($, on) => {
  stubSession(on, { ...onPlan([WEEK, FABLE], ['5h'], 'claude-opus-5-5'), sessions: {} })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    expect((await ui.find({ key: 'account' }))?.text).toMatch(/expected/)
    expect((await ui.find({ key: 'fable' }))?.text).toMatch(/Weekly Fable.*16%/)
    expect(await ui.find({ key: 'five' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Fable follows Claude account ownership across Codex routes, expected picks and returns', async ($, on) => {
  const claude = onPlan([WEEK, FABLE], ['5h'], 'claude-opus-5-5')
  const providers = {
    ...claude.providers,
    codex: { ...SNAP.providers.claude!, credentials: [{
      ...SNAP.providers.claude!.credentials[0]!, id: 'codex-a', label: 'a•••',
      plan: 'Plus', windows: [WEEK], absent: ['5h'],
    }] },
  }
  const routed = {
    ...SNAP.sessions.s1!, provider: 'codex', model: 'gpt-6.1-sol',
    requested_model: 'claude-opus-5-5', auth_id: 'codex-a', auth_label: 'a•••',
    route: { provider: 'codex', model: 'gpt-6.1-sol', auto: false, at: iso(-60_000) },
  }
  const clock = stubSession(on, { ...claude, providers })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const states: { model: string; sessions: Snap['sessions']; fable: boolean }[] = [
    { model: SESSION.model, sessions: claude.sessions, fable: true },
    { model: SESSION.model, sessions: { s1: routed }, fable: false },
    { model: SESSION.model, sessions: { s1: { ...routed, auth_id: 'removed' } }, fable: false },
    { model: 'gpt-6.1-sol', sessions: {}, fable: false },
    { model: 'gpt-6.1-sol', sessions: { s1: { ...routed, requested_model: 'gpt-6.1-sol', route: undefined } }, fable: false },
    { model: SESSION.model, sessions: claude.sessions, fable: true },
  ]
  for (const state of states) {
    selectedModel = state.model
    snapshot = { ...claude, providers, sessions: state.sessions, sequence: snapshot.sequence + 1 }
    await clock.advance(10_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const working of [false, true]) {
        const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, working) })
        expect(Boolean(await ui.find({ key: working ? 'meter-fable' : 'fable' }))).toBe(state.fable)
        expect((await ui.find({ key: working ? 'meter-7d' : 'week' }))?.text).toMatch(/64%/)
        expect(await ui.find({ key: 'five' })).toBeUndefined()
        expect(await ui.find({ key: 'meter-5h' })).toBeUndefined()
        expect(await ui.find({ text: /not reported yet/ })).toBeUndefined()
        await ui.unmount()
      }
    }
  }
})

test('an account with no Fable limit of its own says so in the tile, and one not read yet says that', async ($, on) => {
  const clock = stubSession(on, onPlan([WEEK], ['5h', '7d_fable', '7d_opus', '7d_sonnet'], 'claude-fable-5-2'))
  selectedModel = 'claude-fable-5-2'
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    const fable = (await ui.find({ key: 'fable' }))?.text ?? ''
    expect(fable).toMatch(/^Weekly Fableno separate limit\s*$/)
    expect(fable).not.toMatch(/%/) // no figure where there is no limit
    await ui.unmount()
    // One line has meters only: none for a limit the account lacks.
    const line = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, true) })
    expect(await line.find({ key: 'meter-fable' })).toBeUndefined()
    await line.unmount()
  }
  snapshot = { ...onPlan([WEEK], ['5h'], 'claude-fable-5-2'), sequence: 8 }
  await clock.advance(10_000)
  const unread = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect((await unread.find({ key: 'fable' }))?.text).toMatch(/not reported yet/)
  await unread.unmount()
})

test('a plan with a 5-hour limit retains two quota tiles and the tighter weekly reading', async ($, on) => {
  const clock = stubSession(on, onPlan([FIVE, WEEK, FABLE], ['7d_opus', '7d_sonnet'], 'claude-fable-5-2'))
  selectedModel = 'claude-fable-5-2'
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(await tileRows($, 165)).toEqual([['account', 'five', 'week', 'ctx', 'cache', 'all']])
  expect(await tileRows($, 120)).toEqual([['account', 'five', 'week', 'ctx', 'cache']])
  expect(await tileRows($, 100)).toEqual([['account', 'five', 'week'], ['ctx', 'cache', 'all']])
  for (const remaining of [0.84, 0.1]) {
    snapshot = { ...onPlan([FIVE, WEEK, { ...FABLE, remaining }], ['7d_opus', '7d_sonnet'], 'claude-fable-5-2'), sequence: snapshot.sequence + 1 }
    await clock.advance(10_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
      expect(await ui.find({ key: 'fable' })).toBeUndefined()
      expect((await ui.find({ key: 'five' }))?.text).toMatch(/5-hour.*88%/)
      expect((await ui.find({ key: 'week' }))?.text).toMatch(remaining === 0.84 ? /Weekly64%/ : /Weekly Fable90%/)
      await ui.unmount()
      const line = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, true) })
      expect(await line.find({ key: 'meter-fable' })).toBeUndefined()
      expect(await line.find({ key: 'meter-5h' })).toBeDefined()
      expect((await line.find({ key: 'meter-7d' }))?.text).toMatch(remaining === 0.84 ? /64%/ : /90%/)
      await line.unmount()
    }
  }
})

test('a cold turn is told before it is sent: why, how much it rewrites, and what it costs', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  expect(await rowText($)).toBe('')
  // Past the hour the cache keeps, kept warm or not: the next turn writes it all again.
  forkReply = { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  await minutes(clock, 70)
  expect(await rowText($)).toMatch(/^! Next turn starts cold: cache expired 10m ago; it rewrites 412k tokens, ≈\$3\.30 at API prices \(\$0\.08 warm\)\s*hand off\s*ok$/)
  // A narrower terminal gets the same in fewer words, on one line.
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(120, false) })
  expect((await narrow.find({ key: 'alert' }))?.text).toMatch(/^! Next turn starts cold: cache expired 10m ago; rewrites 412k ≈\$3\.30 \(\$0\.08 warm\)\s*hand off\s*ok$/)
  await narrow.unmount()
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await ui.press({ key: 'cold-ok' })
  expect(await ui.find({ key: 'alert' })).toBeUndefined() // dismissed for this cold spell
  await ui.unmount()
})

test('a message that would start cold waits in the prompt; Enter again sends it', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  // Warm: it goes.
  expect(await $.prompt.submit(composer('first'))).toMatchObject({ text: 'first' })
  forkReply = { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  await minutes(clock, 61)
  const held = await $.prompt.submit(composer('the login page next'))
  expect(held).toMatchObject({ drop: expect.stringMatching(/held by quota-band: the next turn starts cold/) })
  expect(filled).toEqual([]) // Claude Code puts a dropped prompt back in the box itself
  expect(await rowText($, 'ask')).toMatch(/Message held: next turn starts cold \(cache expired\): rewrites 412k tokens/)
  // Never held: images, a command, one typed while Claude works.
  expect(await $.prompt.submit(composer('look', { attachments: [{ kind: 'image' }] }))).toMatchObject({ text: 'look' })
  expect(await $.prompt.submit(composer('/model sonnet'))).toMatchObject({ text: '/model sonnet' })
  expect(await $.prompt.submit(composer('also this', { turnId: 't9' }))).toMatchObject({ text: 'also this' })
  // The second Enter sends it, and its turn settles the question.
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ text: 'the login page next' })
  await $.turn.start({ text: 'the login page next', turnId: 't9' } as never)
  expect(await rowText($, 'ask')).toBe('')
})

test('a switch while the cache is warm says what it costs, and can hand off first', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await ui.press({ key: 'switch' })
  await ui.press({ key: 'to-claude-k' })
  expect((await ui.find({ key: 'ask' }))?.text).toMatch(/Switch to k•••\? The next turn then starts cold: it rewrites 412k tokens, ≈\$3\.30/)
  expect(commands).toHaveLength(0) // nothing sent yet
  await ui.press({ key: 'yes-move' })
  expect(commands).toMatchObject([{ action: 'switch', auth_id: 'claude-k' }])
  await ui.unmount()
  // The proxy moves the session: its next turn is cold, which the reader chose, so neither the
  // notice nor the guard asks again.
  snapshot = { ...SNAP, sequence: 8, sessions: { s1: { ...SNAP.sessions.s1!, auth_id: 'claude-k', served_auth_id: 'claude-d' } } }
  await clock.advance(10_000)
  expect(await rowText($)).toBe('')
  expect(await $.prompt.submit(composer('carry on'))).toMatchObject({ text: 'carry on' })
})

test('a move the reader did not choose is told, and its next message waits', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  // The proxy moved the session on its own: d••• stopped answering.
  snapshot = { ...SNAP, sequence: 8, sessions: { s1: { ...SNAP.sessions.s1!, auth_id: 'claude-k', served_auth_id: 'claude-d' } } }
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/Next turn starts cold: moved to k•••; it rewrites 412k tokens/)
  expect(await $.prompt.submit(composer('carry on'))).toMatchObject({ drop: expect.any(String) })
})

test('the cache is kept warm shortly before it expires, as many times as set, until the next prompt', { options: { keepWarmDefault: true } }, async ($, on) => {
  // A 5-minute cache, so its refreshes come every few minutes.
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  const caption = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
    const t = (await ui.findAll({ text: /^(expires in|kept warm)/ })).map(x => x.text)
    await ui.unmount()
    return t[0] ?? ''
  }
  await minutes(clock, 3)
  expect(forks).toHaveLength(0)
  await minutes(clock, 1) // a minute before it would expire
  expect(forks).toHaveLength(1)
  expect(forks[0]).toMatch(/automatic prompt-cache refresh/)
  expect(await caption()).toMatch(/^kept warm 1\/3 · 5m$/)
  await minutes(clock, 8)
  expect(forks).toHaveLength(3) // three times, then it lapses
  await minutes(clock, 10)
  expect(forks).toHaveLength(3)
  // A prompt from the reader starts a new stretch, and its reply keeps the cache warm again.
  await reply($)
  await minutes(clock, 4)
  expect(forks).toHaveLength(4)
  // Never while a turn runs: its own requests keep the cache.
  await $.turn.start({ text: 'a long task', turnId: 't-long' } as never)
  await minutes(clock, 10)
  expect(forks).toHaveLength(4)
})

test('a refresh that finds the cache gone stops keeping it warm', { options: { keepWarmDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  // It wrote nearly all of the cache instead of reading it: paid in full once, not again.
  forkReply = { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 411_000 } } } as never
  await minutes(clock, 15)
  expect(forks).toHaveLength(1)
})

test('a session on an API key straight to Anthropic counts a 5-minute cache', async ($, on) => {
  stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'sk-ant-test' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  expect(await ui.find({ text: /^expires in 5m$/ })).toBeDefined()
  await ui.unmount()
})

test('a routed session is not taken for one whose model changed', async ($, on) => {
  const routed: Snap = {
    ...SNAP,
    providers: { ...SNAP.providers, codex: { health: 'healthy', credentials: [{ id: 'codex-a', auth_index: '9', label: 'a•••', order: 1, tier: 1, reason: '', sessions: 1, windows: [] }] } },
    sessions: { s1: { ...SNAP.sessions.s1!, provider: 'codex', model: 'gpt-6.1-sol', requested_model: 'claude-opus-5-5', auth_id: 'codex-a', served_auth_id: 'codex-a', route: { provider: 'codex', model: 'gpt-6.1-sol', auto: false, at: iso(-60_000) } } },
  }
  stubSession(on, routed)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  expect(await rowText($)).toBe('')
})

for (const [transition, before, after] of [
  ['creation', '', 'claude-opus-5-5'],
  ['replacement', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  ['return', 'claude-opus-5-5', ''],
] as const) {
  test(`a cached reply confirms route ${transition} before holding or keeping warm`, { options: { holdColdDefault: true, keepWarmDefault: true } }, async ($, on) => {
    const clock = stubSession(on, routeSnapshotForReply(before, 7), { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
    selectedModel = 'claude-fable-5-2'
    stampReads = true
    stepReplies(on)
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    await clock.advance(5_000)
    duringStep = () => { snapshot = routeSnapshotForReply(after, 8) }
    await $.turn.start({ text: 'go on', turnId: 'r1' } as never)
    for await (const chunk of $.turn.step({ turnId: 'r1', index: 0, model: 'claude-fable-5-2' } as never)) void chunk
    await $.turn.complete({ turnId: 'r1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await clock.settle()
    expect(await rowText($)).not.toContain('Next turn starts cold')
    expect(await $.prompt.submit(composer('carry on with the warm cache'))).toMatchObject({ text: 'carry on with the warm cache' })
    await minutes(clock, 4)
    expect(forks).toHaveLength(1)
  })
}

for (const confirmation of ['network failure', 'missing session', 'a read that gave up'] as const) {
  test(`an unconfirmed cached reply records an unknown route after ${confirmation}`, { options: { holdColdDefault: true, keepWarmDefault: true } }, async ($, on) => {
    const clock = stubSession(on, routeSnapshotForReply('', 7), { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
    selectedModel = 'claude-fable-5-2'
    stampReads = true
    stepReplies(on)
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    await clock.advance(5_000)
    duringStep = () => {
      snapshot = routeSnapshotForReply('claude-opus-5-5', 8)
      if (confirmation === 'network failure') failure = { deny: 'connect ECONNREFUSED 127.0.0.1:8317' }
      else if (confirmation === 'missing session') snapshot = { ...snapshot, sessions: {} }
      else hang = /\/band$/
    }
    await $.turn.start({ text: 'go on', turnId: 'r1' } as never)
    const stepped = (async () => {
      for await (const chunk of $.turn.step({ turnId: 'r1', index: 0, model: 'claude-fable-5-2' } as never)) void chunk
    })()
    // The step's read gives up at the deadline.
    if (confirmation === 'a read that gave up') await clock.advance(3_000)
    await stepped
    await $.turn.complete({ turnId: 'r1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await clock.settle()
    failure = undefined
    hang = undefined
    snapshot = routeSnapshotForReply('claude-opus-5-5', 9)
    await clock.advance(10_000)
    expect(await rowText($)).not.toContain('Next turn starts cold')
    expect(await $.prompt.submit(composer('carry on after confirmation recovers'))).toMatchObject({ text: 'carry on after confirmation recovers' })
    await minutes(clock, 4)
    expect(forks).toHaveLength(1)
  })
}

test('a resume while confirming a reply cannot restore the old cache or effort', async ($, on) => {
  const clock = stubSession(on, routeSnapshotForReply('', 7))
  selectedModel = 'claude-fable-5-2'
  stepReplies(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  duringStep = () => {
    duringId = async () => {
      duringId = undefined
      await $.session.end({ reason: 'resume', sessionId: SESSION.id } as never)
      currentId = 's-other'
    }
  }
  await $.turn.start({ text: 'go on', turnId: 'r1' } as never)
  for await (const chunk of $.turn.step({ turnId: 'r1', index: 0, model: 'claude-fable-5-2', effort: 'max' } as never)) void chunk
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  expect(await ui.find({ text: /^waiting$/ })).toBeDefined()
  expect(await ui.find({ text: /max/ })).toBeUndefined()
  await ui.unmount()
})

test('a handoff runs once however often it is asked, and leaves a conversation that changed meanwhile', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  // While the note is written the reader resumes another conversation.
  forkReply = { value: { isAnswered: true, text: '## Goal\nShip it.', usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as never
  duringFork = () => { currentId = 's-other' }
  const ask = () => $.command.run({ command: 'handoff', args: 'and then the tests', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await Promise.all([ask(), ask()])
  for (let k = 0; k < 20 && !filled.length; k++) await clock.settle()
  expect(forks).toHaveLength(1)
  expect(currentId).toBe('s-other') // not cleared
  expect(submitted).toEqual([])
  expect(filled).toEqual(['and then the tests']) // the message is back in the prompt
  expect(await rowText($, 'notice')).toMatch(/Note saved at ~\/.*; the conversation changed or went on while it was written, so it was not cleared/)
})

test('a handoff whose message names a file puts it all in the prompt, for Enter to send', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: true, text: '## Goal\nShip it.', usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as never
  await $.command.run({ command: 'handoff', args: 'fix @src/auth.ts', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (let k = 0; k < 20 && !filled.length; k++) await clock.settle()
  expect(currentId).toBe('s2')
  expect(submitted).toEqual([])
  expect(filled.at(-1)).toMatch(/## Goal\nShip it\.\n\n---\n\nfix @src\/auth\.ts$/)
})

test('handoff writes the note, saves it, clears, and starts the new session from it with the held message', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: true, text: '## Goal\nShip the login page.', usage: { input_tokens: 5, output_tokens: 90, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as never
  await $.command.run({ command: 'handoff', args: 'then the signup page', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  // The command answers at once; the handoff goes on after it.
  for (let k = 0; k < 20 && !submitted.length; k++) await clock.settle()
  expect(forks[0]).toMatch(/Goal \(what the user wants, and why\); Done/)
  expect(forks[0]).toMatch(/then the signup page/)
  const path = Object.keys(files)[0] ?? ''
  expect(path).toMatch(/^\/Users\/me\/\.cache\/cliproxy-kit\/handoff\/s1-\d{8}-\d{6}\.md$/)
  expect(files[path]).toBe('## Goal\nShip the login page.')
  expect(currentId).toBe('s2') // cleared
  expect(submitted.at(-1)).toBe(`Continue from this handoff note (saved at ${path}):\n\n## Goal\nShip the login page.\n\n---\n\nthen the signup page`)
  expect(await rowText($, 'notice')).toMatch(/Handed off: the new session starts from ~\/\.cache\/cliproxy-kit\/handoff\/s1-/)
})

test('hand off first: the switch waits for the new session, then moves it', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: true, text: '## Goal\nShip it.', usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as never
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await ui.press({ key: 'switch' })
  await ui.press({ key: 'to-claude-k' })
  await ui.press({ key: 'handoff-move' })
  await ui.unmount()
  for (let k = 0; k < 20 && !submitted.length; k++) await clock.settle()
  expect(currentId).toBe('s2')
  // The proxy refuses a command for a session it has not seen: nothing goes yet.
  await clock.advance(10_000)
  expect(commands).toHaveLength(0)
  // The note's turn ran through the proxy: the new session moves.
  snapshot = { ...SNAP, sequence: 9, sessions: { ...SNAP.sessions, s2: { ...SNAP.sessions.s1! } } }
  await clock.advance(10_000)
  expect(commands).toMatchObject([{ action: 'switch', auth_id: 'claude-k', session: 's2' }])
  await clock.advance(10_000)
  expect(commands).toHaveLength(1) // once
})

test('a reply of the conversation a resume left is not taken for the new one', async ($, on) => {
  stubSession(on, SNAP)
  stepReplies(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  // While the reply streams the reader resumes another conversation.
  duringStep = () => $.session.end({ reason: 'resume', sessionId: SESSION.id } as never)
  await reply($)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  expect(await ui.find({ text: /^waiting$/ })).toBeDefined() // nothing known of the new one's cache
  await ui.unmount()
  // Nor its end: the new conversation has had no turn.
  const after = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await after.press({ key: 'view-line' })
  await after.unmount()
  const viewed = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  expect(await viewed.find({ text: /^Accounts$/ })).toBeUndefined() // still the view chosen for this turn
  await viewed.unmount()
})

test('a resumed conversation whose cache expired is held on its first message', { options: { holdColdDefault: true } }, async ($, on) => {
  stubSession(on, SNAP)
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await $.classic.SessionStart({ session_id: SESSION.id, source: 'resume', model: 'claude-opus-5-5', context_tokens: 412_000, seconds_since_last_response: 2 * 3600, prompt_cache_likely_expired: true } as never)
  expect(await $.prompt.submit(composer('continue'))).toMatchObject({ drop: expect.stringMatching(/rewrites 412k tokens/) })
})

test('a handoff leaves a conversation that went on while its note was written', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: true, text: '## Goal\nShip it.', usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as never
  // The reader sends another message meanwhile: the note does not cover its turn.
  duringFork = () => $.turn.start({ text: 'one more thing', turnId: 't-more' } as never)
  await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (let k = 0; k < 20 && !(await rowText($, 'notice')); k++) await clock.settle()
  expect(currentId).toBe(SESSION.id)
  expect(await rowText($, 'notice')).toMatch(/went on while it was written, so it was not cleared/)
})

test('send sends the held message, also from a box that reads empty', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  await minutes(clock, 61)
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ drop: expect.any(String) })
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await ui.press({ key: 'send-held' })
  await ui.unmount()
  expect(submitted.at(-1)).toBe('the login page next')
})

test("a handoff note follows the reader's own prompt when there is one, and the built-in one else", async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CONFIG_DIR: '/Users/me/.config/claude' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: true, text: '- ship it', usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 412_000, cache_creation_input_tokens: 0 } } } as never
  // Under CLAUDE_CONFIG_DIR, as Claude Code's own folder; blank, it is none.
  files['/Users/me/.config/claude/quota-band/handoff-prompt.md'] = '  \n'
  duringFork = async () => {
    expect(await rowText($, 'notice')).toMatch(/^· Writing the handoff note…/)
  }
  await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (let k = 0; k < 20 && !submitted.length; k++) await clock.settle()
  expect(forks[0]).toMatch(/^Write a handoff note so a new session can carry on this work/)
  // The reader's own: it replaces how the note is written; the context still follows it.
  currentId = SESSION.id
  submitted = []
  files['/Users/me/.config/claude/quota-band/handoff-prompt.md'] = 'Three bullet points: what is done, what is next, what to avoid.\n'
  duringFork = async () => {
    expect(await rowText($, 'notice')).toMatch(/^· Writing the handoff note with your prompt…/)
  }
  await $.command.run({ command: 'handoff', args: 'then the tests', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  for (let k = 0; k < 20 && !submitted.length; k++) await clock.settle()
  expect(forks[1]).toMatch(/^Three bullet points: what is done, what is next, what to avoid\.\n\nYour latest reply, which may be missing from this request, was:\nDone\.\n\nThe new session gets this message from the user right after the note:\nthen the tests$/)
})

test('by default nothing is held and an idle session makes no model call', async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 20)
  expect(forks).toHaveLength(0)
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ text: 'the login page next' })
})

/** A slash command typed at the prompt. */
const slash = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: 'inline' } as never) as Promise<{ text?: string }>

test('/keep-warm and /hold-cold say where each stands, and turn it on or off for this window', async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect((await slash($, 'keep-warm')).text).toBe('Keep-warm: off by default (set in /config). /keep-warm on turns it on here.')
  expect((await slash($, 'keep-warm', 'on')).text).toBe('Keep-warm: on in this session (default off, set in /config).')
  expect((await slash($, 'hold-cold', 'maybe')).text).toBe('Use /hold-cold on, off or default.')
  await reply($)
  await minutes(clock, 4)
  expect(forks).toHaveLength(1) // kept warm a minute before it would expire
  expect((await slash($, 'keep-warm', 'off')).text).toBe('Keep-warm: off in this session (default off, set in /config).')
  await minutes(clock, 10)
  expect(forks).toHaveLength(1)
})

test("a window's own choice wins over the /config default, and default follows it again", { options: { holdColdDefault: true } }, async ($, on) => {
  // A 5-minute cache, so it goes cold in a few minutes of the test's clock.
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 6)
  expect((await slash($, 'hold-cold')).text).toBe('Hold: on by default (set in /config). /hold-cold off turns it off here.')
  expect((await slash($, 'hold-cold', 'off')).text).toBe('Hold: off in this session (default on, set in /config).')
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ text: 'the login page next' })
  await reply($)
  await minutes(clock, 6)
  expect((await slash($, 'hold-cold', 'default')).text).toBe('Hold: on by default (set in /config). /hold-cold off turns it off here.')
  expect(await $.prompt.submit(composer('and the signup page'))).toMatchObject({ drop: expect.stringMatching(/held by quota-band/) })
})

/**
 * Claude Code wipes a plugin's `$.state` at the end of every `session.end`, a `/clear` included:
 * from `wipe()` on, quota-band's values read as never written (at the version they stand at, so
 * a write still lands) until the band writes each again.
 */
const hostWipe = (on: On) => {
  const wiped = new Set<string>()
  on('state.get', async (_$, e, next) => {
    const r = await next(e)
    return e.plugin === 'quota-band' && wiped.has(e.key) && 'value' in r ? { value: { value: undefined, version: r.value?.version ?? 0 } } : r
  })
  on('state.set', (_$, e, next) => {
    if (e.plugin === 'quota-band') wiped.delete(e.key)
    return next(e)
  })
  return () => ['snap', 'bandError', 'now', 'session', 'about', 'cache', 'ui', 'models', 'auto'].forEach(k => wiped.add(k))
}

test("a window's choice outlasts a /clear, though the host wipes the band's state, and a resume forgets it", async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  const wipe = hostWipe(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await slash($, 'hold-cold', 'on')
  await $.session.end({ reason: 'clear', sessionId: SESSION.id } as never)
  wipe()
  await $.classic.SessionStart({ session_id: 's2', source: 'clear' })
  await reply($)
  await minutes(clock, 6)
  expect((await slash($, 'hold-cold')).text).toBe('Hold: on in this session (default off, set in /config).')
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ drop: expect.stringMatching(/held by quota-band/) })
  // Another conversation taken up in this window starts from the default again.
  await $.session.end({ reason: 'resume', sessionId: 's2' } as never)
  wipe()
  expect((await slash($, 'hold-cold')).text).toBe('Hold: off by default (set in /config). /hold-cold on turns it on here.')
})

test('a session its launcher marks unattended never holds a typed message or keeps warm, whatever the defaults or a command say', { options: { holdColdDefault: true, keepWarmDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', QUOTA_BAND_UNATTENDED: '1' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect((await slash($, 'hold-cold', 'on')).text).toBe('Hold: off, this session runs unattended (QUOTA_BAND_UNATTENDED). Not changed.')
  await reply($)
  await minutes(clock, 20)
  expect(forks).toHaveLength(0)
  // What an orchestrator types at an idle worker goes in, cold or not.
  const doorbell = ": orchestrator instruction waiting: list '/tmp/inbox'/*.msg and act on each"
  expect(await $.prompt.submit(composer(doorbell))).toMatchObject({ text: doorbell })
})

test('QUOTA_BAND_UNATTENDED=0 is an attended session', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', QUOTA_BAND_UNATTENDED: '0' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 6)
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ drop: expect.stringMatching(/held by quota-band/) })
})

test('Hold above 0 holds a cold message of any size', { options: { holdColdDefault: true, confirmColdAbove: 0 } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  // A small conversation: 8k tokens, read from the cache.
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 0 } } as never
  })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 6)
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ drop: expect.stringMatching(/held by quota-band: the next turn starts cold and rewrites 8k tokens/) })
})

test('a stored keep-warm count of 0, which turned it off before, refreshes once now that it is on', { options: { keepWarmDefault: true, keepWarm: 0 } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 20)
  expect(forks).toHaveLength(1)
})

test('with Hold above 0 a switch while the cache is warm asks first, holding on or not', { options: { confirmColdAbove: 0 } }, async ($, on) => {
  stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(200, false) })
    await ui.press({ key: 'switch' })
    await ui.press({ key: 'to-claude-k' })
    expect(await ui.find({ key: 'yes-move' })).toBeDefined()
    expect(commands).toHaveLength(0) // nothing sent before the reader says so
    await ui.press({ key: 'no' })
    await ui.unmount()
  }
})

test('hold turned off while it is deciding lets that message through and leaves no question', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'desktop', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 6)
  // The desktop app's own prompt: the hold asks which surfaces draw before it decides.
  duringSurfaces = async () => {
    duringSurfaces = undefined
    await slash($, 'hold-cold', 'off')
  }
  const typed = { text: 'the login page next', origin: { kind: 'sdk' }, wait: false } as never
  expect(await $.prompt.submit(typed)).toMatchObject({ text: 'the login page next' })
  expect(await rowText($, 'ask')).toBe('')
})

/** One reply 5 seconds after the start, so a 5-minute cache's refresh falls between the band's 10-second reads. */
const replyOffBeat = async ($: Engine, clock: MockClock) => {
  await clock.advance(5_000)
  await reply($)
}

test('keep-warm turned off while a due refresh is reading starts no model call', { options: { keepWarmDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await replyOffBeat($, clock)
  const due = NOW + 5_000 + 4 * 60_000
  duringId = async now => {
    if (now < due || now >= due + 5_000) return
    duringId = undefined
    await slash($, 'keep-warm', 'off')
  }
  await minutes(clock, 10)
  expect(forks).toHaveLength(0)
})

test('keep-warm turned off and on again while a due refresh is reading still refreshes, once', { options: { keepWarmDefault: true, keepWarm: 1 } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await replyOffBeat($, clock)
  const due = NOW + 5_000 + 4 * 60_000
  duringId = async now => {
    if (now < due || now >= due + 5_000) return
    duringId = undefined
    await slash($, 'keep-warm', 'off')
    await slash($, 'keep-warm', 'on')
  }
  await minutes(clock, 10)
  expect(forks).toHaveLength(1)
})

test("turning holding off settles a held message's question; the message waits in the box for Enter", { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  await minutes(clock, 6)
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ drop: expect.any(String) })
  expect(await rowText($, 'ask')).toMatch(/^\? Message held/)
  await slash($, 'hold-cold', 'off')
  expect(await rowText($, 'ask')).toBe('')
  expect(await $.prompt.submit(composer('the login page next'))).toMatchObject({ text: 'the login page next' })
})

test('a held question left in the band draws only while holding is on', () => {
  const cache = { lastAt: NOW - 2 * H, prompt: 412_000, read: 400_000, creation: 12_000, input: 10, ttlMs: H, lastAnswer: '', model: 'claude-opus-5-5', route: '', warmed: 0, warmStop: false }
  const ui: UiState = {
    switchStep: '', confirm: 'send', move: null, held: 'the login page next', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
    pending: [], notice: '', noticeIsError: false, busy: false, viewOverride: '', viewPhase: '', viewTurn: 0, turns: 1, dismissedSwitch: [],
    noticeLife: null, press: null, pressed: null,
  }
  const input = (holdColdDefault: boolean) => ({
    snap: SNAP, bandError: null, now: NOW, sess: SESSION, cache, ui, models: [], working: false,
    settings: settingsOf({ holdColdDefault }), auto: { holdCold: null, keepWarm: null }, unattended: false, live: { step: null, skew: 0 },
  })
  const act = { ui: () => undefined, send: () => undefined, handoff: () => undefined, sendHeld: () => undefined, quota: () => undefined, auto: () => undefined, settings: () => undefined, press: () => undefined }
  expect(bandFacts(input(true), act).top?.title).toBe('Message held')
  expect(bandFacts(input(false), act).top?.title).not.toBe('Message held')
})

test('the cache card counts refreshes from the start while keeping warm runs, on both surfaces', { options: { keepWarmDefault: true } }, async ($, on) => {
  stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  const caption = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(200, false) })
    const found = await ui.find({ text: /^(expires in|kept warm)/ })
    await ui.unmount()
    return found?.text ?? ''
  }
  expect(await caption('terminal')).toBe('kept warm 0/3 · 1h')
  expect(await caption('desktop')).toBe('expires in 1h · kept warm 0 of 3')
  await slash($, 'keep-warm', 'off')
  expect(await caption('terminal')).toBe('expires in 1h')
})

const PANE_MOUNT = { component: 'Pane', requestId: 'quota', props: { title: 'Accounts and quota', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } }

test('the pane says where each feature stands and flips it for this window, on both surfaces', async ($, on) => {
  stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quota-band', surface, ...PANE_MOUNT } as never)
    expect(await pane.find({ text: /^off by default · from 100k tokens$/ })).toBeDefined()
    expect(await pane.find({ text: /^off by default · up to 3 times$/ })).toBeDefined()
    await pane.press({ key: 'auto-holdCold' })
    expect(await pane.find({ text: /^on in this session · from 100k tokens$/ })).toBeDefined()
    await pane.unmount()
    expect((await slash($, 'hold-cold')).text).toBe('Hold: on in this session (default off, set in /config).')
    await slash($, 'hold-cold', 'default')
  }
})

test("a session signed in directly gets a settings control, and its pane shows the band's settings", async ($, on) => {
  stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  await $.session.start({ cwd: SESSION.cwd, surface: 'desktop', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'quota-band', surface, ...PANE_MOUNT } as never)
    expect(await pane.find({ text: /signs in to Claude directly/ })).toBeDefined()
    expect(await pane.find({ text: /^Cold messages wait$/ })).toBeDefined()
    expect(await pane.find({ key: 'auto-keepWarm' })).toBeDefined()
    await pane.unmount()
  }
})

test("without quota data from the proxy the pane still shows the band's settings", async ($, on) => {
  stubSession(on, SNAP)
  failure = { value: { status: 404, ok: false, headers: {}, text: '' } }
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...PANE_MOUNT } as never)
  expect(await pane.find({ text: /no quota-pilot band route/ })).toBeDefined()
  expect(await pane.find({ key: 'auto-holdCold' })).toBeDefined()
  await pane.unmount()
})

test('a move says why from its record, in a short form where the row would not fit, on both surfaces', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const m of moves) {
    snapshot = {
      ...SNAP,
      generated_at: new Date(clock.now()).toISOString(),
      sessions: { s1: { ...SNAP.sessions.s1!, auth_id: 'claude-k', served_auth_id: 'claude-k', last_switch: { from: 'claude-d', to: 'claude-k', at: new Date(clock.now() - 60_000).toISOString(), ...m.switch } } },
    }
    // A rest's end, from the band's now, which a read moves on 10 s.
    if (m.until_in !== undefined) snapshot.sessions.s1!.last_switch!.cause = { ...m.switch.cause, until: new Date(clock.now() + 10_000 + m.until_in).toISOString() }
    await clock.advance(10_000)
    const full = `Switched d••• → k••• · ${m.why}`
    const short = `Switched d••• → k••• · ${m.short}`
    const wide = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
    expect((await wide.find({ key: 'alert' }))?.text, m.name).toMatch(new RegExp(`^↪ ${esc(full)}\\s*ok$`))
    expect(await wide.find({ key: 'switch-back' }), m.name).toBeUndefined() // no listing since d••• failed
    await wide.unmount()
    // At 80 columns (a 79-column row) the row and its control fit on one line: padding, the mark,
    // the words, a space and ok.
    const fits = (t: string) => 4 + 2 + t.length + 2 + 'ok'.length + 2 <= 79
    const words = fits(full) ? full : short
    expect(fits(words), `${m.name}: "${words}" does not fit 80 columns`).toBe(true)
    for (const surface of ['terminal', 'desktop'] as const) {
      const narrow = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(80, false) })
      expect((await narrow.find({ key: 'alert' }))?.text, `${m.name} on the ${surface}`).toMatch(new RegExp(`${esc(words)}\\s*(ok|Ok)$`))
      await narrow.unmount()
    }
  }
})

test('a move offers switch back while the plugin says the account it left can take the session, by today\'s switch', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const moved = (kind: string, switchBack?: string) => ({
    ...SNAP,
    generated_at: new Date(clock.now()).toISOString(),
    sessions: {
      s1: {
        ...SNAP.sessions.s1!, auth_id: 'claude-k', served_auth_id: 'claude-k', switch_back: switchBack,
        last_switch: { from: 'claude-d', to: 'claude-k', at: new Date(clock.now() - 60_000).toISOString(), reason: 'previous account unavailable; weekly quota resets soonest', kind, cause: { kind: 'overloaded', status: 529, count: 1 } },
      },
    },
  })
  // d••• reads ready (tier 1) but the plugin names no switch_back: no button, whatever the tier.
  snapshot = moved('failed')
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/^↪ Switched d••• → k••• · d••• returned HTTP 529\s*ok$/)
  // Never on the user's own switch.
  snapshot = moved('user', 'claude-d')
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/^↪ Switched d••• → k••• · switched by you\s*ok$/)
  snapshot = moved('failed', 'claude-d')
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/^↪ Switched d••• → k••• · d••• returned HTTP 529\s*switch back\s*ok$/)
  // The desktop card's avatar keeps the label's case: k•••, not K•••.
  const desk = await $.ui.mount({ plugin: 'quota-band', surface: 'desktop', ...BAND(160, false) })
  const marks = (await desk.findAll({ type: 'Svg' })).map(x => String(x.props.source))
  expect(marks.some(m => m.includes('>k</text>'))).toBe(true)
  expect(marks.some(m => m.includes('>K</text>'))).toBe(false)
  await desk.unmount()
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await ui.press({ key: 'switch-back' })
  expect(commands).toMatchObject([{ action: 'switch', auth_id: 'claude-d' }])
  await ui.unmount()
})

test('a session on a resting account is warned of its move, which counts as cold, and the cards say when it is tried again', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  const until = () => new Date(clock.now() + 4 * 60_000 + 10_000).toISOString()
  const resting = (imminent: boolean): Snap => ({
    ...SNAP,
    generated_at: new Date(clock.now()).toISOString(),
    providers: {
      claude: {
        ...SNAP.providers.claude!,
        // Resting ranks it after k•••, which can serve.
        credentials: [
          SNAP.providers.claude!.credentials[1]!,
          { ...SNAP.providers.claude!.credentials[0]!, reason: 'resting after 2 failures', back_at: until(), rest: { until: until(), moments: 2, last_kind: 'overloaded' } },
        ],
      },
    },
    sessions: { s1: { ...SNAP.sessions.s1!, ...(imminent ? { switch_imminent: true, switch_reason: 'resting after 2 failures', next_auth_id: 'claude-k' } : {}) } },
  })
  // No account known to take it: no warning, and the next turn is not cold for it.
  snapshot = resting(false)
  await clock.advance(10_000)
  expect(await rowText($)).toBe('')
  expect(await $.prompt.submit(composer('still warm'))).toMatchObject({ text: 'still warm' })
  snapshot = resting(true)
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/^! d••• resting after 2 failures · moves to k••• \(7% used\) on the next turn/)
  const cards = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  expect(await cards.find({ text: /^resting, back in 4m$/ })).toBeDefined()
  await cards.unmount()
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(80, false) })
  expect((await narrow.find({ key: 'alert' }))?.text).toMatch(/^! d••• resting · moves to k••• next turn/)
  await narrow.unmount()
  // A message into that turn is held as for any move.
  const held = await $.prompt.submit(composer('the login page next'))
  expect(held).toMatchObject({ drop: expect.stringMatching(/held by quota-band/) })
  expect(await rowText($, 'ask')).toMatch(/^\? Message held: next turn starts cold \(moves to k•••, d••• resting\): rewrites 412k tokens/)
  // The pane says why it rests and when it is tried again, as for a limited account.
  const pane = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...PANE_MOUNT } as never)
  expect(await pane.find({ text: /^Max 20x · resting after 2 failures, back in 4m$/ })).toBeDefined()
  await pane.unmount()
})

test('a session whose retry got no answer is warned of its move, which counts as cold and is held', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  snapshot = {
    ...SNAP,
    generated_at: new Date(clock.now()).toISOString(),
    sessions: { s1: { ...SNAP.sessions.s1!, switch_imminent: true, switch_reason: 'got no answer', next_auth_id: 'claude-k', takeover: 'claude-k' } },
  }
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/^! d••• got no answer · moves to k••• \(7% used\) on the next turn/)
  // It fits 80 columns; narrower, its short form.
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(60, false) })
  expect((await narrow.find({ key: 'alert' }))?.text).toMatch(/^! d••• got no answer · moves next turn/)
  await narrow.unmount()
  const held = await $.prompt.submit(composer('try the login page again'))
  expect(held).toMatchObject({ drop: expect.stringMatching(/held by quota-band/) })
  expect(await rowText($, 'ask')).toMatch(/^\? Message held: next turn starts cold \(moves to k•••, d••• got no answer\): rewrites 412k tokens/)
})

// ---- while a turn waits: the live rows ----

const TEXT = { kind: 'text', index: 0, text: 'Looking' }

/** The row while Claude works, at `cols` columns: an alert, or the row of another `key`. */
const liveText = async ($: Engine, cols = 200, surface: 'terminal' | 'desktop' = 'terminal', key = 'alert') => {
  const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(cols, true) })
  const row = await ui.find({ key })
  await ui.unmount()
  return row?.text ?? ''
}

/** The snapshot while the plugin retries d••• after a 529 that ended `ago` ms before the proxy's now. */
const retrying = (proxyNow: number, ago: number, extra: Record<string, unknown> = {}): Snap => ({
  ...SNAP,
  generated_at: new Date(proxyNow).toISOString(),
  sessions: {
    s1: {
      ...SNAP.sessions.s1!, takeover: 'claude-k',
      retry: {
        account: 'claude-d', cause: { kind: 'overloaded', status: 529, wait_ms: 900 }, first_failure_at: new Date(proxyNow - ago).toISOString(), try: 0,
        next_try_at: new Date(proxyNow - ago + 60_000).toISOString(), give_up_at: new Date(proxyNow - ago + 75_000).toISOString(), ...extra,
      },
    },
  },
})

test('the band passes its main step through, every chunk in order, and keeps no step after it (an engine chunk is the engine\'s: tested at stepAfter)', async ($, on) => {
  on('turn.step', async function* (_$, e) {
    yield TEXT as never
    yield { kind: 'text', index: 0, text: 'more' } as never
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: WARM_STEP } as never
  })
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  snapshot = retrying(clock.now(), 10_000)
  await clock.advance(2_000)
  await $.turn.start({ text: 'go on', turnId: 't1' } as never)
  const seen: unknown[] = []
  for await (const c of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5' } as never)) seen.push(c)
  expect(seen).toEqual([TEXT, { kind: 'text', index: 0, text: 'more' }])
  // No step runs: no retry row, though the plugin still names one.
  expect(await liveText($)).toBe('')
})

test('after a retry kept the session, a note says so for 15 minutes', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const kept = (cause: Record<string, unknown>, after: number, cacheRead: number): Snap => ({
    ...SNAP, generated_at: new Date(clock.now()).toISOString(),
    sessions: { s1: { ...SNAP.sessions.s1!, retry_outcome: { account: 'claude-d', cause, tries: 1, after_ms: after, cache_read: cacheRead, at: new Date(clock.now() - 1_000).toISOString() } } },
  })
  for (const [cause, after, read, row] of [
    [{ kind: 'overloaded', status: 529 }, 61_000, 400_000, 'Stayed on d••• after HTTP 529 · the retry 61s later worked; cache kept'],
    [{ kind: 'connection' }, 100, 400_000, 'Stayed on d••• after a lost connection · the retry worked; cache kept'],
    [{ kind: 'hang', wait_ms: 135_000 }, 300, 400_000, 'Stayed on d••• after a 2m 15s hang · the retry worked; cache kept'],
    [{ kind: 'overloaded', status: 529 }, 61_000, 0, 'Stayed on d••• after HTTP 529 · the retry 61s later worked'],
  ] as const) {
    snapshot = kept(cause, after, read)
    await clock.advance(10_000)
    expect(await rowText($)).toMatch(new RegExp(`^↪ ${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*ok$`))
  }
  await clock.advance(15 * 60_000)
  snapshot = { ...snapshot, generated_at: new Date(clock.now()).toISOString() }
  await clock.advance(10_000)
  expect(await rowText($)).toBe('')
})

test('a held message has a short form for a narrow band', { options: { holdColdDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  forkReply = { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  await minutes(clock, 61)
  await $.prompt.submit(composer('the login page next'))
  const narrow = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(80, false) })
  expect((await narrow.find({ key: 'ask' }))?.text).toMatch(/^\? Message held: starts cold, ≈\$3\.30\s*send/)
  await narrow.unmount()
})

test('while the plugin retries the account the band reads every 2 s, then every 10 s again', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  snapshot = retrying(clock.now(), 1_000)
  await clock.advance(10_000)
  bandReads = 0
  await clock.advance(10_000)
  expect(bandReads).toBeGreaterThanOrEqual(5)
  snapshot = { ...SNAP, generated_at: new Date(clock.now()).toISOString() }
  await clock.advance(10_000)
  bandReads = 0
  await clock.advance(20_000)
  expect(bandReads).toBeLessThanOrEqual(3)
})


// The live rows at the view, with the clocks set as a step would leave them.
describe('the live rows', () => {
  const act = { ui: () => undefined, send: () => undefined, handoff: () => undefined, sendHeld: () => undefined, quota: () => undefined, auto: () => undefined, settings: () => undefined, press: () => undefined }
  const ui: UiState = {
    switchStep: '', confirm: '', move: null, held: '', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
    pending: [], notice: '', noticeIsError: false, busy: false, viewOverride: '', viewPhase: '', viewTurn: 0, turns: 1, dismissedSwitch: [],
    noticeLife: null, press: null, pressed: null,
  }
  const cache = { lastAt: NOW - 60_000, prompt: 160_000, read: 150_000, creation: 10_000, input: 10, ttlMs: H, lastAnswer: '', model: 'claude-opus-5-5', route: '', warmed: 0, warmStop: false }
  /** The row at band time NOW, the band's clock `skew` ahead of the proxy's, its step as given. */
  const row = (snap: Snap, step: { startedAt: number; contentAt: number } | null, skew = 0) =>
    bandFacts({
      snap, bandError: null, now: NOW, sess: SESSION, cache, ui, models: [], working: true, settings: settingsOf({}),
      auto: { holdCold: null, keepWarm: null }, unattended: false, live: { step: step && { turnId: 't1', index: 0, ...step }, skew },
    }, act).top
  const proxy = (skew: number) => NOW - skew

  test('the band uses the serialized core offer despite zero-reset quota windows', () => {
    const offered: Snap = {
      ...SNAP,
      config: { ...SNAP.config, fallback_map: { 'claude-fable': 'claude-opus-5-5', claude: 'codex:gpt-6-sol' } },
      providers: { claude: { ...SNAP.providers.claude!, credentials: SNAP.providers.claude!.credentials.map(c => ({
        ...c, windows: [...c.windows, ...['7d_fable', '7d_opus'].map(kind => ({
          kind, label: kind, remaining: 0, reset_at: '0001-01-01T00:00:00Z', observed_at: iso(0), stale: false,
        }))],
      })) }, codex: { health: 'healthy', credentials: [{ ...SNAP.providers.claude!.credentials[0]!, id: 'codex-x', auth_index: '3', label: 'x•••' }] } },
      sessions: { s1: { ...SNAP.sessions.s1!, model: 'claude-fable-5-2', fallback: { provider: 'codex', model: 'gpt-6-sol' } } },
    }
    const snap = parseSnap(JSON.stringify(offered))!
    const input = {
      snap, bandError: null, now: NOW, sess: { ...SESSION, model: 'fable[1m]' },
      cache: { ...cache, prompt: 0, lastAt: 0 }, ui, models: [], working: false,
      settings: settingsOf({}), auto: { holdCold: null, keepWarm: null }, unattended: false,
      live: { step: null, skew: 0 },
    }
    const sent: Move[] = []
    const facts = bandFacts(input, { ...act, send: move => sent.push(move) })
    expect(facts.top?.title.startsWith('fable-5-2 is used up on every account')).toBe(true)
    expect(facts.top?.acts.map(a => a.label)).toEqual(['use gpt-6-sol'])
    facts.top?.acts[0]?.run?.()
    expect(sent).toEqual([{ action: 'route', fields: { provider: 'codex', model: 'gpt-6-sol' }, text: W.routeTo('gpt-6-sol') }])
    const none: Snap = {
      ...snap,
      providers: { claude: { ...snap.providers.claude!, health: 'exhausted', credentials: snap.providers.claude!.credentials.map(c => ({
        ...c, windows: c.windows.map(w => w.kind === '7d' ? { ...w, remaining: 0 } : w),
      })) } },
      sessions: { s1: { ...snap.sessions.s1!, fallback: undefined } },
    }
    expect(bandFacts({ ...input, snap: none }, act).top?.acts.some(a => a.key === 'route') ?? false).toBe(false)
    expect(bandFacts({ ...input, sess: { ...input.sess, model: 'claude-sonnet-5-5' } }, act).top?.acts.some(a => a.key === 'route') ?? false).toBe(false)
    const routed: Snap = { ...snap, sessions: { s1: {
      ...snap.sessions.s1!, model: 'claude-opus-5-5', requested_model: 'claude-fable-5-2',
      route: { provider: 'claude', model: 'claude-opus-5-5', from: 'claude-fable-5-2', auto: true, at: iso(0) },
    } } }
    const next = bandFacts({ ...input, snap: routed }, act)
    expect(next.top?.title.startsWith('opus-5-5 is used up on every account')).toBe(true)
    expect(next.top?.acts.map(a => a.label)).toEqual(['use gpt-6-sol'])
  })

  test('a model-scoped route follows the local model selection before another proxy turn', () => {
    const route = { provider: 'claude', model: 'claude-opus-5-5', from: 'claude-fable-5-2', auto: true, at: iso(-60_000) }
    const snap: Snap = {
      ...SNAP,
      sessions: { s1: { ...SNAP.sessions.s1!, requested_model: 'claude-fable-5-2', route } },
      context_lengths: { ...SNAP.context_lengths, 'claude-opus-5-5': 300_000 },
    }
    const input = (model: string) => ({
      snap, bandError: null, now: NOW, sess: { ...SESSION, model, contextWindow: 700_000 },
      cache: { ...cache, model: 'claude-fable-5-2', route: 'claude-opus-5-5' }, ui, models: [], working: true,
      settings: settingsOf({}), auto: { holdCold: null, keepWarm: null }, unattended: false,
      live: { step: null, skew: 0 },
    })
    for (const model of ['claude-sonnet-5-5', 'sonnet[1m]', 'claude-opus-5-5', 'opus', 'claude-fable-5-1', 'claude-fable-5-2-20261109']) {
      const i = input(model)
      const facts = bandFacts(i, act)
      expect(facts.route).toBe('')
      expect(facts.model).toBe(model.replace('[1m]', ''))
      expect(facts.ctx?.window).toBe(700_000)
      expect(facts.controls.unroute).toBeUndefined()
      expect(facts.top).toBeNull()
      expect(bandFacts({ ...i, ui: { ...ui, confirm: 'switch' } }, act).top?.acts.some(a => a.key === 'unroute')).toBe(false)
      if (model === 'claude-sonnet-5-5') {
        expect(facts.cache.cost).toEqual({ cold: 0.64, warm: 0.016 })
        expect(nextTurn(i).cold).toMatchObject({ reason: 'model', why: 'model changed to sonnet-5-5' })
      }
      if (model === 'claude-opus-5-5' || model === 'opus') expect(nextTurn(i).cold).toBeNull()
    }
    for (const model of ['claude-fable-5-2', 'fable[1m]', 'fable(high)', 'claude-fable-5-2(high)']) {
      const i = input(model)
      const facts = bandFacts(i, act)
      expect(facts.route).toBe('claude-opus-5-5')
      expect(facts.model).toBe('claude-opus-5-5')
      expect(facts.ctx?.window).toBe(300_000)
      expect(facts.controls.unroute).toBeDefined()
      expect(facts.top?.title).toContain('running opus-5-5')
      expect(nextTurn(i).cold).toBeNull()
      expect(bandFacts({ ...i, ui: { ...ui, confirm: 'switch' } }, act).top?.acts.find(a => a.key === 'unroute')?.label).toBe('back to fable-5-2')
    }
    for (const from of [undefined, '']) {
      const manual: Snap = { ...snap, sessions: { s1: { ...snap.sessions.s1!, route: { ...route, from, auto: false } } } }
      const facts = bandFacts({ ...input('claude-sonnet-5-5'), snap: manual }, act)
      expect(facts.route).toBe('claude-opus-5-5')
      expect(facts.controls.unroute).toBeDefined()
    }
  })

  test('waiting: what failed, when it is tried, and who takes over, in full and short', () => {
    for (const skew of [0, 60_000, -60_000]) {
      const step = { startedAt: NOW - 20_000, contentAt: 0 }
      let r = row(retrying(proxy(skew), 12_000), step, skew)
      expect(r?.title, `skew ${skew}`).toBe('d••• returned HTTP 529 · retrying it in about 48s; k••• is next if needed')
      expect(r?.short).toBe('d••• returned HTTP 529 · retrying in 48s')
      expect(row(retrying(proxy(skew), 61_000), step, skew)?.title).toBe('d••• returned HTTP 529 · retrying it now; k••• is next if needed')
      const none = retrying(proxy(skew), 12_000)
      r = row({ ...none, sessions: { s1: { ...none.sessions.s1!, takeover: undefined } } }, step, skew)
      expect(r?.title).toBe('d••• returned HTTP 529 · retrying it in about 48s')
      const usedUp = { ...none, providers: { claude: { ...none.providers.claude!, credentials: none.providers.claude!.credentials.map(c => (c.id === 'claude-k' ? { ...c, unavailable: true, tier: 3 } : c)) } }, sessions: { s1: { ...none.sessions.s1!, takeover: undefined } } }
      expect(row(usedUp, step, skew)?.title).toBe('d••• returned HTTP 529 · retrying it in about 48s; no other account has quota')
      const late = retrying(proxy(skew), 1_000, { cause: { kind: 'server', status: 503, wait_ms: 400 }, next_try_at: new Date(proxy(skew) - 1_000 + 120_000).toISOString() })
      expect(row(late, step, skew)?.title).toBe('d••• returned HTTP 503 · waiting up to 75s for it; k••• is next if needed')
    }
  })

  test('running: how long the retry has run', () => {
    for (const skew of [0, 60_000, -60_000]) {
      const snap = retrying(proxy(skew), 45_000, { cause: { kind: 'hang', wait_ms: 135_000 }, try: 1, try_started_at: new Date(proxy(skew) - 40_000).toISOString() })
      const r = row(snap, { startedAt: NOW - 200_000, contentAt: 0 }, skew)
      expect(r?.title, `skew ${skew}`).toBe('d••• hung for 2m 15s · retrying it, 40s so far; k••• is next if needed')
      expect(r?.short).toBe('d••• hung · retrying it, 40s so far')
    }
  })

  test('only while the main step has had no content since the failure, whatever the clocks', () => {
    for (const skew of [0, 60_000, -60_000]) {
      const snap = retrying(proxy(skew), 10_000) // the failure 10 s ago, on the band's clock
      expect(row(snap, { startedAt: NOW - 60_000, contentAt: NOW - 9_500 }, skew)?.title, `skew ${skew}: content after`).not.toMatch(/HTTP 529/)
      expect(row(snap, { startedAt: NOW - 60_000, contentAt: NOW - 30_000 }, skew)?.title, `skew ${skew}: content before`).toMatch(/^d••• returned HTTP 529/)
      expect(row(snap, null, skew)?.title ?? '', `skew ${skew}: no step`).not.toMatch(/HTTP 529/)
    }
  })

  test('the step\'s chunks as they come: an engine chunk is no answer, content is', () => {
    const start = { turnId: 't1', index: 0, startedAt: NOW - 100_000, contentAt: 0 }
    for (const skew of [0, 60_000, -60_000]) {
      // Claude Code's retry marker 5 s after the failure, then content 60 s after the marker.
      const snap = retrying(proxy(skew), 70_000)
      const marker = stepAfter(start, { kind: 'engine' }, NOW - 65_000)
      expect(row(snap, marker, skew)?.title, `skew ${skew}: the marker alone`).toMatch(/^d••• returned HTTP 529/)
      expect(row(snap, stepAfter(marker, { kind: 'text' }, NOW - 5_000), skew)?.title ?? '', `skew ${skew}: content`).not.toMatch(/HTTP 529/)
      // A side request's retry while the main step streams: content came after the failure.
      let streaming = start
      for (const at of [NOW - 60_000, NOW - 30_000, NOW - 2_000]) streaming = stepAfter(streaming, { kind: 'text' }, at)!
      expect(row(retrying(proxy(skew), 10_000), streaming, skew)?.title ?? '', `skew ${skew}: streaming`).not.toMatch(/HTTP 529/)
    }
    // The hang watch: a retry marker at 20 s, and the row at 30 s.
    const plain = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, takeover: 'claude-k' } } }
    const watched = stepAfter({ ...start, startedAt: NOW - 30_000 }, { kind: 'engine' }, NOW - 10_000)
    expect(row(plain, watched)?.title).toBe('no answer for 30s · if it fails, a retry or another account takes over')
  })

  test('the hang watch: no answer for 30 s, naming no account', () => {
    const plain = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, takeover: 'claude-k' } } }
    let r = row(plain, { startedAt: NOW - 46_000, contentAt: 0 })
    expect(r?.title).toBe('no answer for 46s · if it fails, a retry or another account takes over')
    expect(r?.short).toBe('no answer for 46s')
    // No account known to take over: the short row alone. The provider's only account too.
    r = row(SNAP, { startedAt: NOW - 46_000, contentAt: 0 })
    expect(r?.title).toBe('no answer for 46s')
    expect(row(plain, { startedAt: NOW - 29_000, contentAt: 0 })?.title ?? '').not.toMatch(/no answer/)
    expect(row(plain, { startedAt: NOW - 46_000, contentAt: NOW - 40_000 })?.title ?? '').not.toMatch(/no answer/)
    // A retry of this session's account replaces it.
    expect(row(retrying(NOW, 10_000), { startedAt: NOW - 46_000, contentAt: 0 })?.title).toMatch(/^d••• returned HTTP 529/)
  })
})

// Every live row, note and question in the wording table reads as the shared fixture says, and
// fits one line at 80 columns, in full or short, as the terminal counts it: padding, the mark, its
// words and its controls (`switch to k•••` on the live rows, `ok` on a note).
test('the wording table reads as the shared fixture, and each row fits 80 columns', () => {
  const controls: Record<string, string[]> = {
    kept: ['ok'], moved: ['ok'], pressRefused: ['ok'], pressUnanswered: ['ok'], movesNext: [], stopUnconfirmed: [], pressAsk: ['switch now', 'keep waiting'],
  }
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    // A row's words, a question's title and detail, or a notice's text alone.
    const entry = W[r.row] as unknown
    const out = (typeof entry === 'function' ? entry(...r.args.map(a => (a === null ? undefined : a))) : entry) as string | { text?: string; title?: string; detail?: string; short?: string }
    const words = typeof out === 'string' ? { text: out, short: undefined } : out.title ? { text: `${out.title} ${out.detail}`, short: out.short } : { text: out.text!, short: out.short }
    expect(words.text, r.name).toBe(r.text)
    expect(words.short, r.name).toBe(r.short)
    const acts = controls[r.row] ?? ['switch to k•••']
    const fits = (t: string) => 4 + 2 + t.length + 2 + acts.reduce((n, a) => n + a.length + 2, 0) <= 80
    expect(fits(words.text) || fits(words.short ?? ''), `${r.name} at 80 columns`).toBe(true)
  }
})

/**
 * Starts main turn `turnId` and holds its step at its first chunk, as a step waiting on its request
 * does: the step runs, with `chunk` its only one so far.
 */
const holdStep = async ($: Engine, turnId: string, chunk: unknown, steps: { first: unknown }) => {
  steps.first = chunk
  await $.turn.start({ text: 'go on', turnId } as never)
  const it = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5' } as never)[Symbol.asyncIterator]()
  await it.next()
  return it
}

/** A step's first chunk that is not content, as a test can yield one (the engine's own it cannot). */
const NO_CONTENT = { kind: 'stop', stopReason: 'end_turn', usage: null }

test('the live rows draw while a step waits, on the terminal and in the desktop app, in full or short at 80 columns', async ($, on) => {
  const steps = { first: TEXT as unknown }
  on('turn.step', async function* (_$, e) {
    yield steps.first as never
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: WARM_STEP } as never
  })
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  /** The row at 160 and 80 columns, on the terminal then the desktop app. */
  const drawn = async () => {
    const out: string[] = []
    for (const surface of ['terminal', 'desktop'] as const) for (const cols of [160, 80]) out.push((await liveText($, cols, surface)).trim())
    return out
  }
  // Content, then the failure 5 s later: the waiting row.
  let step = await holdStep($, 't1', TEXT, steps)
  snapshot = { ...retrying(clock.now() + 10_000, 5_000), sequence: 8 }
  await clock.advance(10_000)
  // In full at 160 columns, with its control (ticket 06); at 80 the short form, the control kept.
  const live = (full: string, short: string) => [`! ${full}switch to k•••`, `! ${short}switch to k•••`, `${full}Switch to k•••`, `${short}Switch to k•••`]
  expect(await drawn()).toEqual(live('d••• returned HTTP 529 · retrying it in about 55s; k••• is next if needed', 'd••• returned HTTP 529 · retrying in 55s'))
  // The try runs: the running row, counting.
  snapshot = { ...retrying(clock.now() + 2_000, 7_000, { cause: { kind: 'hang', wait_ms: 135_000 }, try: 1, try_started_at: new Date(clock.now() - 4_000).toISOString() }), sequence: 9 }
  await clock.advance(2_000)
  expect(await drawn()).toEqual(live('d••• hung for 2m 15s · retrying it, 6s so far; k••• is next if needed', 'd••• hung · retrying it, 6s so far'))
  // Content from the retry clears it.
  expect((await step.next()).done).toBe(true)
  expect(await drawn()).toEqual(['', '', '', ''])
  // A step with no content for 30 s: the hang watch, until its end.
  snapshot = { ...SNAP, sequence: 10, generated_at: new Date(clock.now()).toISOString(), sessions: { s1: { ...SNAP.sessions.s1!, takeover: 'claude-k' } } }
  await clock.advance(10_000)
  step = await holdStep($, 't2', NO_CONTENT, steps)
  await clock.advance(29_000)
  expect(await drawn()).toEqual(['', '', '', ''])
  // It counts at each redraw, every 2 s.
  await clock.advance(3_000)
  expect(await drawn()).toEqual(live('no answer for 32s · if it fails, a retry or another account takes over', 'no answer for 32s'))
  await step.next()
  expect(await drawn()).toEqual(['', '', '', ''])
})

// ---- Switch now: `switch to k•••` on a waiting row stops the turn once the switch applies. ----

/** Each main step: its first chunk, where a test may hold it, the chunks after, then its end with `usage`. */
const heldSteps = (on: On) => {
  const steps = { first: NO_CONTENT as unknown, then: [] as unknown[], usage: WARM_STEP as Record<string, number> }
  on('turn.step', async function* (_$, e) {
    yield steps.first as never
    for (const c of steps.then) yield c as never
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: steps.usage } as never
  })
  return steps
}

/**
 * Main turn `turnId` waits: its step has had no content, and quota-pilot retries d••• after a 529
 * that ended 5 s into it, with k••• to take over. Each read is stamped with the test clock's time.
 */
const waitingOn = async ($: Engine, clock: MockClock, steps: { first: unknown }, turnId: string, s1: Record<string, unknown> = {}) => {
  const step = await holdStep($, turnId, NO_CONTENT, steps)
  const t0 = clock.now()
  stampReads = true
  const r = retrying(t0 + 10_000, 5_000)
  snapshot = { ...r, sequence: snapshot.sequence + 1, sessions: { s1: { ...r.sessions.s1!, ...s1 } } }
  await clock.advance(10_000)
  return { step, t0 }
}

/**
 * The proxy's answer to a command with its next read: applied (the session on k•••, its record the
 * user's switch, with the wait) or refused.
 */
const acknowledge = (clock: MockClock, status: 'applied' | 'rejected', reason?: string, cmd = commands[commands.length - 1]!) => {
  const at = new Date(clock.now()).toISOString()
  const s1 = snapshot.sessions.s1!
  snapshot = {
    ...snapshot, sequence: snapshot.sequence + 1, acks: [...snapshot.acks, { command_id: cmd.command_id!, session: 's1', status, reason, at }],
    sessions: status === 'rejected' ? snapshot.sessions : {
      s1: {
        ...s1, auth_id: 'claude-k', auth_label: 'k•••', generation: 4, retry: undefined, takeover: 'claude-d',
        last_switch: { from: 'claude-d', to: 'claude-k', at, reason: 'switched by user', kind: 'user', cause: { waited_ms: Number(cmd.waited_ms) } },
      },
    },
  }
}

/** The turn's aborts the band asked for; a hook above may hold one back (`hold`) or answer it alone. */
const recordAborts = (on: On, hold?: () => Promise<unknown> | undefined) => {
  const aborts: string[] = []
  on('turn.abort', async (_$, e) => {
    aborts.push(e.turnId)
    await hold?.()
    return { value: undefined } as never
  })
  return aborts
}

/** Presses the waiting row's `switch to k•••` on the drawn band. */
const pressSwitchNow = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, true) })
  await ui.press({ key: 'switch-now' })
  await ui.unmount()
}

const aborted = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: true, reason: 'aborted' }) as never

test('switch to k••• on a waiting row sends the switch, stops the turn once it applies, and says how to go on', async ($, on) => {
  const steps = heldSteps(on)
  const aborts = recordAborts(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const { step, t0 } = await waitingOn($, clock, steps, 't1')
  expect(await liveText($)).toBe('! d••• returned HTTP 529 · retrying it in about 55s; k••• is next if neededswitch to k•••')
  // The cache is unknown before any reply: the press goes at once.
  await pressSwitchNow($)
  expect(commands).toEqual([expect.objectContaining({
    action: 'switch', session: 's1', auth_id: 'claude-k', waited_ms: 10_000, generation: 3, step_started_at: new Date(t0).toISOString(),
  })])
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('· Switch to k•••… ')
  expect(aborts).toEqual([]) // nothing stopped before the proxy applied it
  acknowledge(clock, 'applied')
  await clock.advance(2_000)
  expect(aborts).toEqual(['t1'])
  // The abort cancels the step; the turn's end says it stopped.
  await step.return(undefined as never)
  await $.turn.complete(aborted('t1'))
  await clock.advance(2_000)
  expect(aborts).toEqual(['t1'])
  expect(await rowText($)).toBe('↪ Switched d••• → k••• · by you after waiting 10s; send a message to go onok')
  expect(submitted).toEqual([]) // the band sends nothing for the reader
  expect(filled).toEqual([])
  // The reader's next message starts the next turn: the note no longer says how to go on.
  await $.turn.start({ text: 'carry on', turnId: 't2' } as never)
  expect(await rowText($)).toBe('↪ Switched d••• → k••• · by you after waiting 10sok')
})

/** A reply's usage with a prompt of `k` thousand tokens, nearly all read from the cache. */
const promptOf = (k: number) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: (k - 10) * 1000, cache_creation_input_tokens: 10_000 })

test('a press asks first, by the switch rule, while a large cache is warm; else it goes at once', async ($, on) => {
  const steps = heldSteps(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  steps.usage = promptOf(160)
  await reply($)
  let { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  expect(commands).toEqual([])
  const asked = await liveText($, 200, 'terminal', 'ask')
  expect(asked).toMatch(/^\? Switch to k••• now\? This turn stops; your next message starts cold there: it rewrites 160k tokens, ≈\$\d+\.\d\d at API prices \(\$\d+\.\d\d warm\)switch nowkeep waiting$/)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  await ui.press({ key: 'switch-now' })
  await ui.unmount()
  expect(commands).toEqual([expect.objectContaining({ action: 'switch', auth_id: 'claude-k' })])
  await step.return(undefined as never)
  await $.turn.complete({ turnId: 'w1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  // 40k tokens: at once.
  commands = []
  steps.usage = promptOf(40)
  await reply($)
  ;({ step } = await waitingOn($, clock, steps, 'w2'))
  await pressSwitchNow($)
  expect(commands).toEqual([expect.objectContaining({ action: 'switch', auth_id: 'claude-k' })])
  await step.return(undefined as never)
  await $.turn.complete({ turnId: 'w2', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  // 160k gone cold: at once.
  commands = []
  steps.usage = promptOf(160)
  await reply($)
  await clock.advance(61 * 60_000)
  ;({ step } = await waitingOn($, clock, steps, 'w3'))
  await pressSwitchNow($)
  expect(commands).toEqual([expect.objectContaining({ action: 'switch', auth_id: 'claude-k' })])
  await step.return(undefined as never)
})

test('the question closes, with nothing sent, when the step answers first; keep waiting closes it too', async ($, on) => {
  const steps = heldSteps(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  steps.usage = promptOf(160)
  await reply($)
  steps.then = [TEXT]
  const { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  await ui.press({ key: 'keep-waiting' })
  expect(await ui.find({ key: 'ask' })).toBeUndefined()
  await ui.unmount()
  await pressSwitchNow($)
  expect(await liveText($, 200, 'terminal', 'ask')).toMatch(/^\? Switch to k••• now\?/)
  expect((await step.next()).value).toEqual(TEXT) // content comes
  expect(await liveText($, 200, 'terminal', 'ask')).toBe('')
  expect(commands).toEqual([])
})

test('a press goes void when the step answers, or the turn ends, before the switch applies: nothing stops, and the switch is told', async ($, on) => {
  const steps = heldSteps(on)
  const aborts = recordAborts(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  steps.then = [TEXT]
  let { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  expect((await step.next()).value).toEqual(TEXT) // the retry answers before the acknowledgement
  acknowledge(clock, 'applied')
  await clock.advance(2_000)
  expect(aborts).toEqual([])
  await step.next()
  await $.turn.complete({ turnId: 'w1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(await rowText($)).toBe('↪ Switched d••• → k••• · by you after waiting 10sok')
  // The turn ends and the next starts before the acknowledgement: the next is never stopped.
  steps.then = []
  snapshot = { ...SNAP, sequence: snapshot.sequence + 1 }
  await clock.advance(10_000)
  ;({ step } = await waitingOn($, clock, steps, 'w2'))
  await pressSwitchNow($)
  await step.return(undefined as never)
  await $.turn.complete({ turnId: 'w2', answer: '', durationMs: 1, isAborted: false, reason: 'error' } as never)
  ;({ step } = await waitingOn($, clock, steps, 'w3'))
  acknowledge(clock, 'applied')
  await clock.advance(2_000)
  expect(aborts).toEqual([])
  await step.return(undefined as never)
})

test('a refused press says why for 10 s, then the waiting row and its control come back', async ($, on) => {
  const steps = heldSteps(on)
  const aborts = recordAborts(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  acknowledge(clock, 'rejected', 'the session moved meanwhile')
  await clock.advance(2_000)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('· Could not switch to k•••: the session moved meanwhileok')
  expect(await liveText($, 60, 'terminal', 'notice')).toBe('· Could not switch to k•••ok')
  await clock.advance(10_000)
  expect(await liveText($)).toBe('! d••• returned HTTP 529 · retrying it in about 43s; k••• is next if neededswitch to k•••')
  expect(aborts).toEqual([])
  await step.return(undefined as never)
})

test('a refused press keeps its full 10 s after a /band answer delayed by 2 s', async ($, on) => {
  const steps = heldSteps(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const { step } = await waitingOn($, clock, steps, 'slow-refusal')
  await pressSwitchNow($)
  acknowledge(clock, 'rejected', 'the session moved meanwhile')
  let release: (reply: OpEventResult<'http.fetch'>) => void = () => undefined
  failure = new Promise<OpEventResult<'http.fetch'>>(resolve => { release = resolve })
  await clock.advance(2_000)
  await clock.advance(2_000)
  failure = undefined
  release({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(snapshot) } })
  await clock.settle()
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('· Could not switch to k•••: the session moved meanwhileok')
  await clock.advance(9_999)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('· Could not switch to k•••: the session moved meanwhileok')
  await clock.advance(1)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('')
  expect(await liveText($)).toMatch(/^! d••• returned HTTP 529 · retrying it/)
  await step.return(undefined as never)
})

test('no answer within 5 s: the turn keeps waiting; a second press is a new one, and the first switch arriving late is only told', async ($, on) => {
  const steps = heldSteps(on)
  const aborts = recordAborts(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  await clock.advance(5_000)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('· No answer from the proxy within 5s; the turn keeps waitingok')
  await clock.advance(10_000)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('')
  await pressSwitchNow($) // through the drawn band, its control back
  expect(commands).toHaveLength(2)
  expect(commands[1]!.command_id).not.toBe(commands[0]!.command_id)
  // The first switch lands late, and the second is refused for it.
  acknowledge(clock, 'applied', undefined, commands[0])
  acknowledge(clock, 'rejected', 'the session moved meanwhile', commands[1])
  await clock.advance(2_000)
  expect(aborts).toEqual([])
  expect(await liveText($, 200, 'terminal', 'notice')).toBe('· Could not switch to k•••: the session moved meanwhileok')
  await step.return(undefined as never)
  await $.turn.complete({ turnId: 'w1', answer: '', durationMs: 1, isAborted: false, reason: 'error' } as never)
  await clock.advance(10_000)
  expect(await rowText($)).toMatch(/^↪ Switched d••• → k••• · by you after waiting 10sok$/)
})

test('a stop not confirmed within 5 s says so until the turn ends: held back by a hook, its end late, or answered by a hook alone', async ($, on) => {
  let release: () => void = () => undefined
  let holding = false
  const steps = heldSteps(on)
  const aborts = recordAborts(on, () => (holding ? new Promise<void>(r => { release = r }) : undefined))
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const stopped = async (turnId: string, why: 'aborted' | 'answer', s: { return: (v: never) => unknown }) => {
    await s.return(undefined as never)
    await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: why === 'aborted', reason: why } as never)
  }
  const fresh = async () => {
    snapshot = { ...SNAP, sequence: snapshot.sequence + 1 }
    commands = []
    await clock.advance(10_000)
  }
  // The turn's end comes 6 s after the abort.
  let { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  acknowledge(clock, 'applied')
  await clock.advance(2_000)
  await clock.advance(6_000)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe("· Switched to k•••; the turn's stop is not confirmed yet ")
  await stopped('w1', 'aborted', step)
  expect(await rowText($)).toMatch(/send a message to go onok$/)
  expect(aborts).toEqual(['w1'])
  // A hook holds the abort back 6 s, then lets it through.
  await fresh()
  holding = true
  ;({ step } = await waitingOn($, clock, steps, 'w2'))
  await pressSwitchNow($)
  acknowledge(clock, 'applied')
  await clock.advance(2_000)
  await clock.advance(6_000)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe("· Switched to k•••; the turn's stop is not confirmed yet ")
  release()
  holding = false
  await stopped('w2', 'aborted', step)
  expect(await rowText($)).toMatch(/send a message to go onok$/)
  expect(aborts).toEqual(['w1', 'w2'])
  // A hook answers the abort itself, and the turn later ends by itself.
  await fresh()
  ;({ step } = await waitingOn($, clock, steps, 'w3'))
  await pressSwitchNow($)
  acknowledge(clock, 'applied')
  await clock.advance(8_000)
  expect(await liveText($, 200, 'terminal', 'notice')).toBe("· Switched to k•••; the turn's stop is not confirmed yet ")
  await stopped('w3', 'answer', step)
  expect(await rowText($)).toMatch(/by you after waiting 10sok$/)
  expect(aborts).toEqual(['w1', 'w2', 'w3'])
})

test('a message queued during the wait starts the next turn before the stopped one ends: no tail', async ($, on) => {
  const steps = heldSteps(on)
  recordAborts(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const { step } = await waitingOn($, clock, steps, 'w1')
  await pressSwitchNow($)
  acknowledge(clock, 'applied')
  await clock.advance(2_000)
  await $.turn.start({ text: 'queued', turnId: 'w2' } as never)
  await step.return(undefined as never)
  await $.turn.complete(aborted('w1'))
  expect(await rowText($)).toBe('↪ Switched d••• → k••• · by you after waiting 10sok')
})

test("a subagent's turn inside the reader's is not the reader's: keep-warm is scheduled once, at the main turn's end", { options: { keepWarmDefault: true } }, async ($, on) => {
  const clock = stubSession(on, SNAP, { ...LOCAL_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'go on', turnId: 'm1' } as never)
  // A subagent runs a turn of its own inside it, then the main loop replies.
  await $.turn.start({ text: 'look around', turnId: 'a1', agentId: 'agent-1' } as never)
  for await (const chunk of $.turn.step({ turnId: 'a1', index: 0, model: 'claude-opus-5-5', agentId: 'agent-1' } as never)) void chunk
  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', answer: 'Found it.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  for await (const chunk of $.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5' } as never)) void chunk
  await $.turn.complete({ turnId: 'm1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await minutes(clock, 3)
  expect(forks).toHaveLength(0)
  await minutes(clock, 1) // a minute before the cache would expire
  expect(forks).toHaveLength(1)
})

// What the band says of a press comes from its own state and the snapshot, so a reload says the same.
describe('switch now at the view', () => {
  const act = { ui: () => undefined, send: () => undefined, handoff: () => undefined, sendHeld: () => undefined, quota: () => undefined, auto: () => undefined, settings: () => undefined, press: () => undefined }
  const ui: UiState = {
    switchStep: '', confirm: '', move: null, held: '', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
    pending: [], notice: '', noticeIsError: false, busy: false, viewOverride: '', viewPhase: '', viewTurn: 0, turns: 1, dismissedSwitch: [],
    noticeLife: null, press: null, pressed: null,
  }
  const cache = { lastAt: 0, prompt: 0, read: 0, creation: 0, input: 0, ttlMs: H, lastAnswer: '', model: 'claude-opus-5-5', route: '', warmed: 0, warmStop: false }
  const STEP = { turnId: 't1', index: 0, startedAt: NOW - 60_000, contentAt: 0, generation: 3 }
  const top = (snap: Snap, extra: { step?: Record<string, unknown> | null; ui?: Partial<UiState>; bandError?: BandError | null } = {}) =>
    bandFacts({
      snap, bandError: extra.bandError ?? null, now: NOW, sess: SESSION, cache, ui: { ...ui, ...extra.ui }, models: [], working: true, settings: settingsOf({}),
      auto: { holdCold: null, keepWarm: null }, unattended: false,
      live: { step: extra.step === null ? null : { ...STEP, ...extra.step } as never, skew: 0 },
    }, act).top
  const control = (snap: Snap, extra = {}) => top(snap, extra)?.acts.map(a => a.label) ?? []
  const s1 = (snap: Snap, patch: Record<string, unknown>): Snap => ({ ...snap, sessions: { s1: { ...snap.sessions.s1!, ...patch } } })

  test('the waiting, running and hang rows offer switch to the account that would take over, and nothing else does', () => {
    const waiting = retrying(NOW, 10_000)
    const running = retrying(NOW, 45_000, { cause: { kind: 'hang', wait_ms: 135_000 }, try: 1, try_started_at: new Date(NOW - 40_000).toISOString() })
    const watch = s1(SNAP, { takeover: 'claude-k' })
    for (const snap of [waiting, running, watch]) {
      expect(control(snap)).toEqual(['switch to k•••'])
      expect(control(s1(snap, { takeover: undefined }))).toEqual([])
      // Always the account the takeover names.
      const claude = snap.providers.claude!
      const third: Snap = { ...snap, providers: { ...snap.providers, claude: { ...claude, credentials: [...claude.credentials, { ...claude.credentials[1]!, id: 'claude-m', label: 'm•••' }] } } }
      expect(control(s1(third, { takeover: 'claude-m' }))).toEqual(['switch to m•••'])
      expect(top(snap, { bandError: { kind: 'network', message: 'refused' } })?.acts.some(a => a.key === 'switch-now')).toBe(false)
    }
  })

  for (const delay of [0, 500]) {
    for (const later of [true, false]) {
      test(`content before failure discovery ${later ? 'refuses' : 'permits'} Switch now when ${later ? 'a chunk followed' : 'no chunk followed'} the failure, with a ${delay}ms clock response`, async ($, on) => {
        const t0 = NOW - 900
        const clock = mock.clock(on, { now: t0 })
        const contentClock = stepClock(() => clock.now())
        const sampled = await contentClock.count(async () => {
          await clock.advance(delay)
          return t0
        })
        let step = stepAfter({ ...STEP, startedAt: t0 }, TEXT, sampled)!
        await clock.advance(600 - delay)
        if (later) {
          step = stepAfter(step, { kind: 'text' }, contentClock.now())!
          expect(step.contentAt).toBe(t0 + 600)
        }
        await clock.advance(200)
        const snap = retrying(clock.now(), 400)
        if (later) expect(top(snap, { step })).toBeNull()
        else expect(top(snap, { step })?.title).toMatch(/^d••• returned HTTP 529/)
        await clock.advance(100)
        expect(control(snap, { step })).toEqual(later ? [] : ['switch to k•••'])
      })
    }
  }

  test("only while the step's request is surely on the bound account", () => {
    const snap = retrying(NOW, 10_000)
    // A pick of the binding answered elsewhere since a second before the step began: hidden.
    expect(control(s1(snap, { elsewhere_at: new Date(STEP.startedAt - 500).toISOString() }))).toEqual([])
    expect(control(s1(snap, { elsewhere_at: new Date(STEP.startedAt + 20_000).toISOString() }))).toEqual([])
    expect(control(s1(snap, { elsewhere_at: new Date(STEP.startedAt - 2_000).toISOString() }))).toEqual(['switch to k•••'])
    // The session moved since the step began (a switch of the reader's, any move): hidden.
    expect(control(s1(snap, { generation: 4 }))).toEqual([])
    expect(control(snap, { step: { generation: undefined } })).toEqual([])
    // A press under way: hidden.
    const press = { id: 'c1', turnId: 't1', index: 0, startedAt: STEP.startedAt, generation: 3, to: 'claude-k', label: 'k•••', stage: 'sending', sentAt: NOW, abortAt: 0, switchAt: '', since: false } as const
    expect(top(snap, { ui: { press } })?.title).toBe('Switch to k•••…')
    expect(top(snap, { ui: { press: { ...press, stage: 'stopping', abortAt: NOW - 5_000 } } })?.title).toBe("Switched to k•••; the turn's stop is not confirmed yet")
  })

  test('after a reload the note reads as the band saw the press: stopped, how to go on until a turn starts', () => {
    const at = new Date(NOW - 30_000).toISOString()
    const moved = s1(SNAP, {
      auth_id: 'claude-k', retry: undefined,
      last_switch: { from: 'claude-d', to: 'claude-k', at, reason: 'switched by user', kind: 'user', cause: { kind: 'hang', wait_ms: 135_000, retries: 1, waited_ms: 175_000 } },
    })
    const idle = (pressed: UiState['pressed']) => top(moved, { step: null, ui: { pressed } })
    expect(idle({ at, stopped: true, since: false })).toMatchObject({ title: 'Switched d••• → k••• · by you after waiting 2m 55s; send a message to go on', short: 'Switched d••• → k••• · send a message to go on' })
    expect(idle({ at, stopped: true, since: true })).toMatchObject({ title: 'Switched d••• → k••• · by you after waiting 2m 55s', short: 'Switched d••• → k••• · by you' })
    expect(idle({ at, stopped: false, since: false })?.title).toBe('Switched d••• → k••• · by you after waiting 2m 55s')
    expect(idle(null)?.title).toBe('Switched d••• → k••• · by you after waiting 2m 55s')
    expect(idle({ at, stopped: true, since: false })?.acts).toEqual([]) // ok alone, never switch back
  })
})

test('every row of a press fits one line at 80 columns, on the terminal and in the desktop app, whatever the label', async ($, on) => {
  const steps = heldSteps(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  steps.usage = promptOf(160)
  await reply($)
  for (const label of ['kuan•••12', 'kuan•••100']) {
    const creds = SNAP.providers.claude!.credentials.map(c => (c.id === 'claude-k' ? { ...c, label } : c))
    const named = (snap: Snap): Snap => ({ ...snap, providers: { ...snap.providers, claude: { ...snap.providers.claude!, credentials: creds } } })
    const step = await holdStep($, `f-${label}`, NO_CONTENT, steps)
    stampReads = true
    snapshot = { ...named(retrying(clock.now() + 10_000, 5_000)), sequence: snapshot.sequence + 1 }
    await clock.advance(10_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(80, true) })
      const cap = surface === 'terminal' ? 's' : 'S'
      expect((await ui.find({ key: 'alert' }))?.text, `${label} ${surface}`).toMatch(new RegExp(`^!? ?d••• returned HTTP 529 · retrying in \\d+s${cap}witch to ${label}$`))
      await ui.press({ key: 'switch-now' })
      expect((await ui.find({ key: 'ask' }))?.text, `${label} ${surface}`).toMatch(new RegExp(`^\\?? ?Switch to ${label}\\? Stops turn; cold${cap}witch now(K|k)eep waiting$`))
      await ui.press({ key: 'keep-waiting' })
      await ui.unmount()
    }
    // The terminal's row, whose width it counts: within 80 columns, its controls included.
    const short = `Switch to ${label}? Stops turn; cold`
    expect(4 + 2 + short.length + 2 + 'switch now'.length + 2 + 'keep waiting'.length + 2, label).toBeLessThanOrEqual(80)
    await step.return(undefined as never)
    await $.turn.complete({ turnId: `f-${label}`, answer: '', durationMs: 1, isAborted: false, reason: 'error' } as never)
  }
})

// ---- what came of a press goes by itself, and never hides a warning ----

/** Switches the session to k••• from the menu on the drawn band. */
const switchToK = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  await ui.press({ key: 'switch' })
  await ui.press({ key: 'to-claude-k' })
  await ui.unmount()
}

/** The proxy applied the band's last command; the snapshot says nothing else new. */
const applied = (clock: MockClock) => {
  const at = new Date(clock.now()).toISOString()
  snapshot = { ...snapshot, sequence: snapshot.sequence + 1, acks: [...snapshot.acks, { command_id: commands[commands.length - 1]!.command_id!, session: 's1', status: 'applied', at }] }
}

/** The session's account read as used up: it moves to k••• once d••• refuses. */
const USED_UP: Snap = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, switch_imminent: true, switch_reason: 'weekly quota used up', next_auth_id: 'claude-k' } } }
const USED_UP_ROW = '! weekly quota used up on d••• · moves to k••• (7% used) once d••• stops answering '

test('a switch that worked says so for 5 s and goes without a press; a command on its way has no ok', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await switchToK($)
  // On its way: nothing to dismiss yet.
  expect(await rowText($, 'notice')).toBe('· Switch to k•••… ')
  applied(clock)
  await clock.advance(10_000)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(4_000)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(1_000)
  expect(await rowText($, 'notice')).toBe('')
})

test('a done notice keeps its full 5 s after a /band answer delayed by 2 s', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await switchToK($)
  applied(clock)
  let release: (reply: OpEventResult<'http.fetch'>) => void = () => undefined
  failure = new Promise<OpEventResult<'http.fetch'>>(resolve => { release = resolve })
  await clock.advance(10_000)
  await clock.advance(2_000)
  failure = undefined
  release({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(snapshot) } })
  await clock.settle()
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(4_999)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(1)
  expect(await rowText($, 'notice')).toBe('')
})

test('a done notice restored one second after acknowledgement expires at five seconds without another read', async ($, on) => {
  const clock = stubSession(on, SNAP)
  const text = 'Switch to k•••: done'
  const stored: UiState = {
    switchStep: '', confirm: '', move: null, held: '', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
    pending: [], notice: text, noticeIsError: false, busy: false,
    viewOverride: '', viewPhase: '', viewTurn: 0, turns: 0, dismissedSwitch: [], press: null, pressed: null,
    noticeLife: { text, short: '', until: NOW + 4_000 },
  }
  let restored = false
  on('state.get', async (_$, e, next) => {
    const r = await next(e)
    return e.plugin === 'quota-band' && e.key === 'ui' && !restored && 'value' in r
      ? { value: { value: stored, version: r.value?.version ?? 0 } }
      : r
  })
  on('state.set', (_$, e, next) => {
    if (e.plugin === 'quota-band' && e.key === 'ui') restored = true
    return next(e)
  })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const reads = bandReads
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(3_999)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(1)
  expect(await rowText($, 'notice')).toBe('')
  expect(bandReads).toBe(reads)
})

test('a done notice never covers an account read as used up, even with its 5 s left', async ($, on) => {
  const clock = stubSession(on, USED_UP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(await rowText($)).toBe(USED_UP_ROW)
  await switchToK($)
  applied(clock)
  await clock.advance(10_000)
  expect(await rowText($, 'notice')).toBe('')
  expect(await rowText($)).toBe(USED_UP_ROW)
  await clock.advance(5_000)
  expect(await rowText($, 'notice')).toBe('')
  expect(await rowText($)).toBe(USED_UP_ROW)
})

test('a done notice nobody dismissed does not cover an unreachable proxy', async ($, on) => {
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await switchToK($)
  applied(clock)
  await clock.advance(10_000)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  failure = { deny: 'connect ECONNREFUSED 127.0.0.1:8317' }
  await clock.advance(10_000)
  // The network's own words, without the host's name for the call (Claude Code 2.1.323).
  expect(await rowText($)).toBe('! cannot reach the proxy for quota data: connect ECONNREFUSED 127.0.0.1:8317 ')
})

test('a done notice nobody dismissed does not cover a waiting retry, which keeps its switch to k•••', async ($, on) => {
  const steps = heldSteps(on)
  const clock = stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await switchToK($)
  applied(clock)
  await clock.advance(10_000)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  // The next turn waits on a retry of d•••.
  const { step } = await waitingOn($, clock, steps, 'w1')
  expect(await liveText($)).toBe('! d••• returned HTTP 529 · retrying it in about 55s; k••• is next if neededswitch to k•••')
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, true) })
  expect(await ui.find({ key: 'switch-now' })).toBeDefined()
  await ui.unmount()
  await step.return(undefined as never)
})

test('a notice whose time ended is not drawn again after a /clear or a reload of the band', async ($, on) => {
  const clock = stubSession(on, SNAP)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await switchToK($)
  applied(clock)
  await clock.advance(10_000)
  expect(await rowText($, 'notice')).toBe('· Switch to k•••: doneok')
  await clock.advance(5_000)
  expect(await rowText($, 'notice')).toBe('')
  await $.session.end({ reason: 'clear', sessionId: SESSION.id } as never)
  expect(await rowText($, 'notice')).toBe('')
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(await rowText($, 'notice')).toBe('')
})

test('ok on the fallback note and on the move note, in turn: neither comes back', async ($, on) => {
  const route = { provider: 'claude', model: 'claude-opus-5-5', auto: true, from: 'claude-fable-5-2', at: iso(-60_000) }
  const clock = stubSession(on, {
    ...SNAP,
    sessions: { s1: {
      ...SNAP.sessions.s1!, model: 'claude-opus-5-5', requested_model: 'claude-fable-5-2', route, auth_id: 'claude-k', auth_label: 'k•••',
      last_switch: { from: 'claude-d', to: 'claude-k', at: iso(-5 * 60_000), reason: '', kind: 'quota', cause: { reason: 'Weekly Fable quota used up' } },
    } },
  })
  selectedModel = 'claude-fable-5-2'
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ok = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
    await ui.press({ key: 'alert-ok' })
    await ui.unmount()
  }
  expect(await rowText($)).toMatch(/^↪ fable-5-2 is used up on every account · running opus-5-5 /)
  await ok()
  expect(await rowText($)).toBe('↪ Switched d••• → k••• · d••• Weekly Fable quota used upok')
  await ok()
  expect(await rowText($)).toBe('')
  await clock.advance(10_000)
  expect(await rowText($)).toBe('')
  for (let n = 0; n < 10; n++) {
    const at = new Date(clock.now()).toISOString()
    const session = snapshot.sessions.s1!
    snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sessions: { s1: {
      ...session,
      ...(n % 2 === 0
        ? { last_switch: { ...session.last_switch!, at } }
        : { retry_outcome: { account: 'claude-k', cause: { kind: 'overloaded', status: 529 }, tries: 1, after_ms: 61_000, cache_read: 400_000, at } }),
    } } }
    await clock.advance(10_000)
    expect(await rowText($)).toMatch(n % 2 === 0 ? /^↪ Switched d•••/ : /^↪ Stayed on k•••/)
    await ok()
    expect(await rowText($)).toBe('')
  }
})

for (const representation of ['local selection', 'proxied turn'] as const) {
  for (const note of ['move', 'stayed'] as const) {
    test(`a fallback dismissal survives ${note} dismissal during a suspended route after ${representation}`, async ($, on) => {
      const route = { provider: 'claude', model: 'claude-opus-5-5', auto: true, from: 'claude-fable-5-2', at: iso(-60_000) }
      const session: Snap['sessions'][string] = {
        ...SNAP.sessions.s1!, model: route.model, requested_model: route.from, route, auth_id: 'claude-k', auth_label: 'k•••',
        ...(note === 'move'
          ? { last_switch: { from: 'claude-d', to: 'claude-k', at: iso(-60_000), reason: '', kind: 'quota', cause: { reason: 'Weekly Fable quota used up' } } }
          : { retry_outcome: { account: 'claude-k', cause: { kind: 'overloaded', status: 529 }, tries: 1, after_ms: 61_000, cache_read: 400_000, at: iso(-60_000) } }),
      }
      const clock = stubSession(on, { ...SNAP, sessions: { s1: session } })
      selectedModel = route.from
      await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
      const ok = async () => {
        const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
        await ui.press({ key: 'alert-ok' })
        await ui.unmount()
      }
      expect(await rowText($)).toMatch(/^↪ fable-5-2 is used up on every account/)
      await ok()
      selectedModel = 'claude-sonnet-5-5'
      if (representation === 'proxied turn') snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sessions: { s1: { ...session, model: selectedModel, requested_model: selectedModel, route: undefined } } }
      await clock.advance(10_000)
      expect(await rowText($)).toMatch(note === 'move' ? /^↪ Switched d•••/ : /^↪ Stayed on k•••/)
      await ok()
      selectedModel = route.from
      snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sessions: { s1: session } }
      await clock.advance(10_000)
      expect(await rowText($)).toBe('')
      const at = new Date(clock.now()).toISOString()
      snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sessions: { s1: {
        ...session, model: route.from, route: undefined,
        ...(note === 'move'
          ? { last_switch: { ...session.last_switch!, at } }
          : { retry_outcome: { ...session.retry_outcome!, at } }),
      } } }
      await clock.advance(10_000)
      await ok()
      snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sessions: { s1: session } }
      await clock.advance(10_000)
      expect(await rowText($)).toMatch(/^↪ fable-5-2 is used up on every account/)
    })
  }
}

describe('a notice and the warnings', () => {
  const act = { ui: () => undefined, send: () => undefined, handoff: () => undefined, sendHeld: () => undefined, quota: () => undefined, auto: () => undefined, settings: () => undefined, press: () => undefined }
  const HANDED = 'Handed off: the new session starts from ~/.cache/cliproxy-kit/handoff/s1.md'
  const ui: UiState = {
    switchStep: '', confirm: '', move: null, held: '', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
    pending: [], notice: HANDED, noticeIsError: false, busy: false, viewOverride: '', viewPhase: '', viewTurn: 0, turns: 1, dismissedSwitch: [],
    noticeLife: null, press: null, pressed: null,
  }
  const cache = { lastAt: 0, prompt: 0, read: 0, creation: 0, input: 0, ttlMs: H, lastAnswer: '', model: 'claude-opus-5-5', route: '', warmed: 0, warmStop: false }
  const top = (patch: Partial<UiState>, world: { snap?: Snap; bandError?: BandError; step?: { startedAt: number; contentAt: number }; cold?: true } = {}) =>
    bandFacts({
      snap: world.snap ?? SNAP, bandError: world.bandError ?? null, now: NOW, sess: SESSION, cache: world.cold ? { ...cache, prompt: 100_000, lastAt: NOW - 2 * H } : cache, ui: { ...ui, ...patch }, models: [], working: Boolean(world.step),
      settings: settingsOf({}), auto: { holdCold: null, keepWarm: null }, unattended: false, live: { step: world.step ? { turnId: 't1', index: 0, generation: 3, ...world.step } : null, skew: 0 },
    }, act).top
  const takeover: Snap = { ...SNAP, sessions: { s1: { ...SNAP.sessions.s1!, takeover: 'claude-k' } } }
  /** Each warning a notice must not cover, with how its row begins. */
  const warnings: [string, Parameters<typeof top>[1], RegExp][] = [
    ['a read error', { bandError: { kind: 'network', message: 'connect ECONNREFUSED' } }, /^cannot reach the proxy/],
    ['an HTTP error', { bandError: { kind: 'status', status: 404 } }, /quota-pilot/],
    ['an invalid snapshot', { bandError: { kind: 'body' } }, /quota data is not in a form this band reads/],
    ['a waiting retry', { snap: retrying(NOW, 10_000), step: { startedAt: NOW - 20_000, contentAt: 0 } }, /^d••• returned HTTP 529 · retrying it/],
    ['a running retry', { snap: retrying(NOW, 10_000, { try_started_at: iso(-2_000) }), step: { startedAt: NOW - 20_000, contentAt: 0 } }, /^d••• returned HTTP 529 · retrying it/],
    ["the plugin's warning", { snap: USED_UP }, /^weekly quota used up on d•••/],
    ['the hang watch', { snap: takeover, step: { startedAt: NOW - 45_000, contentAt: 0 } }, /^no answer for 45s/],
    ['a cold next turn', { cold: true }, /^Next turn starts cold/],
  ]

  test('completed notices immediately yield to every warning, even with time left', () => {
    for (const [name, world, row] of warnings) {
      for (const notice of [HANDED, 'Switch to k•••: done', 'Switch to k•••: rejected', 'Switch to k•••: no answer from the proxy; is it running?', 'Switch to k•••: the proxy restarted before confirming it']) {
        expect(top({ notice }, world)?.title, name).toMatch(row)
        expect(top({ notice, noticeLife: { text: notice, short: '', until: NOW + 5_000 } }, world)?.title, name).toMatch(row)
      }
    }
    expect(top({})).toMatchObject({ key: 'notice', title: HANDED, close: { label: 'ok' } })
    expect(top({ noticeLife: { text: HANDED, short: '', until: NOW + 1 } })).toMatchObject({ key: 'notice', title: HANDED })
    expect(top({ noticeLife: { text: HANDED, short: '', until: NOW } })).toBeNull()
  })

  test('something running or a command on its way stays on top of every warning', () => {
    const sending = { id: 'c1', text: 'Switch to k•••', boot: 'b1', at: NOW - 30_000 }
    for (const [name, world] of warnings) {
      expect(top({ busy: true }, world), name).toMatchObject({ key: 'notice', busy: true, close: undefined })
      expect(top({ notice: 'Switch to k•••…', pending: [sending] }, world), name).toMatchObject({ key: 'notice', title: 'Switch to k•••…', close: undefined })
    }
  })

  test('Switch now responses only cover a waiting retry during their 10 s life', () => {
    for (const notice of ['Could not switch to k•••: the session moved meanwhile', 'No answer from the proxy within 5s; the turn keeps waiting']) {
      const noticeLife = { text: notice, short: '', until: NOW + 10_000, press: true as const }
      for (const [name, world, row] of warnings) {
        const result = top({ notice, noticeLife }, world)
        if (name === 'a waiting retry') expect(result, name).toMatchObject({ key: 'notice', title: notice })
        else expect(result?.title, name).toMatch(row)
        expect(top({ notice, noticeLife: { ...noticeLife, until: NOW } }, world)?.title, name).toMatch(row)
      }
    }
  })
})

// ---- a read of the proxy has a deadline ----

/** Runs a main step that answers at once, unawaited: `returned` says when the band gave its result back. */
const stepOn = ($: Engine, turnId: string) => {
  const run = { returned: false, done: Promise.resolve() }
  run.done = (async () => {
    for await (const chunk of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5' } as never)) void chunk
    run.returned = true
  })()
  return run
}

test('a /band the proxy never answers gives up after 3 s: the step returns, the row says why, and the next read clears it', async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  hang = /\/band$/
  const reads = bandReads
  await $.turn.start({ text: 'go on', turnId: 'h1' } as never)
  const step = stepOn($, 'h1')
  await clock.advance(2_999)
  expect(step.returned).toBe(false) // the step waits for the band's read, up to the deadline
  await clock.advance(1)
  expect(step.returned).toBe(true)
  await step.done
  expect(await rowText($)).toBe('! cannot reach the proxy for quota data: no answer within 3s ')
  // The single flight is free: the next periodic read is made, and a good answer clears the error.
  hang = undefined
  await clock.advance(10_000)
  expect(bandReads).toBeGreaterThan(reads + 1)
  expect(await rowText($)).toBe('')
})

test('a model list the proxy never answers gives up after 3 s: the read of /band goes on, and so do later refreshes', async ($, on) => {
  const clock = stubSession(on, SNAP)
  hang = /\/v1\/models$/
  const reads = bandReads
  const started = $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  expect(bandReads).toBe(reads)
  await clock.advance(3_000)
  await started
  expect(bandReads).toBe(reads + 1)
  // The band shows quota, and the switch menu its accounts.
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
  await ui.press({ key: 'switch' })
  expect(await ui.find({ key: 'to-claude-k' })).toBeDefined()
  await ui.unmount()
  // A full refresh again, which gives up on the list the same way.
  const quota = $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  await clock.advance(3_000)
  await quota
  expect(bandReads).toBe(reads + 2)
  await clock.advance(10_000)
  expect(bandReads).toBe(reads + 3)
})

for (const [endpoint, withCommand] of [['/band', false], ['/band', true], ['/v1/models', false]] as const) {
  test(`${endpoint} has at most three open reads${withCommand ? ' including a command' : ''}, and a freed slot permits a fresh successful read`, async ($, on) => {
    const clock = stubSession(on, SNAP)
    const releases: (() => void)[] = []
    let holding = false
    let calls = 0
    let open = 0
    let peak = 0
    duringFetch = async url => {
      if (!url.endsWith(endpoint)) return
      calls++
      open++
      peak = Math.max(peak, open)
      try {
        if (holding) await new Promise<void>(resolve => { releases.push(resolve) })
      } finally {
        open--
      }
    }
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    const initial = calls
    holding = true
    if (withCommand) await switchToK($)
    for (let n = 0; n < 8; n++) {
      if (endpoint === '/band') await clock.advance(10_000)
      else {
        const quota = $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
        await clock.advance(3_000)
        await quota
      }
    }
    await clock.advance(3_000)
    expect(calls - initial).toBe(3)
    expect(open).toBe(3)
    expect(peak).toBe(3)
    if (endpoint === '/band') expect(await rowText($)).toBe('! cannot reach the proxy for quota data: no answer within 3s ')
    holding = false
    releases.shift()!()
    await clock.settle()
    expect(open).toBe(2)
    if (endpoint === '/band') await clock.advance(10_000)
    else await $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
    expect(calls - initial).toBe(4)
    expect(await rowText($)).toBe('')
    expect(open).toBe(2)
    for (const release of releases) release()
    await clock.settle()
  })
}

for (const cancellation of ['timeout', 'content', 'step end', 'turn completion', 'clear', 'resume', 'still valid'] as const) {
  test(`a refresh snapshot taken before ${cancellation} cannot revive a queued Switch now press`, async ($, on) => {
    const steps = heldSteps(on)
    const aborts = recordAborts(on)
    const clock = stubSession(on, SNAP)
    let delayModels = false
    let finishModels: () => void = () => undefined
    const heldModels = new Promise<void>(resolve => { finishModels = resolve })
    duringFetch = async url => {
      if (delayModels && url.endsWith('/v1/models')) await heldModels
    }
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    let release: (reply: OpEventResult<'http.fetch'>) => void = () => undefined
    failure = new Promise<OpEventResult<'http.fetch'>>(resolve => { release = resolve })
    await switchToK($)
    await clock.advance(3_000)
    failure = undefined
    applied(clock)
    await clock.advance(7_000)
    const { step } = await waitingOn($, clock, steps, 'queued-press')
    await pressSwitchNow($)
    expect(commands).toHaveLength(1)
    delayModels = true
    const quota = $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
    await clock.settle()
    if (cancellation === 'timeout') await clock.advance(5_000)
    else if (cancellation === 'content') {
      steps.then = [TEXT]
      expect((await step.next()).value).toEqual(TEXT)
    } else if (cancellation === 'step end') await step.return(undefined as never)
    else if (cancellation === 'turn completion') await $.turn.complete({ turnId: 'queued-press', answer: '', durationMs: 1, isAborted: false, reason: 'error' } as never)
    else if (cancellation === 'clear' || cancellation === 'resume') {
      await $.session.end({ reason: cancellation, sessionId: SESSION.id } as never)
      currentId = 's2'
    }
    release({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(snapshot) } })
    await clock.settle()
    await clock.advance(2_000)
    finishModels()
    await quota
    await clock.settle()
    expect(commands).toHaveLength(cancellation === 'still valid' ? 2 : 1)
    if (cancellation === 'still valid') expect(commands[1]).toMatchObject({ action: 'switch', auth_id: 'claude-k', waited_ms: 10_000 })
    expect(aborts).toEqual([])
    await step.return(undefined as never)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  for (const control of ['immediate', 'question', 'confirmation'] as const) {
    test(`a stale ${control} Switch now control on ${surface} cannot switch an answering step`, async ($, on) => {
      const steps = heldSteps(on)
      const aborts = recordAborts(on)
      const clock = stubSession(on, SNAP)
      let pause = false
      let announce: () => void = () => undefined
      const paused = new Promise<void>(resolve => { announce = resolve })
      let release: () => void = () => undefined
      const held = new Promise<void>(resolve => { release = resolve })
      on('state.get', async (_$, e, next) => {
        const result = await next(e)
        if (pause && e.plugin === 'quota-band' && e.key === 'live') {
          pause = false
          announce()
          await held
        }
        return result
      })
      await $.session.start({ cwd: SESSION.cwd, surface, isInteractive: true } as never)
      if (control !== 'immediate') {
        steps.usage = promptOf(160)
        await reply($)
      }
      const { step } = await waitingOn($, clock, steps, 'stale-press')
      if (control === 'confirmation') await pressSwitchNow($, surface)
      pause = true
      const mounting = $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, true) })
      await paused
      steps.then = [TEXT]
      expect((await step.next()).value).toEqual(TEXT)
      release()
      const ui = await mounting
      await ui.press({ key: 'switch-now' })
      await clock.advance(2_000)
      expect(commands).toEqual([])
      expect(aborts).toEqual([])
      expect(await ui.find({ key: 'ask' })).toBeUndefined()
      expect(await liveText($, 200, surface, 'notice')).not.toMatch(/Switch to k•••…/)
      await ui.unmount()
      await step.return(undefined as never)
    })
  }
}

for (const change of ['takeover', 'retry ended', 'binding moved', 'elsewhere', 'read error', 'watch warning'] as const) {
  test(`a queued Switch now silently drops after the band learns ${change}`, async ($, on) => {
    const steps = heldSteps(on)
    const aborts = recordAborts(on)
    const clock = stubSession(on, SNAP)
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    let release: (reply: OpEventResult<'http.fetch'>) => void = () => undefined
    failure = new Promise<OpEventResult<'http.fetch'>>(resolve => { release = resolve })
    await switchToK($)
    await clock.advance(3_000)
    failure = undefined
    applied(clock)
    await clock.advance(7_000)
    const { step } = await waitingOn($, clock, steps, 'changed-press', change === 'watch warning' ? { retry: undefined } : {})
    if (change === 'watch warning') await clock.advance(30_000)
    await pressSwitchNow($)
    expect(commands).toHaveLength(1)
    const patch = change === 'takeover' ? { takeover: undefined }
      : change === 'retry ended' ? { retry: undefined }
        : change === 'binding moved' ? { generation: 4 }
          : change === 'elsewhere' ? { elsewhere_at: new Date(clock.now()).toISOString() }
            : change === 'watch warning' ? { switch_imminent: true, switch_reason: 'weekly quota used up', next_auth_id: 'claude-k' } : {}
    snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sessions: { s1: { ...snapshot.sessions.s1!, ...patch } } }
    if (change === 'read error') failure = { deny: 'connection closed' }
    await clock.advance(2_000)
    failure = undefined
    release({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(snapshot) } })
    await clock.settle()
    await clock.advance(60_000)
    expect(commands).toHaveLength(1)
    expect(aborts).toEqual([])
    expect(await liveText($, 200, 'terminal', 'notice')).not.toMatch(/Switch to k•••…|No answer from the proxy/)
    await step.return(undefined as never)
  })
}

for (const [pauseAt, cancellation] of [
  ['state read', 'content'],
  ['clock read', 'content'],
  ['state write', 'content'],
  ['clock read', 'step end'],
  ['clock read', 'turn completion'],
  ['clock read', 'clear'],
  ['clock read', 'resume'],
  ['clock read', 'keep waiting'],
  ['clock read', 'still valid'],
] as const) {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a Switch now enqueue paused at ${pauseAt} respects ${cancellation} on ${surface}`, async ($, on) => {
      let pause = false
      let paused = false
      let release: () => void = () => undefined
      const held = new Promise<void>(resolve => { release = resolve })
      const wait = async () => {
        pause = false
        paused = true
        await held
      }
      const steps = heldSteps(on)
      const aborts = recordAborts(on)
      const clock = stubSession(new Proxy(on, {
        apply(target, receiver, args) {
          if (args[0] === 'clock.now') {
            const handler = args[1]
            args[1] = async (...params: unknown[]) => {
              const result = await handler(...params)
              if (pause && pauseAt === 'clock read') await wait()
              return result
            }
          }
          return Reflect.apply(target, receiver, args)
        },
      }), SNAP)
      on('state.get', async (_$, e, next) => {
        const result = await next(e)
        if (pause && pauseAt === 'state read' && e.plugin === 'quota-band' && e.key === 'cache') await wait()
        return result
      })
      on('state.set', async (_$, e, next) => {
        const result = await next(e)
        if (pause && pauseAt === 'state write' && e.plugin === 'quota-band' && e.key === 'ui') await wait()
        return result
      })
      on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
      await $.session.start({ cwd: SESSION.cwd, surface, isInteractive: true } as never)
      if (cancellation === 'keep waiting') {
        steps.usage = promptOf(160)
        await reply($)
      }
      const { step } = await waitingOn($, clock, steps, 'enqueue-press')
      const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, true) })
      if (cancellation === 'keep waiting') await ui.press({ key: 'switch-now' })
      pause = true
      const pressing = ui.press({ key: 'switch-now' })
      await clock.settle()
      expect(paused).toBe(true)
      if (cancellation === 'content') {
        steps.then = [TEXT]
        expect((await step.next()).value).toEqual(TEXT)
      } else if (cancellation === 'step end') await step.return(undefined as never)
      else if (cancellation === 'turn completion') await $.turn.complete({ turnId: 'enqueue-press', answer: '', durationMs: 1, isAborted: false, reason: 'error' } as never)
      else if (cancellation === 'clear' || cancellation === 'resume') await $.session.end({ reason: cancellation, sessionId: SESSION.id } as never)
      else if (cancellation === 'keep waiting') await ui.press({ key: 'keep-waiting' })
      release()
      await pressing
      await clock.settle()
      await clock.advance(2_000)
      expect(commands).toHaveLength(cancellation === 'still valid' ? 1 : 0)
      expect(aborts).toEqual([])
      if (cancellation !== 'still valid') expect(await liveText($, 200, surface, 'notice')).not.toMatch(/Switch to k•••…/)
      await ui.unmount()
      await step.return(undefined as never)
    })
  }
}

for (const [first, second] of [['switch', 'route'], ['route', 'unroute'], ['unroute', 'switch']] as const) {
  for (const outcome of ['answered', 'failed'] as const) {
    test(`a timed-out ${first} cannot be overtaken by ${second} until its request ${outcome}, while reads and steps go on`, async ($, on) => {
      const routed: Snap = {
        ...SNAP,
        providers: { ...SNAP.providers, codex: { health: 'healthy', credentials: [
          { id: 'codex-a', auth_index: '3', label: 'a•••', order: 1, tier: 1, reason: '', sessions: 0, windows: [] },
          { id: 'codex-b', auth_index: '4', label: 'b•••', order: 2, tier: 1, reason: '', sessions: 0, windows: [] },
        ] } },
        sessions: { s1: {
          ...SNAP.sessions.s1!, provider: 'codex', model: 'gpt-6.1-sol', requested_model: 'claude-opus-5-5', auth_id: 'codex-a', auth_label: 'a•••',
          route: { provider: 'codex', model: 'gpt-6.1-sol', auto: false, at: iso(-60_000) },
        } },
      }
      const clock = stubSession(on, routed)
      models = [{ id: 'gpt-6.1-sol', owned_by: 'openai', created: 2 }, { id: 'gpt-6-astra', owned_by: 'openai', created: 1 }]
      stepReplies(on)
      let release: (reply: OpEventResult<'http.fetch'>) => void = () => undefined
      const held = new Promise<OpEventResult<'http.fetch'>>(resolve => { release = resolve })
      await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
      const pick = async (action: typeof first | typeof second) => {
        const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
        if (action === 'unroute') await ui.press({ key: 'unroute' })
        else {
          await ui.press({ key: 'switch' })
          if (action === 'switch') await ui.press({ key: 'to-codex-b' })
          else {
            await ui.press({ key: 'prov-codex' })
            await ui.press({ key: 'model-gpt-6-astra' })
          }
        }
        await ui.unmount()
      }
      failure = held
      await pick(first)
      await clock.advance(3_000)
      expect(commands.map(c => c.action)).toEqual([first])
      failure = undefined
      await clock.advance(7_000)
      await pick(second)
      const readCount = bandReads
      await clock.advance(30_000)
      expect(bandReads).toBeGreaterThan(readCount)
      expect(commands.map(c => c.action)).toEqual([first])
      await $.turn.start({ text: 'go on', turnId: 'ordered' } as never)
      const step = stepOn($, 'ordered')
      await clock.advance(3_000)
      expect(step.returned).toBe(true)
      await step.done
      release(outcome === 'failed'
        ? { deny: 'connection closed' }
        : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(snapshot) } })
      await clock.settle()
      expect(commands.map(c => c.action)).toEqual([first, second])
    })
  }
}

for (const where of [/\/v1\/models$/, /\/band$/]) {
  test(`a step that ends while a full refresh hangs on ${where.source.includes('models') ? 'the model list' : '/band'} returns within the deadline`, async ($, on) => {
    const clock = stubSession(on, SNAP)
    stepReplies(on)
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    hang = where
    const quota = $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
    await clock.settle()
    await $.turn.start({ text: 'go on', turnId: 'h1' } as never)
    const step = stepOn($, 'h1')
    await clock.advance(3_000)
    expect(step.returned).toBe(true)
    await step.done
    hang = undefined
    await clock.advance(3_000)
    await quota
  })
}

test('chunks within a second of each other cost one write of the step, and no host call after it', async ($, on) => {
  // The step's state read and written, counted where the host answers them (the mock clock owns `clock.now`).
  const calls = { get: 0, set: 0 }
  const marks: (typeof calls)[] = []
  let clock: MockClock | undefined
  on('turn.step', async function* (_$, e) {
    yield TEXT as never
    marks.push({ ...calls })
    for (let n = 0; n < 20; n++) yield { kind: 'text', index: 0, text: ` ${n}` } as never
    marks.push({ ...calls })
    await clock!.advance(1_000)
    yield { kind: 'text', index: 0, text: ' a second later' } as never
    marks.push({ ...calls })
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: WARM_STEP } as never
  })
  clock = stubSession(on, SNAP)
  on('state.get', (_$, e, next) => {
    if ((e as { key?: string }).key === 'live') calls.get++
    return next(e)
  })
  on('state.set', (_$, e, next) => {
    if ((e as { key?: string }).key === 'live') calls.set++
    return next(e)
  })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'go on', turnId: 'c1' } as never)
  for await (const chunk of $.turn.step({ turnId: 'c1', index: 0, model: 'claude-opus-5-5' } as never)) void chunk
  const [first, within, later] = marks as [typeof calls, typeof calls, typeof calls]
  expect(first.get).toBeGreaterThan(0)
  expect(first.set).toBeGreaterThan(0)
  expect(within).toEqual(first)
  expect(later).toEqual({ get: within.get + 1, set: within.set + 1 })
})

// ---- a session's details go only to a proxy that answered as quota-pilot ----

const DEVICE_ENV = { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }
const ABOUT = ['X-Band-Title', 'X-Band-Cwd', 'X-Band-Root', 'X-Band-Repo']
/** Whether a read carried any of the session's title, folder, repository root or remote. */
const toldAbout = (headers: Record<string, string>) => ABOUT.some(h => h in headers)
/** The shell the band runs over a transcript for its title. */
const shells = () => runs.filter(argv => argv[0] === 'sh')

test('the first read of a base URL carries the key, the session and the model; after a snapshot, the next carries the rest', async ($, on) => {
  const clock = stubSession(on, SNAP, DEVICE_ENV)
  on('classic.SessionStart', () => ({}))
  repo = { root: '/Users/me/Documents/developer', remote: 'git@github.com:me/jesse.git', internal: false }
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await $.classic.SessionStart({ session_id: SESSION.id, transcript_path: '/Users/me/.claude/projects/p/s1.jsonl', source: 'resume' })
  expect(reads).toEqual([{ Authorization: 'Bearer sk-device', 'X-Band-Session': 's1', 'X-Band-Model': 'opus%5B1m%5D' }])
  expect(shells()).toEqual([])
  await clock.advance(10_000)
  expect(reads[1]).toEqual({
    Authorization: 'Bearer sk-device',
    'X-Band-Session': 's1',
    'X-Band-Model': 'opus%5B1m%5D',
    'X-Band-Title': 'Fix%20the%20%22login%22%20page',
    'X-Band-Cwd': '%2FUsers%2Fme%2FDocuments%2Fdeveloper%2Fjesse',
    'X-Band-Root': '%2FUsers%2Fme%2FDocuments%2Fdeveloper',
    'X-Band-Repo': 'github.com%2Fme%2Fjesse',
  })
})

for (const [name, answer] of [
  ['401', { value: { status: 401, ok: false, headers: {}, text: '{"error":"invalid api key"}' } }],
  ['404', { value: { status: 404, ok: false, headers: {}, text: 'not found' } }],
  ['a page that is not a snapshot', { value: { status: 200, ok: true, headers: {}, text: '<html>a gateway</html>' } }],
  ['JSON that is not a snapshot', { value: { status: 200, ok: true, headers: {}, text: '{"object":"list","data":[]}' } }],
] as const) {
  test(`a base URL that answers ${name} never receives the session's title, folder or repository, and no shell reads the transcript`, async ($, on) => {
    const clock = stubSession(on, SNAP, DEVICE_ENV)
    on('classic.SessionStart', () => ({}))
    on('classic.UserPromptSubmit', () => ({}))
    repo = { root: '/Users/me/Documents/developer', remote: 'git@github.com:me/jesse.git', internal: false }
    failure = answer as OpEventResult<'http.fetch'>
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    await $.classic.SessionStart({ session_id: SESSION.id, transcript_path: '/Users/me/.claude/projects/p/s1.jsonl', source: 'resume' })
    await $.classic.UserPromptSubmit({ session_id: SESSION.id, prompt: 'hi', session_title: 'Login revamp' })
    await clock.advance(3 * 60_000)
    expect(reads.length).toBeGreaterThan(10)
    expect(reads.filter(toldAbout)).toEqual([])
    expect(reads.every(h => h['X-Band-Session'] === 's1' && h['X-Band-Model'] === 'opus%5B1m%5D')).toBe(true)
    expect(shells()).toEqual([])
  })
}

test('a change of base URL in a running session starts over', async ($, on) => {
  const env = { ...DEVICE_ENV }
  const clock = stubSession(on, SNAP, env)
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await $.classic.UserPromptSubmit({ session_id: SESSION.id, prompt: 'hi', session_title: 'Login revamp' })
  await clock.advance(10_000)
  expect(reads.map(toldAbout)).toEqual([false, true])
  // Claude Code pointed at another gateway, which answers no snapshot: it is told nothing.
  env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
  failure = { value: { status: 404, ok: false, headers: {}, text: '' } }
  await clock.advance(30_000)
  expect(sentTo).toBe('https://gateway.example.com/v0/resource/plugins/quota-pilot/band')
  expect(reads.slice(2).map(toldAbout)).toEqual([false, false, false])
  // Once it answers with a snapshot, the next read carries them.
  failure = undefined
  await clock.advance(20_000)
  expect(reads.slice(5).map(toldAbout)).toEqual([false, true])
})

// ---- next up names an account that can take the session's model ----

test("the Accounts tile's next up and the switch menu name the same accounts, with the same week", async ($, on) => {
  const [d, k] = SNAP.providers.claude!.credentials as [SnapCred, SnapCred]
  const fableWeek = (remaining: number) => ({ kind: '7d_fable', label: 'Weekly Fable', remaining, reset_at: iso(50 * H), observed_at: iso(-60_000), stale: false })
  // A Fable session: k•••'s Fable week is used up (its plain week at 7%), x•••'s at 60%.
  const snap: Snap = {
    ...SNAP,
    providers: { claude: { ...SNAP.providers.claude!, credentials: [
      d,
      { ...k, windows: [...k.windows, fableWeek(0)] },
      { ...k, id: 'claude-x', auth_index: '3', label: 'x•••', order: 3, windows: [...k.windows, fableWeek(0.4)] },
    ] } },
    sessions: { s1: { ...SNAP.sessions.s1!, model: 'claude-fable-5-2', blocked: ['claude-k'] } },
  }
  stubSession(on, snap)
  selectedModel = 'claude-fable-5-2'
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: x••• 60% used/ })).toBeDefined()
  expect(await ui.find({ text: /next up: k•••/ })).toBeUndefined()
  await ui.press({ key: 'switch' })
  expect((await ui.find({ key: 'to-claude-x' }))?.text).toMatch(/x••• 60% used/)
  expect(await ui.find({ key: 'to-claude-k' })).toBeUndefined()
  expect(await ui.find({ text: /^k••• Weekly Fable used up, back in 2d 2h$/ })).toBeDefined()
  await ui.unmount()
})

// ---- Switch now reads one answer to "has the reply produced content since the failure" ----

for (const later of [true, false]) {
  test(`an applied in-flight press ${later ? 'keeps answering after content within the quiet second' : 'stops a waiting turn after a delayed acknowledgement'}`, async ($, on) => {
    const steps = heldSteps(on)
    const aborts = recordAborts(on)
    const clock = stubSession(on, SNAP)
    on('ui.open', () => ({ value: undefined }) as never)
    stampReads = true
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    const step = await holdStep($, 'before-ack', TEXT, steps)
    const t0 = clock.now()
    steps.then = [{ kind: 'text', index: 0, text: ' more' }]
    await clock.advance(500)
    snapshot = retrying(t0 + 500, 100)
    await $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => { release = resolve })
    duringFetch = async url => {
      if (url.endsWith('/band') && sent['X-Band-Command']) await held
    }
    const pressing = pressSwitchNow($)
    await clock.settle()
    expect(commands.filter(c => c.action === 'switch')).toHaveLength(1)
    await clock.advance(later ? 100 : 600)
    if (later) expect((await step.next()).value).toEqual(steps.then[0])
    acknowledge(clock, 'applied')
    release()
    await pressing
    await clock.settle()
    expect(aborts).toEqual(later ? [] : ['before-ack'])
    if (later) {
      expect(await liveText($, 200, 'terminal', 'notice')).toBe('')
      expect(await liveText($)).toBe('↪ Switched d••• → k••• · by you after waiting 1sok')
    }
    await step.return(undefined as never)
    if (!later) await $.turn.complete(aborted('before-ack'))
  })
}

for (const [name, later, sent] of [
  ['content that came after the band knew of the failure refuses the press, though its second was not sampled', true, false],
  ['with no content after the failure the press goes', false, true],
] as const) {
  test(name, async ($, on) => {
    const steps = heldSteps(on)
    const clock = stubSession(on, SNAP)
    stampReads = true
    await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
    // T+0: the main reply's content, counted.
    const step = await holdStep($, 'r18', TEXT, steps)
    const t0 = clock.now()
    steps.then = [{ kind: 'text', index: 0, text: ' more' }]
    // T+400: a request of the session fails; the T+500 read says so, and Switch now is offered.
    snapshot = retrying(t0 + 500, 100)
    await clock.advance(500)
    await $.command.run({ command: 'quota', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
    expect(await liveText($)).toMatch(/switch to k•••$/)
    if (later) {
      // T+600: more content, within the second after the counted one: no host call samples it.
      await clock.advance(100)
      expect((await step.next()).value).toEqual({ kind: 'text', index: 0, text: ' more' })
      await clock.advance(200)
    } else {
      await clock.advance(300)
    }
    // T+800: the press.
    await pressSwitchNow($)
    expect(commands.filter(c => c.action === 'switch')).toHaveLength(sent ? 1 : 0)
    if (later) {
      // When the second ends the row is gone too.
      await clock.advance(300)
      expect(await liveText($)).toBe('')
    }
    await step.return(undefined as never)
  })
}
