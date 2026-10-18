import { describe, expect, mock, test as kitTest } from 'claude-code/testing'
import type { EngineInterface, On, OpEventResult, RenderElement, RenderInput } from 'claude-code'
import type { Engine, FoundElement, MockClock, TestBody, TestOptions } from 'claude-code/testing'

/**
 * Every test may take a while on a loaded machine: the band refreshes on a 10-second clock, which
 * some tests run for hours. One that runs 6 seconds idle took 25 under a load average near 600.
 */
const test = (name: string, a: TestOptions | TestBody, b?: TestBody) =>
  typeof a === 'function' ? kitTest(name, { timeoutMs: 120_000 }, a) : kitTest(name, { timeoutMs: 120_000, ...a }, b!)

import type { SessionInfo, Snap, SnapSwitch, UiState } from '../types'
import { settingsOf, stepAfter } from '../hooks/logic'
import { bandFacts } from '../hooks/view'
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

const BAND = (bodyColumns: number, isWorking: boolean, maxRows = 20) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows }, view: {} },
})

/** Answer every call the band makes at session start, as Claude Code and the proxy would. */
const LOCAL_ENV = { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'sk-local', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }

/** The transcript's titles, as grep finds them: a rename wins over Claude Code's title. */
const TITLED = '"aiTitle":"Login page"\n"customTitle":"Fix the \\"login\\" page"\n"aiTitle":"Later title"\n'
/** What the band's read of its transcript finds; a test sets it after `stubSession`. */
let transcript = TITLED
/** What the proxy's /band answers; a test sets it after `stubSession`. */
let snapshot: Snap
/** When set, how /band fails instead: refused, or not reached. */
let failure: OpEventResult<'http.fetch'> | undefined
/** How many times the band read /band. */
let bandReads = 0
/** The proxy's model list. */
let models: { id: string; owned_by: string; created: number }[]
/** The URL and headers of the band's last read of /band, and every command its reads carried. */
let sentTo = ''
let sent: Record<string, string> = {}
let commands: Record<string, string>[] = []
/** The session's root and repository, as Claude Code reports them. */
let root: string
let repo: unknown
/** The session's id, which a `/clear` changes, and the rate limits Claude Code reports for a direct login. */
let currentId = SESSION.id
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
  mock.env(on, env)
  const clock = mock.clock(on, { now: NOW })
  transcript = TITLED
  snapshot = snap
  failure = undefined
  models = []
  sentTo = ''
  sent = {}
  commands = []
  root = SESSION.cwd
  repo = null
  currentId = SESSION.id
  limits = []
  forkReply = FORK_OK
  forks = []
  duringFork = undefined
  duringStep = undefined
  duringId = undefined
  duringSurfaces = undefined
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
  on('session.model', () => ({ value: SESSION.model }))
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
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'date' ? '+0800\n'
        : e.argv[0] === 'sh' ? transcript
          : e.argv.includes('branch') ? 'main\n' : ' M a\n M b\n M c\n',
      stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  const ok = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', (_$, e) => {
    if (!e.url.endsWith('/band')) return ok({ data: models })
    bandReads++
    sentTo = e.url
    sent = { ...(e.init?.headers as Record<string, string> | undefined) }
    if (sent['X-Band-Command']) commands.push(JSON.parse(decodeURIComponent(sent['X-Band-Command'])))
    return failure ?? ok(snapshot)
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
  const pane = await $.ui.mount({
    plugin: 'quota-band', surface: 'terminal', component: 'Pane', requestId: 'quota',
    props: { title: 'Accounts and quota', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  expect(await pane.find({ text: /^not reported yet$/ })).toBeDefined() // d••• has not said a Fable window
  // A limit no account reports, one says it has not: its row is there to say so.
  expect(await pane.find({ text: /^Weekly Opus$/ })).toBeDefined()
  expect(await pane.find({ text: /^no such limit$/ })).toBeDefined()
  expect(await pane.find({ text: /^this session$/ })).toBeDefined()
  expect(await pane.find({ text: /^use gpt-6-sol \(Codex\)$/ })).toBeDefined()
  expect(await pane.find({ text: /^off$/ })).toBeDefined()
  await pane.unmount()
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
  expect((await ui.find({ key: 'ask' }))?.text).toMatch(/Switch to k•••\?: The next turn then starts cold: it rewrites 412k tokens, ≈\$3\.30/)
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
    pending: [], notice: '', noticeIsError: false, busy: false, viewOverride: '', viewPhase: '', viewTurn: 0, turns: 1, dismissedSwitch: '',
  }
  const input = (holdColdDefault: boolean) => ({
    snap: SNAP, bandError: null, now: NOW, sess: SESSION, cache, ui, models: [], working: false,
    settings: settingsOf({ holdColdDefault }), auto: { holdCold: null, keepWarm: null }, unattended: false, live: { step: null, skew: 0 },
  })
  const act = { ui: () => undefined, send: () => undefined, handoff: () => undefined, sendHeld: () => undefined, quota: () => undefined, auto: () => undefined, settings: () => undefined }
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

/** The row while Claude works, at `cols` columns. */
const liveText = async ($: Engine, cols = 200, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(cols, true) })
  const row = await ui.find({ key: 'alert' })
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
  const act = { ui: () => undefined, send: () => undefined, handoff: () => undefined, sendHeld: () => undefined, quota: () => undefined, auto: () => undefined, settings: () => undefined }
  const ui: UiState = {
    switchStep: '', confirm: '', move: null, held: '', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
    pending: [], notice: '', noticeIsError: false, busy: false, viewOverride: '', viewPhase: '', viewTurn: 0, turns: 1, dismissedSwitch: '',
  }
  const cache = { lastAt: NOW - 60_000, prompt: 160_000, read: 150_000, creation: 10_000, input: 10, ttlMs: H, lastAnswer: '', model: 'claude-opus-5-5', route: '', warmed: 0, warmStop: false }
  /** The row at band time NOW, the band's clock `skew` ahead of the proxy's, its step as given. */
  const row = (snap: Snap, step: { startedAt: number; contentAt: number } | null, skew = 0) =>
    bandFacts({
      snap, bandError: null, now: NOW, sess: SESSION, cache, ui, models: [], working: true, settings: settingsOf({}),
      auto: { holdCold: null, keepWarm: null }, unattended: false, live: { step: step && { turnId: 't1', index: 0, ...step }, skew },
    }, act).top
  const proxy = (skew: number) => NOW - skew

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

// Every live row and note in the wording table reads as the shared fixture says, and fits one line
// at 80 columns (a 79-column row: padding, the mark, its words, and the control `switch to k•••`
// that ticket 06 puts on the live rows, or `ok` on a note).
test('the wording table reads as the shared fixture, and each row fits 80 columns', () => {
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    const words = (W[r.row] as (...a: unknown[]) => { text: string; short?: string })(...r.args.map(a => (a === null ? undefined : a)))
    expect(words.text, r.name).toBe(r.text)
    expect(words.short, r.name).toBe(r.short)
    const control = r.row === 'kept' ? 'ok' : r.row === 'movesNext' ? '' : 'switch to k•••'
    const fits = (t: string) => 4 + 2 + t.length + (control ? 2 + control.length + 2 : 2) <= 79
    expect(fits(words.text) || fits(words.short ?? ''), `${r.name} at 80 columns`).toBe(true)
    expect(4 + 2 + words.text.length + 2 + control.length + 2 <= 159, `${r.name} at 160 columns`).toBe(true)
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
  const waiting = 'd••• returned HTTP 529 · retrying it in about 55s; k••• is next if needed'
  expect(await drawn()).toEqual([`! ${waiting}`, '! d••• returned HTTP 529 · retrying in 55s', waiting, waiting])
  // The try runs: the running row, counting.
  snapshot = { ...retrying(clock.now() + 2_000, 7_000, { cause: { kind: 'hang', wait_ms: 135_000 }, try: 1, try_started_at: new Date(clock.now() - 4_000).toISOString() }), sequence: 9 }
  await clock.advance(2_000)
  const running = 'd••• hung for 2m 15s · retrying it, 6s so far; k••• is next if needed'
  expect(await drawn()).toEqual([`! ${running}`, `! ${running}`, running, running])
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
  const watch = 'no answer for 32s · if it fails, a retry or another account takes over'
  expect(await drawn()).toEqual([`! ${watch}`, `! ${watch}`, watch, watch])
  await step.next()
  expect(await drawn()).toEqual(['', '', '', ''])
})
