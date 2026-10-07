import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, OpEventResult, RenderElement, RenderInput } from 'claude-code'
import type { FoundElement, MockClock } from 'claude-code/testing'

import type { CacheInfo, SessionInfo, Snap } from '../types'

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

const WARM: CacheInfo = { lastAt: NOW - 8 * 60_000, prompt: 412_000, read: 400_000, creation: 12_000, input: 10, ttlMs: H, lastAnswer: '' }

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
  on('session.id', () => ({ value: SESSION.id }))
  on('session.model', () => ({ value: SESSION.model }))
  on('session.cwd', () => ({ value: SESSION.cwd }))
  on('session.usage', () => ({
    value: { startedAt: NOW - H, context: { tokens: contextTokens, window: 1_000_000, percent: contextTokens / 10_000 }, rateLimits: [], cost: { usd: 4.2 } },
  }))
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

test('band draws the four cards from the snapshot, then asks before compacting', async ($, on) => {
  stubSession(on, SNAP)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...BAND(160, false) })
    expect(await ui.find({ text: /d•••/ })).toBeDefined()
    expect(await ui.find({ text: /Accounts/ })).toBeDefined()
    expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
    expect(await ui.find({ text: /^Max 20x$/ })).toBeDefined() // the plan, not the routing reason
    expect(await ui.find({ text: /^opus-5-5 1M$/ })).toBeDefined()
    expect(await ui.find({ key: 'quota' })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeUndefined() // cache unknown before a reply
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
