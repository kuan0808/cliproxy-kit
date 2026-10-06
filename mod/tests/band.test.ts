import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

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
  proxied: true, remote: false, home: '/Users/me',
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
/** Whether the plugin's snapshot file is on this machine; a test sets it after `stubSession`. */
let snapshotHere = true
/** Whether that file reads as a snapshot; a test sets it after `stubSession`. */
let snapshotReadable = true

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
  snapshotHere = true
  snapshotReadable = true
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
  on('fs.read', () => {
    if (!snapshotHere) throw new Error('ENOENT: no snapshot file')
    return { value: snapshotReadable ? JSON.stringify(snap) : '{"cut short' }
  })
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

test('band shows the stale-data warning when the proxy stopped writing', async ($, on) => {
  stubSession(on, { ...SNAP, generated_at: iso(-10 * 60_000) })
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /quota data is 10m old/ })).toBeDefined()
  await ui.unmount()
})

test('band on another device reads the snapshot over the network and hides host-only controls', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  let asked = ''
  let said: Record<string, string> = {}
  on('http.fetch', (_$, e) => {
    const { Authorization, ...rest } = (e.init?.headers ?? {}) as Record<string, string>
    asked = `${e.url} ${Authorization ?? ''}`
    said = rest
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SNAP) } }
  })
  // No settings hook beneath; the session started in jesse, then /cd moved its root elsewhere.
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  let root = '/Users/me/Documents/developer/jesse'
  on('session.root', () => ({ value: root }))
  on('session.repo', () => ({ value: { root: '/Users/me/Documents/developer', remote: null, internal: false } as never }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(asked).toBe('https://mac.tailnet.ts.net:8317/v0/resource/plugins/quota-pilot/band Bearer sk-device')

  // The proxy cannot read this device's transcript: the band says what the session is, in
  // headers. Resumed, no event says a title, so the transcript's is read (a rename wins).
  await $.classic.SessionStart({ session_id: SESSION.id, transcript_path: '/Users/me/.claude/projects/p/s1.jsonl', source: 'resume' })
  root = '/Users/me/elsewhere'
  await clock.advance(10_000)
  expect(said).toEqual({
    'X-Band-Session': 's1',
    'X-Band-Title': 'Fix%20the%20%22login%22%20page',
    'X-Band-Cwd': '%2FUsers%2Fme%2FDocuments%2Fdeveloper%2Fjesse',
    'X-Band-Root': '%2FUsers%2Fme%2FDocuments%2Fdeveloper',
  })
  // A title a hook event says is the one sent, and the folder it started in stays.
  await $.classic.UserPromptSubmit({ session_id: SESSION.id, prompt: 'hi', session_title: 'Login revamp' })
  await clock.advance(10_000)
  expect(said['X-Band-Title']).toBe('Login%20revamp')
  expect(said['X-Band-Cwd']).toBe('%2FUsers%2Fme%2FDocuments%2Fdeveloper%2Fjesse')

  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
  expect(await ui.find({ key: 'switch' })).toBeUndefined()
  await ui.unmount()
})

test('band beside a proxy whose files it cannot see reads the snapshot over the network', async ($, on) => {
  // The proxy runs on this machine, but in a container or as another user: no snapshot file here.
  stubSession(on, SNAP)
  snapshotHere = false
  let asked = ''
  on('http.fetch', (_$, e) => {
    asked = e.url
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SNAP) } }
  })
  on('session.root', () => ({ value: '/Users/me/notes' }))
  on('session.repo', () => ({ value: null }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(asked).toBe('http://127.0.0.1:8317/v0/resource/plugins/quota-pilot/band')
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
  // Switching writes files the proxy cannot read, so it is offered only beside the proxy.
  expect(await ui.find({ key: 'switch' })).toBeUndefined()
  await ui.unmount()
})

test('band forgets the conversation it leaves, on a resume as on a clear', async ($, on) => {
  stubSession(on, SNAP)
  // A reply that wrote and read the prompt cache, as the engine reports it.
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'Done.', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 12_000 },
    } as never
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const cacheText = async () => {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
    const waiting = await ui.find({ text: /^waiting$/ })
    await ui.unmount()
    return waiting ? 'waiting' : 'warm'
  }
  for (const reason of ['clear', 'resume'] as const) {
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: SESSION.model } as never)) void chunk
    expect(await cacheText()).toBe('warm')
    await $.session.end({ reason, sessionId: SESSION.id } as never)
    expect(await cacheText()).toBe('waiting')
  }
})

test('band whose snapshot file cannot be read asks the proxy over the network', async ($, on) => {
  stubSession(on, SNAP)
  snapshotReadable = false
  let asked = ''
  on('http.fetch', (_$, e) => {
    if (e.url.endsWith('/band')) asked = e.url
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SNAP) } }
  })
  on('session.root', () => ({ value: '/Users/me/notes' }))
  on('session.repo', () => ({ value: null }))
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(asked).toBe('http://127.0.0.1:8317/v0/resource/plugins/quota-pilot/band')
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...BAND(160, false) })
  expect(await ui.find({ text: /next up: k••• 7% used/ })).toBeDefined()
  await ui.unmount()
})

test('band reloaded mid-session learns its transcript from the next prompt', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  let said: Record<string, string> = {}
  on('http.fetch', (_$, e) => {
    said = (e.init?.headers ?? {}) as Record<string, string>
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SNAP) } }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('session.root', () => ({ value: '/Users/me/notes' }))
  on('session.repo', () => ({ value: null }))
  // No start event: the band loaded after the session began.
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  expect(said['X-Band-Title']).toBeUndefined()
  await $.classic.UserPromptSubmit({ session_id: SESSION.id, prompt: 'hi', transcript_path: '/Users/me/.claude/projects/p/s1.jsonl' })
  await clock.advance(10_000)
  expect(said['X-Band-Title']).toBe('Fix%20the%20%22login%22%20page')
  expect(said['X-Band-Cwd']).toBe('%2FUsers%2Fme%2Fnotes')
  expect(said['X-Band-Root']).toBeUndefined()
})

test('band on another device names a session Claude Code has not titled by its first request', async ($, on) => {
  const clock = stubSession(on, SNAP, { HOME: SESSION.home, ANTHROPIC_BASE_URL: 'https://mac.tailnet.ts.net:8317', ANTHROPIC_AUTH_TOKEN: 'sk-device', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  let said: Record<string, string> = {}
  on('http.fetch', (_$, e) => {
    said = (e.init?.headers ?? {}) as Record<string, string>
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SNAP) } }
  })
  on('classic.SessionStart', () => ({}))
  on('session.root', () => ({ value: '/Users/me' }))
  on('session.repo', () => ({ value: null }))
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
  expect(said['X-Band-Title']).toBe('hi')
  // A longer request later gets the session Claude Code's title, which then names it.
  transcript = '"aiTitle":"Greeting and setup"\n' + requests
  await clock.advance(60_000)
  expect(said['X-Band-Title']).toBe('Greeting%20and%20setup')
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
            : c),
      },
    },
  }
  stubSession(on, snap)
  await $.session.start({ cwd: SESSION.cwd, surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount({
    plugin: 'quota-band', surface: 'terminal', component: 'Pane', requestId: 'quota',
    props: { title: 'Accounts and quota', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  expect(await pane.find({ text: /^not reported$/ })).toBeDefined() // d••• has no Fable window
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
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [
      { id: 'gpt-6.1-sol', owned_by: 'openai', created: 3 }, { id: 'gpt-6-astra', owned_by: 'openai', created: 1 },
      { id: 'gpt-6-sol', owned_by: 'openai', created: 2 }, { id: 'gpt-image-2', owned_by: 'openai', created: 4 },
    ] }) },
  }))
  let written = ''
  on('fs.write', (_$, e) => {
    written = e.text
    return { value: undefined }
  })
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
  expect(JSON.parse(written)).toMatchObject({ action: 'route', provider: 'codex', model: 'gpt-6.1-sol', session: 's1' })
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
