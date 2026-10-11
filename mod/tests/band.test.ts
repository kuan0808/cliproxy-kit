import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, OpEventResult, RenderElement, RenderInput } from 'claude-code'
import type { Engine, FoundElement, MockClock } from 'claude-code/testing'

import type { SessionInfo, Snap } from '../types'

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
  files = {}
  submitted = []
  filled = []
  on('session.id', () => ({ value: currentId }))
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

// Hours of the band's 10-second refreshes, simulated.
test('a cold turn is told before it is sent: why, how much it rewrites, and what it costs', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = stubSession(on, SNAP)
  stepReplies(on)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  await reply($)
  expect(await rowText($)).toBe('')
  // Past the hour the cache keeps, kept warm or not: the next turn writes it all again.
  forkReply = { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  await minutes(clock, 70)
  expect(await rowText($)).toMatch(/^! Next turn starts cold: cache expired 10m ago; it rewrites 412k tokens, ≈\$3\.30 at API prices \(\$0\.08 warm\)\s*hand off\s*ok$/)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(200, false) })
  await ui.press({ key: 'cold-ok' })
  expect(await ui.find({ key: 'alert' })).toBeUndefined() // dismissed for this cold spell
  await ui.unmount()
})

// Hours of the band's 10-second refreshes, simulated.
test('a message that would start cold waits in the prompt; Enter again sends it', { timeoutMs: 30_000 }, async ($, on) => {
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

test('a move the reader did not choose is told, and its next message waits', { timeoutMs: 30_000 }, async ($, on) => {
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

test('the cache is kept warm shortly before it expires, as many times as set, until the next prompt', { timeoutMs: 30_000 }, async ($, on) => {
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

test('a refresh that finds the cache gone stops keeping it warm', { timeoutMs: 30_000 }, async ($, on) => {
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

test('a resumed conversation whose cache expired is held on its first message', async ($, on) => {
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

test('send sends the held message, also from a box that reads empty', { timeoutMs: 30_000 }, async ($, on) => {
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
