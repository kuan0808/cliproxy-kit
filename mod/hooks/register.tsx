// quota-band: the cards above the Claude Code prompt. Session, context and cache come from
// Claude Code itself; accounts, quota and routing come from the proxy's quota-pilot snapshot.
// What the band shows is decided once (view.ts) and drawn per surface: in character cells in a
// terminal (terminal.tsx), as cards in the desktop app (desktop.tsx).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Auto, BandError, CacheInfo, Live, ModelInfo, Move, Press, SessionAbout, SessionInfo, Snap, UiState } from '../types'
import { desktopBand, lengthBar } from './desktop'
import {
  C,
  DESK,
  HANDOFF_PROMPT,
  autoState,
  bandErrorText,
  cacheTtlMs,
  coldConfirmed,
  isAnthropicHost,
  movedKey,
  parseModels,
  readBand,
  repoOf,
  rewriteText,
  sessionAccount,
  settingsOf,
  settlePending,
  stepAfter,
  unattendedOf,
  warmDueAt,
  type Settings,
} from './logic'
import { accountsPart, quotaPane } from './pane'
import { cellBar, terminalBand } from './terminal'
import { PRESS_WAIT_MS, bandFacts, nextTurn, settingsRows, type BandInput, type Do, type Handoff, type SettingRow } from './view'
import { W } from './wording'

const PANE = 'quota'

const EMPTY_SESSION: SessionInfo = {
  id: '', model: '', effort: '', cwd: '',
  contextTokens: null, contextWindow: 0, rateLimits: [], proxied: false, home: '',
}
const EMPTY_ABOUT: SessionAbout = { id: '', transcript: '', eventTitle: '', fileTitle: '', fileTitleAt: 0, request: '', start: '', root: '', repo: '' }
const EMPTY_CACHE: CacheInfo = { lastAt: 0, prompt: 0, read: 0, creation: 0, input: 0, ttlMs: 0, lastAnswer: '', model: '', route: '', warmed: 0, warmStop: false }
const EMPTY_UI: UiState = {
  switchStep: '', confirm: '', move: null, held: '', coldOk: '', coldDismissed: '', handoffDismissedAt: 0, afterHandoff: null,
  pending: [], notice: '', noticeIsError: false, busy: false,
  viewOverride: '', viewPhase: '', viewTurn: 0, turns: 0, dismissedSwitch: '', noticeLife: null, press: null, pressed: null,
}

const snapA = atom({ plugin: 'quota-band', key: 'snap' } as const, null)
const bandErrorA = atom({ plugin: 'quota-band', key: 'bandError' } as const, null)
const nowA = atom({ plugin: 'quota-band', key: 'now' } as const, 0)
const sessA = atom({ plugin: 'quota-band', key: 'session' } as const, EMPTY_SESSION)
const aboutA = atom({ plugin: 'quota-band', key: 'about' } as const, EMPTY_ABOUT)
const cacheA = atom({ plugin: 'quota-band', key: 'cache' } as const, EMPTY_CACHE)
const uiA = atom({ plugin: 'quota-band', key: 'ui' } as const, EMPTY_UI)
const modelsA = atom({ plugin: 'quota-band', key: 'models' } as const, [] as ModelInfo[])
const autoA = atom({ plugin: 'quota-band', key: 'auto' } as const, { holdCold: null, keepWarm: null } as Auto)
const liveA = atom({ plugin: 'quota-band', key: 'live' } as const, { step: null, skew: 0 } as Live)

type $T = EngineInterface

/** The plugin's settings (its `userConfig`), as the module last loaded with them. */
let settings: Settings = settingsOf({})

// This session's own choice of the automatic features, and whether its launcher said nobody
// attends it. Kept here, not in `$.state`: the host wipes the plugin's state at the end of every
// `session.end`, a `/clear` included, and every read of one dispatch sees one moment, so a choice
// made meanwhile would go unseen. A module reload starts this over: `session.start` takes it back
// from the `auto` atom, which mirrors it for drawing.
const NO_CHOICE: Auto = { holdCold: null, keepWarm: null }
let mine: Auto = NO_CHOICE
let unattended = false
// Counts the changes of the session's choice to hold, so a hold that was deciding meanwhile lets
// its message go instead.
let holdGen = 0

/** Whether a feature runs in this session now. */
const isOn = (feature: keyof Auto) => autoState(feature, settings, mine, unattended).on

/** Patch the band's UI state; typed so literal fields keep their union types. */
const setUi = ($: $T, patch: Partial<UiState>) => update($, uiA, (u: UiState): UiState => ({ ...u, ...patch }))

const kitPath = (home: string, rest: string) => `${home}/.cache/cliproxy-kit/${rest}`

/**
 * What the band reads to decide what it shows: as of its last refresh for a drawing, or as of now
 * (`fresh`) for a decision that cannot wait for one.
 */
async function bandInput($: $T, working: boolean, fresh = false): Promise<BandInput> {
  const [snap, bandError, polled, sess, cache, ui, models, auto, live] = await Promise.all([
    read($, snapA), read($, bandErrorA), read($, nowA), read($, sessA), read($, cacheA), read($, uiA), read($, modelsA), read($, autoA), read($, liveA),
  ])
  const now = fresh ? await $.clock.now() : polled || Date.now()
  // A decision takes the session's choice from the module; a drawing, from its mirror, which it
  // subscribes to.
  return { snap, bandError, now, sess, cache, ui, models, settings, working, auto: fresh ? mine : auto, unattended, live }
}

// ---- data refresh ----

// One refresh runs at a time, so a slow one never writes over the result of a newer one, and at
// most one waits behind it, standing for every request made meanwhile (a full one if any was):
// a slow network read never builds a queue.
let running: Promise<void> | null = null
let waiting: Promise<void> | null = null
let waitingFull = false
// Commands for a proxy read over the network, each sent with the next read of /band (see
// sendCommand): plugin resources are read-only routes.
const outbox: object[] = []

function refresh($: $T, full: boolean): Promise<void> {
  if (!running) {
    running = refreshOnce($, full).catch(() => undefined).finally(() => { running = null })
    return running
  }
  waitingFull ||= full
  waiting ??= running.then(() => {
    const wanted = waitingFull
    waiting = null
    waitingFull = false
    return refresh($, wanted)
  })
  return waiting
}

async function refreshOnce($: $T, full: boolean): Promise<void> {
  const [home, base, ttl, authToken, apiKey] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('ANTHROPIC_BASE_URL'),
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    $.env.get('ANTHROPIC_AUTH_TOKEN'),
    $.env.get('ANTHROPIC_API_KEY'),
  ])
  const [id, model, usage, cwd] = await Promise.all([$.session.id(), $.session.model(), $.session.usage(), $.session.cwd()])
  // The desktop app points its sessions at Anthropic's own API, signed in to the app's account:
  // no proxy there, so the band shows that account's own limits.
  const proxied = Boolean(base) && !isAnthropicHost(base)
  const now = await $.clock.now()
  const prev = await read($, sessA)
  const next: SessionInfo = {
    ...prev,
    id, model, cwd, proxied, home: home ?? '',
    contextTokens: usage.context.tokens ?? null,
    contextWindow: usage.context.window,
    rateLimits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) await update($, sessA, () => next)
  const ttlMs = cacheTtlMs(ttl, Boolean(authToken || apiKey))
  if ((await read($, cacheA)).ttlMs !== ttlMs) await update($, cacheA, c => ({ ...c, ttlMs }))

  // Everything comes from the proxy, over the network, with the key Claude Code sends it (none for
  // a proxy without api-keys): the same wherever the proxy runs (beside it, in a container, on a
  // server).
  const token = authToken || apiKey
  if (proxied && base) {
    const url = base.replace(/\/+$/, '')
    const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    if (full) {
      try {
        const r = await $.http.fetch(`${url}/v1/models`, { headers: auth })
        const list = r.ok ? parseModels(r.text) : null
        if (list) await update($, modelsA, () => list)
      } catch {
        // The switch menu then offers accounts only.
      }
    }
    // What only this device knows of the session goes in headers, kept out of the proxy's request
    // log, with a command waiting to be sent (see sendCommand).
    const about = await learnAbout($, id, now)
    const headers: Record<string, string> = { ...auth }
    const said: [string, string][] = [
      ['X-Band-Session', id],
      ['X-Band-Model', model],
      ['X-Band-Title', about.eventTitle || about.fileTitle || about.request],
      ['X-Band-Cwd', about.start],
      ['X-Band-Root', about.root],
      ['X-Band-Repo', about.repo],
    ]
    for (const [name, value] of said) if (value) headers[name] = encodeURIComponent(value)
    const command = outbox.shift()
    if (command) headers['X-Band-Command'] = encodeURIComponent(JSON.stringify(command))
    if (outbox.length) void refresh($, false)
    let snap: Snap | null = null
    let error: BandError | null = null
    try {
      const r = await $.http.fetch(`${url}/v0/resource/plugins/quota-pilot/band`, { headers })
      ;({ snap, error } = readBand(r.status, r.text))
    } catch (err) {
      error = { kind: 'network', message: err instanceof Error ? err.message : String(err) }
    }
    // A read that fails keeps the last snapshot, which the band marks as old, beside the reason.
    const old = await read($, snapA)
    if (snap && (snap.sequence !== old?.sequence || snap.boot_id !== old?.boot_id || snap.generated_at !== old?.generated_at)) {
      await update($, snapA, () => snap)
      // How far the band's clock is ahead of the proxy's, which stamps the snapshot as it builds it:
      // the plugin's times are compared on the band's clock shifted by it, to within the read's latency.
      const skew = now - Date.parse(snap.generated_at)
      if (Number.isFinite(skew)) await update($, liveA, l => (l.skew === skew ? l : { ...l, skew }))
    }
    if (JSON.stringify(error) !== JSON.stringify(await read($, bandErrorA))) await update($, bandErrorA, () => error)
    // Every read, changed or not: a command can also expire, or its proxy be gone.
    await settle($, snap ?? old, now)
    // After this read: a command goes with the next one, which waits for this one to end.
    if (snap) void moveAfterHandoff($, id, snap, now)
  } else if (await read($, bandErrorA)) {
    await update($, bandErrorA, () => null)
  }
  await update($, nowA, () => now)
  // The mirror of the session's choice, should a /clear have wiped it unannounced.
  const shown = await read($, autoA)
  if (shown.holdCold !== mine.holdCold || shown.keepWarm !== mine.keepWarm) await update($, autoA, () => mine)
}

/**
 * What the band on another device tells the proxy of this session: the folder it started in and
 * its repository, learned once (a `/cd` later does not move the session's past), and, while no
 * hook event has said a title, the title its transcript names and its first request, read at
 * most once a minute. Only these fields are written, onto what is there now, so a hook event that
 * came meanwhile stays; an answer about a session that is no longer this one is dropped.
 */
async function learnAbout($: $T, id: string, now: number): Promise<SessionAbout> {
  const seen = await read($, aboutA)
  const known = seen.id === id ? { ...EMPTY_ABOUT, ...seen } : { ...EMPTY_ABOUT, id }
  const learned: Partial<SessionAbout> = {}
  if (!known.start) {
    const repo = await $.session.repo().catch(() => null)
    learned.start = await $.session.root()
    learned.root = repo?.root ?? ''
    learned.repo = repoOf(repo?.remote)
  }
  if (known.transcript && !known.eventTitle && now - known.fileTitleAt >= TITLE_EVERY_MS) {
    const read = await readTranscript($, known.transcript, !known.request)
    learned.fileTitle = read.title
    learned.fileTitleAt = now
    if (read.request) learned.request = read.request
  }
  if (Object.keys(learned).length === 0) return known
  await update($, aboutA, cur => {
    if (cur.id && cur.id !== id) return cur
    return { ...EMPTY_ABOUT, ...(cur.id === id ? cur : { id }), ...learned }
  })
  // Facts go out with the id they are about: when another session took over meanwhile, what was
  // learned is still this one's, but nothing the new session's events said.
  const after = await read($, aboutA)
  return after.id === id ? { ...EMPTY_ABOUT, ...after } : { ...known, ...learned }
}

/** What a hook event says of a session: its transcript, and its title when it has one. */
async function heardAbout($: $T, id: string | undefined, transcript: string | undefined, title: string | undefined) {
  if (!id) return
  await update($, aboutA, cur => {
    const base = cur.id === id ? { ...EMPTY_ABOUT, ...cur } : { ...EMPTY_ABOUT, id }
    return { ...base, transcript: transcript || base.transcript, eventTitle: title?.trim() || base.eventTitle }
  })
}

// A title changes rarely: the transcript is read for it at most once a minute.
const TITLE_EVERY_MS = 60_000
const TITLE_FIELD = '"(customTitle|aiTitle)":"([^"\\\\]|\\\\.)*"'

// The titles in a transcript's last 8 MiB, then, when $3 asks, the user records in its first
// 64 MiB, passing over one of 4 MiB or more as the proxy's own reader does.
const TRANSCRIPT_READ = [
  'tail -c 8388608 "$1" | grep -oE "$2"',
  '[ "$3" = head ] || exit 0',
  `head -c 67108864 "$1" | grep -F '"type":"user"' | awk 'length($0) < 4194304' | head -c 4194304`,
].join('\n')

/**
 * A session's title as its transcript names it, read the way the proxy reads its own machine's:
 * the user's rename, else Claude Code's latest title; and, when asked, its first request. "" for
 * what is not there yet, or on a device with no `sh` (Windows).
 */
async function readTranscript($: $T, path: string, request: boolean): Promise<{ title: string, request: string }> {
  try {
    const r = await $.process.run(['sh', '-c', TRANSCRIPT_READ, 'sh', path, TITLE_FIELD, request ? 'head' : ''])
    let custom = ''
    let ai = ''
    const records: string[] = []
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('{')) {
        records.push(line)
        continue
      }
      const m = /^"(customTitle|aiTitle)":("(?:[^"\\]|\\.)*")$/.exec(line.trim())
      if (!m) continue
      const value = String(JSON.parse(m[2] ?? '""'))
      if (m[1] === 'customTitle') custom = value
      else ai = value
    }
    return { title: custom || ai, request: request ? firstRequest(records) : '' }
  } catch {
    return { title: '', request: '' }
  }
}

/**
 * A session's first request, which names it on the proxy's Mac while Claude Code has given it no
 * title (`userPrompt` in the plugin's usage.go, the same rule): the opening line of the first text
 * a user record holds that Claude Code did not add, so no "Caveat:" note and no tagged block but
 * a <task>.
 */
function firstRequest(records: readonly string[]): string {
  for (const record of records) {
    let content: unknown
    try {
      const parsed: unknown = JSON.parse(record)
      if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'user') continue
      content = (parsed as { message?: { content?: unknown } }).message?.content
    } catch {
      continue // cut short by the read's limit
    }
    const texts = typeof content === 'string' ? [content]
      : Array.isArray(content) ? content.flatMap(p => p?.type === 'text' && typeof p.text === 'string' ? [p.text as string] : []) : []
    for (let text of texts) {
      text = text.trim()
      if (text.startsWith('Caveat:')) continue
      const tag = /^<([a-z_ -]+)>/.exec(text)
      if (tag) {
        if (tag[1] !== 'task') continue
        text = text.slice(tag[0].length).replaceAll('</task>', '')
      }
      const line = titleLine(text)
      if (line) return line
    }
  }
  return ''
}

/** One line of a title as the plugin's `cleanTitle` makes it: no invisible characters, at most 90. */
function titleLine(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\p{Cf}/gu, '').split(/\s+/).filter(Boolean).join(' ')
  const chars = [...line]
  return chars.length > 90 ? `${chars.slice(0, 89).join('')}…` : line
}

/**
 * Settle pending commands by the snapshot just read (see `settlePending`). Once none is left, a
 * route or a way back the reader chose names the account it landed on, so a later move to another
 * is told and held again.
 */
async function settle($: $T, snap: Snap | null, now: number): Promise<void> {
  await settlePress($, snap, now)
  const ui = await read($, uiA)
  if (ui.pending.length) {
    let life = 0
    await update($, uiA, (u: UiState): UiState => {
      const { left, notice } = settlePending(u.pending, snap, now)
      if (!notice) return left.length === u.pending.length ? u : { ...u, pending: left }
      life = notice.lifeMs ?? 0
      return {
        ...u, pending: left, notice: notice.text, noticeIsError: notice.isError,
        noticeLife: life ? { text: notice.text, short: notice.short ?? '', until: now + life } : null,
      }
    })
    if (life) redrawAt($, now + life)
    return
  }
  const landed = snap?.sessions[(await read($, sessA)).id]?.auth_id
  if (!landed || !(ui.coldOk.endsWith(':*') || ui.coldDismissed.endsWith(':*'))) return
  const name = (key: string) => (key.endsWith(':*') ? `${key.slice(0, -1)}${landed}` : key)
  await update($, uiA, (u: UiState): UiState => ({ ...u, coldOk: name(u.coldOk), coldDismissed: name(u.coldDismissed) }))
}

/**
 * Switch now: the acknowledgement of a press being sent. Applied, the waiting turn is stopped, with
 * one call, and the band waits for that turn's own end, however late (`endPress`); 5 s on, its row
 * says the stop is not confirmed yet. Refused, the press is over, and `settlePending` words it.
 */
async function settlePress($: $T, snap: Snap | null, now: number): Promise<void> {
  const press = (await read($, uiA)).press
  const ack = press?.stage === 'sending' ? snap?.acks.find(a => a.command_id === press.id) : undefined
  if (!press || !ack) return
  let stopping = false
  await update($, uiA, (u: UiState): UiState => {
    if (u.press?.id !== press.id || u.press.stage !== 'sending') return u
    stopping = ack.status === 'applied'
    return { ...u, press: stopping ? { ...u.press, stage: 'stopping', abortAt: now, switchAt: ack.at } : null }
  })
  if (!stopping) return
  // A hook above may answer the call and never pass it on: only the turn's end says it stopped.
  void $.turn.abort({ turnId: press.turnId }).catch(() => undefined)
  redrawAt($, now + PRESS_WAIT_MS)
}

/**
 * Switch now: sends a press's switch with how long the turn had waited and what the band saw when
 * its step began, unless the press went void meanwhile (the step answered or ended, or another
 * press is under way). It goes void too when no acknowledgement comes within 5 s.
 */
async function sendPress($: $T, op: Press): Promise<void> {
  const [sess, snap, bandError, cache, live] = await Promise.all([read($, sessA), read($, snapA), read($, bandErrorA), read($, cacheA), read($, liveA)])
  if (!snap || bandError || live.step?.turnId !== op.turnId || live.step.index !== op.index) return
  const id = crypto.randomUUID()
  const at = await $.clock.now()
  const doc = {
    command_id: id, session: sess.id, boot_id: snap.boot_id, created_at: new Date(at).toISOString(), action: 'switch', auth_id: op.to,
    waited_ms: Math.max(0, Math.round(at - op.startedAt)), generation: op.generation, step_started_at: new Date(op.startedAt - live.skew).toISOString(),
  }
  // The reader chose the cold turn this move makes, as with a switch from the menu.
  const chosen = movedKey(cache, op.to)
  let sent = false
  await update($, uiA, (u: UiState): UiState => {
    sent = !u.press || (u.press.stage === 'asking' && u.press.turnId === op.turnId && u.press.index === op.index)
    if (!sent) return u
    return {
      ...u, confirm: '', switchStep: '', move: null, coldOk: chosen, coldDismissed: chosen,
      press: { ...op, id, stage: 'sending', sentAt: at },
      pending: [...u.pending, { id, text: W.switchTo(op.label), boot: snap.boot_id, at, press: op.label }],
    }
  })
  if (!sent) return
  outbox.push(doc)
  $.clock.after(PRESS_WAIT_MS, async () => {
    const now = await $.clock.now()
    const text = W.pressUnanswered
    await update($, uiA, (u: UiState): UiState => (u.press?.id === id && u.press.stage === 'sending'
      ? { ...u, press: null, notice: text, noticeIsError: false, noticeLife: { text, short: '', until: now + 10_000 } }
      : u))
    redrawAt($, now + 10_000)
  })
  await refresh($, false)
}

/** A press asking or sending goes void, with nothing more done, at an event of its step or turn. */
async function voidPress($: $T, mine: (p: Press) => boolean): Promise<void> {
  if (!(await read($, uiA)).press) return
  await update($, uiA, (u: UiState): UiState => (u.press && u.press.stage !== 'stopping' && mine(u.press) ? { ...u, press: null } : u))
}

/**
 * The end of a main turn a press was for: one asking or sending goes void; one stopping it says
 * what came of it, `aborted` meaning the turn stopped, any other reason that it ended by itself.
 */
async function endPress($: $T, turnId: string, reason: string): Promise<void> {
  if ((await read($, uiA)).press?.turnId !== turnId) return
  await update($, uiA, (u: UiState): UiState => {
    const p = u.press
    if (p?.turnId !== turnId) return u
    if (p.stage !== 'stopping') return { ...u, press: null }
    return { ...u, press: null, pressed: { at: p.switchAt, stopped: reason === 'aborted', since: p.since } }
  })
}

/** Draws the band again at `at`, on the band's clock: a row that goes or changes by itself then. */
function redrawAt($: $T, at: number): void {
  void $.clock.now().then(now =>
    $.clock.after(Math.max(0, at - now), async () => {
      const t = await $.clock.now()
      await update($, nowA, () => t)
    }))
}

/** The account a move takes the session to, as its cold spell's key names it: `*` when the proxy picks it. */
const moveTarget = (move: Move) => (move.action === 'switch' ? move.fields.auth_id ?? '*' : '*')

/**
 * Send a command to quota-pilot with the next read of /band, for `session` (this one when not
 * given), and track it until the snapshot that read returns, or a later one, acknowledges it.
 */
async function sendCommand($: $T, move: Move, session?: string): Promise<void> {
  const [sess, snap, bandError, cache] = await Promise.all([read($, sessA), read($, snapA), read($, bandErrorA), read($, cacheA)])
  if (!snap || bandError) {
    await setUi($, { notice: bandError ? bandErrorText(bandError) : W.pluginDown, noticeIsError: true, confirm: '', move: null })
    return
  }
  // The reader chose this move, with what it costs in front of them: its cold turn is neither
  // told again nor held.
  const chosen = movedKey(cache, moveTarget(move))
  const id = crypto.randomUUID()
  const at = await $.clock.now()
  const doc = { command_id: id, session: session ?? sess.id, boot_id: snap.boot_id, created_at: new Date(at).toISOString(), action: move.action, ...move.fields }
  const pending = { id, text: move.text, boot: snap.boot_id, at }
  await update($, uiA, (u: UiState): UiState => ({
    ...u, confirm: '', switchStep: '', move: null, coldOk: chosen, coldDismissed: chosen,
    notice: W.sending(move.text), noticeIsError: false, pending: [...u.pending, pending],
  }))
  outbox.push(doc)
  await refresh($, false)
}

let moving = false

/**
 * The move a handoff left for its new session (`to`), sent for that session once the proxy has
 * seen it (it refuses a command for one it has not); dropped after ten minutes. The new session's
 * first turn, the note, is small to resend.
 */
async function moveAfterHandoff($: $T, id: string, snap: Snap, now: number): Promise<void> {
  if (moving) return
  moving = true
  try {
    const after = (await read($, uiA)).afterHandoff
    if (!after) return
    if (now - after.at > 10 * 60_000) {
      await setUi($, { afterHandoff: null })
      return
    }
    if (after.to !== id || !snap.sessions[id]) return
    await setUi($, { afterHandoff: null })
    await sendCommand($, after, after.to)
  } finally {
    moving = false
  }
}

async function setNotice($: $T, notice: string, isError: boolean): Promise<void> {
  await setUi($, { notice, noticeIsError: isError, busy: false, confirm: '' })
}

// One band action at a time, its own model call included (a handoff, sending a held message,
// keeping the cache warm): taken before anything is awaited, so a second press meanwhile does
// nothing.
let acting = false

async function exclusive(run: () => Promise<void>): Promise<boolean> {
  if (acting) return false
  acting = true
  try {
    await run()
  } finally {
    acting = false
  }
  return true
}

// What tells one conversation's events from another's: `generation` counts the conversations of
// this process (a /clear or a resume starts another), `mainTurn` is the reader's turn while it
// runs, and `working` whether Claude works, as the band was last drawn (a reload mid-turn hears
// no start). While the band's own model call runs (`forking`), a step outside the reader's turn
// is that call's.
let generation = 0
let mainTurn = ''
let working = false
let forking = false
// The turn a /clear or a resume left running: its end, heard later, is not the new conversation's.
let leftTurn = ''
const ownStep = (e: { agentId?: string; turnId: string }) =>
  Boolean(e.agentId) || e.turnId === leftTurn || (forking && (!mainTurn || e.turnId !== mainTurn))

/**
 * How handoff notes are written: the reader's own prompt when `<Claude Code's folder>/quota-band/
 * handoff-prompt.md` holds one, read at each handoff so an edit needs no reload; else the built-in
 * one. Either way the note's context (the latest reply, a held message) follows it.
 */
async function handoffPrompt($: $T, home: string): Promise<{ text: string; own: boolean }> {
  const folder = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const own = await $.fs.read(`${folder}/quota-band/handoff-prompt.md`).then(t => String(t).trim(), () => '')
  return own ? { text: own, own: true } : { text: HANDOFF_PROMPT, own: false }
}

/** A plugin's message names no file with `@`: one that does is sent from the prompt box instead. */
const mentionsFile = (text: string) => /(^|\s)@\S/.test(text)

/**
 * Hand off to a new session: Claude writes a note over this conversation (from its cache), the
 * note is saved and read back, the conversation clears, and the new one starts from the note,
 * sent at once, with the reader's held message after it. A move waits for the new session.
 */
async function handoffNow($: $T, given: Handoff = {}): Promise<void> {
  const ran = await exclusive(() => runHandoff($, given))
  // Pressed again while one runs, its row says so already; else the cache was being kept warm.
  if (!ran && !(await read($, uiA)).busy) await setUi($, { notice: W.handoffBusy, noticeIsError: true })
}

async function runHandoff($: $T, given: Handoff): Promise<void> {
  const then = { ...given }
  let handedOff = false
  let saved = ''
  try {
    const [sess, cache, before] = await Promise.all([read($, sessA), read($, cacheA), read($, uiA)])
    // The held message as the box has it now, the reader's edits included. It is kept in the
    // band's state before the box empties (as for a message sent), so a reload can give it back.
    if (given.fromBox) {
      const box = await $.prompt.read().catch(() => null)
      if (box?.text.trim()) then.held = box.text
    }
    const prompt = await handoffPrompt($, sess.home)
    await setUi($, { busy: true, confirm: '', move: null, held: then.held ?? '', notice: W.writingNote(prompt.own), noticeIsError: false })
    if (given.fromBox) await $.prompt.fill({ text: '' }).catch(() => undefined)
    const tail = cache.lastAnswer ? `\n\nYour latest reply, which may be missing from this request, was:\n${cache.lastAnswer.slice(0, 6000)}` : ''
    const next = then.held ? `\n\nThe new session gets this message from the user right after the note:\n${then.held}` : ''
    forking = true
    const r = await $.model.fork({ prompt: prompt.text + tail + next }).finally(() => { forking = false })
    if (!r.isAnswered || !r.text.trim()) {
      await setNotice($, W.noNote(r.isAnswered ? 'empty' : r.reason), true)
      return
    }
    // The session's short id and the local time: short enough to read in a notice.
    const at = new Date(await $.clock.now())
    const two = (n: number) => String(n).padStart(2, '0')
    const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
    const path = kitPath(sess.home, `handoff/${sess.id.slice(0, 8)}-${stamp}.md`)
    const shown = sess.home && path.startsWith(sess.home) ? `~${path.slice(sess.home.length)}` : path
    await $.fs.write(path, r.text)
    if ((await $.fs.read(path)) !== r.text) {
      await setNotice($, W.noteNotSaved, true)
      return
    }
    saved = shown
    // The conversation must be the one the note is about, as it was: not another (a /clear or a
    // resume meanwhile), and not one that went on while the note was written.
    const [id, after] = await Promise.all([$.session.id(), read($, uiA)])
    if (id !== sess.id || after.turns !== before.turns || mainTurn) {
      await setNotice($, W.noteKept(shown, 'changed'), true)
      return
    }
    // The /clear runs once the session is idle, and ends one conversation: two ended meanwhile
    // means another came first (a resume), and the note is not that one's. The band cannot hold
    // its own /clear back (a plugin's command passes none of its own hooks), so the checks above
    // come right before it.
    const gen = generation
    await $.command.run({ command: 'clear' })
    const fresh = await $.session.id()
    if (fresh === sess.id || generation > gen + 1) {
      await setNotice($, W.noteKept(shown, fresh === sess.id ? 'not cleared' : 'another first'), true)
      return
    }
    // From here on the note is the only copy of the context: every message names where it is.
    handedOff = true
    if (then.move) await setUi($, { afterHandoff: { ...then.move, to: fresh, at: await $.clock.now() } })
    const text = `Continue from this handoff note (saved at ${path}):\n\n${r.text.trim()}${then.held ? `\n\n---\n\n${then.held}` : ''}`
    const sent = !mentionsFile(then.held ?? '') && await $.prompt.submit({ text, asUser: true }).then(s => !s.drop, () => false)
    if (sent) {
      await setNotice($, W.handedOff(shown), false)
      return
    }
    const fill = await $.prompt.fill({ text }).catch(() => ({ isFilled: false }))
    await setNotice($, W.newSession(shown, fill.isFilled), !fill.isFilled)
  } catch (err) {
    await setNotice($, W.handoffFailed(String(err), saved), true)
  } finally {
    await giveBack($, handedOff ? undefined : then.held)
  }
}

/** A held message back into the prompt: after what the reader typed there since, if anything. */
async function giveBack($: $T, held: string | undefined): Promise<void> {
  await setUi($, { held: '' })
  if (!held) return
  const box = await $.prompt.read().catch(() => null)
  const draft = box?.text.trim() ? box.text : ''
  await $.prompt.fill(draft ? { text: `\n\n${held}`, mode: 'append' } : { text: held }).catch(() => undefined)
}

/** Send the message the guard held, as it is in the prompt now: the reader may have changed it. */
async function sendHeld($: $T): Promise<void> {
  await exclusive(async () => {
    const ui = await read($, uiA)
    // As the box has it now; a box with nothing in it (or none, as an SDK host's) sends what was
    // held. Taking it back is `cancel`.
    const box = await $.prompt.read().catch(() => null)
    const text = box?.text.trim() ? box.text : ui.held
    await setUi($, { confirm: '', held: '' })
    if (!text.trim()) return
    if (mentionsFile(text)) {
      await setUi($, { notice: W.sendFromBox, noticeIsError: false })
      return
    }
    await $.prompt.fill({ text: '' }).catch(() => undefined)
    const r = await $.prompt.submit({ text, asUser: true }).catch(() => null)
    if (!r || r.drop) {
      await giveBack($, text)
      await setNotice($, W.notSent(r?.drop), true)
    }
  })
}

// ---- keeping the cache warm ----

let warmTimer: Timer | null = null
// Counts the times the next refresh was (re)timed, so a timing that took a while never sets a
// timer after a newer one did.
let warmSeq = 0
const KEEP_WARM_PROMPT = 'This is an automatic prompt-cache refresh, not a message from the user. Reply with only the word: ok'
/** A conversation smaller than this is cheap to write again: it is not kept warm. */
const KEEP_WARM_FLOOR = 20_000

function stopWarm(): void {
  warmSeq++
  warmTimer?.cancel()
  warmTimer = null
}

/**
 * Time the next refresh of the cache: shortly before it would expire, between the reader's turns,
 * while refreshes are left for this idle stretch and the last one found the cache there.
 */
async function scheduleWarm($: $T): Promise<void> {
  stopWarm()
  const seq = warmSeq
  if (mainTurn || !isOn('keepWarm')) return
  const [cache, sess, now] = await Promise.all([read($, cacheA), read($, sessA), $.clock.now()])
  const due = warmDueAt(cache)
  if (seq !== warmSeq || !due || cache.warmStop || cache.warmed >= settings.keepWarm || cache.prompt < KEEP_WARM_FLOOR) return
  warmTimer = $.clock.after(Math.max(0, due - now), () => {
    void warmNow($, sess.id, cache.lastAt, seq).catch(() => undefined)
  })
}

/**
 * One refresh: a fork of the conversation reads its whole prefix from the cache, at the cache's
 * read price, and keeps it there for another TTL from the fork's start. Only while it is still
 * there and nothing else runs; a fork that wrote more than a sliver of it found it gone, and the
 * band stops trying until the reader's next turn.
 */
async function warmNow($: $T, id: string, at: number, seq: number): Promise<void> {
  if (seq !== warmSeq) return
  let refreshed = false
  const ran = await exclusive(async () => {
    const [cache, now] = await Promise.all([read($, cacheA), $.clock.now()])
    if (cache.lastAt !== at || mainTurn || working || (await $.session.id()) !== id) return
    if (now >= cache.lastAt + cache.ttlMs - 30_000) return
    const next = nextTurn(await bandInput($, false, true))
    // Again after the reads: a turn the reader started meanwhile keeps the cache itself, and one
    // turned off or timed anew meanwhile is not this refresh's to make.
    if (next.isCodex || next.cold || mainTurn || working || seq !== warmSeq || !isOn('keepWarm')) return
    forking = true
    const r = await $.model.fork({ prompt: KEEP_WARM_PROMPT }).catch(() => null).finally(() => { forking = false })
    if (!r || !('usage' in r)) return
    const { cache_read_input_tokens: hit, cache_creation_input_tokens: wrote } = r.usage
    if (hit + wrote <= 0) return
    const kept = hit > 0 && wrote <= hit / 10
    await update($, cacheA, c => (c.lastAt === at ? { ...c, lastAt: now, warmed: c.warmed + (kept ? 1 : 0), warmStop: !kept } : c))
    // The next one only after this one kept it; else the reader's next turn times it again.
    if (kept) refreshed = true
  })
  // Another band action held the lock (a handoff, or a refresh this one replaced): try again soon,
  // unless keeping warm was timed anew or stopped meanwhile.
  if (!ran && seq === warmSeq) {
    warmTimer = $.clock.after(5_000, () => {
      void warmNow($, id, at, seq).catch(() => undefined)
    })
    return
  }
  if (refreshed) await scheduleWarm($)
}

// ---- the session's own choice: /hold-cold and /keep-warm ----

const AUTO_COMMANDS = { holdCold: { name: 'hold-cold', words: 'Hold' }, keepWarm: { name: 'keep-warm', words: 'Keep-warm' } } as const

/** Where a feature stands in this session and why, as its command answers; `asked` when it was told to change. */
function autoText(feature: keyof Auto, asked: boolean): string {
  const { name, words } = AUTO_COMMANDS[feature]
  const state = autoState(feature, settings, mine, unattended)
  const byDefault = (feature === 'holdCold' ? settings.holdColdDefault : settings.keepWarmDefault) ? 'on' : 'off'
  if (state.why === 'unattended') return `${words}: off, this session runs unattended (QUOTA_BAND_UNATTENDED).${asked ? ' Not changed.' : ''}`
  if (state.why === 'session') return `${words}: ${state.on ? 'on' : 'off'} in this session (default ${byDefault}, set in /config).`
  const flip = state.on ? 'off' : 'on'
  return `${words}: ${byDefault} by default (set in /config). /${name} ${flip} turns it ${flip} here.`
}

/**
 * This session's choice of a feature (null: follow `/config`), kept in the module and mirrored for
 * drawing. Ignored in a session nobody attends. Holding turned off settles a held message's
 * question (the message stays in the box); keeping warm is timed again either way.
 */
async function choose($: $T, feature: keyof Auto, value: boolean | null): Promise<void> {
  if (unattended) return
  mine = { ...mine, [feature]: value }
  if (feature === 'holdCold') holdGen++
  await update($, autoA, () => mine)
  if (!isOn('holdCold')) await update($, uiA, (u: UiState): UiState => (u.confirm === 'send' ? { ...u, confirm: '', held: '' } : u))
  if (feature === 'keepWarm') await scheduleWarm($)
}

/** `/hold-cold` and `/keep-warm`: `on`, `off` or `default` for this session; bare, where it stands. */
async function autoCommand($: $T, feature: keyof Auto, args: string): Promise<{ text: string }> {
  const arg = args.trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off' && arg !== 'default') return { text: `Use /${AUTO_COMMANDS[feature].name} on, off or default.` }
  if (arg) await choose($, feature, arg === 'default' ? null : arg === 'on')
  return { text: autoText(feature, Boolean(arg)) }
}

// ---- hooks ----

/** What the band's controls do. */
function actsOf($: $T): Do {
  return {
    ui: patch => setUi($, patch),
    send: move => sendCommand($, move),
    handoff: then => handoffNow($, then),
    sendHeld: () => sendHeld($),
    quota: () => $.ui.open({ id: PANE, title: 'Accounts and quota' }),
    auto: (feature, value) => choose($, feature, value),
    settings: () => $.ui.open({ id: PANE, title: 'quota-band settings' }),
    press: op => sendPress($, op),
  }
}

const CONFIRMS: readonly UiState['confirm'][] = ['handoff', 'switch', 'move', 'send']

export const register: Register = (on, options) => {
  settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    unattended = unattendedOf(await $.env.get('QUOTA_BAND_UNATTENDED'))
    // A reload keeps the band's state: the choice made before it comes back from its mirror.
    mine = { ...NO_CHOICE, ...(await read($, autoA)) }
    // A reload keeps the band's state, perhaps an older version's, but none of the module's
    // timers or the actions it was running: a handoff it stopped gives its message back.
    const before = await read($, uiA)
    await update($, cacheA, c => ({ ...EMPTY_CACHE, ...c }))
    await update($, uiA, (u: UiState): UiState => ({
      ...EMPTY_UI, ...u, busy: false, notice: u.busy ? W.handoffReloaded : u.notice,
      confirm: CONFIRMS.includes(u.confirm) ? u.confirm : '',
    }))
    if (before.busy && before.held) await giveBack($, before.held)
    // A question an earlier version left open about a held message is not asked while holding is off.
    if (!isOn('holdCold')) await update($, uiA, (u: UiState): UiState => (u.confirm === 'send' ? { ...u, confirm: '', held: '' } : u))
    await $.command.register({ name: 'quota', description: 'Show every account, quota window and route of the proxy' })
    await $.command.register({ name: 'handoff', description: 'Hand off to a new session: a note on this one is saved, it clears, and the new one starts from the note' })
    await $.command.register({ name: 'hold-cold', description: 'Hold a message that would start a cold turn until you confirm it, in this session', argumentHint: '[on|off|default]', immediate: true })
    await $.command.register({ name: 'keep-warm', description: 'Keep the prompt cache warm while you are away, in this session', argumentHint: '[on|off|default]', immediate: true })
    await refresh($, true)
    $.clock.every(10_000, () => {
      void refresh($, false)
    })
    // While the plugin retries this session's account the band reads every 2 s, so the countdown,
    // the running seconds and the outcome show promptly; while its own step waits with no answer,
    // or a press is under way, it redraws to count.
    $.clock.every(2_000, async () => {
      const [snap, sess, live, ui] = await Promise.all([read($, snapA), read($, sessA), read($, liveA), read($, uiA)])
      if (snap?.sessions[sess.id]?.retry || ui.press?.stage === 'sending') void refresh($, false)
      else if ((live.step && live.step.contentAt === 0) || ui.press) {
        const now = await $.clock.now()
        await update($, nowA, () => now)
      }
    })
    await scheduleWarm($)
    return next(e)
  })

  // What Claude Code's hook events say of a session, for the band on another device to pass on:
  // a session reloaded mid-way hears no start, so its prompts say it too. A resumed conversation
  // also says how big it is and when it last had a reply, which its cache dates from.
  // These events wait for their hooks: what the band learns from them never holds them up.
  on('classic.SessionStart', async ($, e, next) => {
    await heardAbout($, e.session_id, e.transcript_path, e.session_title).catch(() => undefined)
    // After a /clear the host has wiped the band's state, the choice's mirror with it.
    if (e.source === 'clear') await update($, autoA, () => mine)
    if ((e.source === 'resume' || e.source === 'fork') && e.context_tokens) {
      const now = await $.clock.now()
      const tokens = e.context_tokens
      const ago = (e.seconds_since_last_response ?? 0) * 1000
      await update($, cacheA, c => ({ ...c, prompt: tokens, lastAt: now - ago, model: e.model ?? c.model, route: null }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await heardAbout($, e.session_id, e.transcript_path, e.session_title).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'quota' }, async $ => {
    await refresh($, true)
    await $.ui.open({ id: PANE, title: 'Accounts and quota' })
    return { text: 'Quota pane opened.' }
  })

  // `/handoff`, and what follows it is the message the new session gets after the note.
  on('command.run', { command: 'handoff' }, async ($, e) => {
    void handoffNow($, { held: e.args.trim() || undefined })
    return { text: 'Writing the handoff note…' }
  })

  on('command.run', { command: 'hold-cold' }, ($, e) => autoCommand($, 'holdCold', e.args))
  on('command.run', { command: 'keep-warm' }, ($, e) => autoCommand($, 'keepWarm', e.args))

  /**
   * A message that would start the next turn cold, in a conversation past the reader's threshold,
   * waits: Claude Code puts a dropped prompt back in the box, and the band asks. Enter again sends
   * it. Never held: one with images (a plugin can send text only), a command, one typed while
   * Claude works, one the reader did not type here, or a cold turn already confirmed.
   */
  on('prompt.submit', async ($, e, next) => {
    const gen = holdGen
    if (!isOn('holdCold') || e.turnId || e.attachments?.length || !e.text.trim() || /^\s*[/!]/.test(e.text)) return next(e)
    const typed = e.origin.kind === 'composer'
      || (e.origin.kind === 'sdk' && (await $.session.surfaces().catch(() => [] as string[])).includes('desktop'))
    if (!typed) return next(e)
    const input = await bandInput($, false, true)
    const { cold, cost } = nextTurn(input)
    // Claude Code asks before /model itself, saying the history is read again: not asked twice.
    if (!cold || cold.reason === 'model' || cold.tokens < settings.confirmAbove) return next(e)
    // Asked once each cold spell: the next Enter sends, as after the reader closed the question.
    if (coldConfirmed(cold, input.ui.coldOk)) return next(e)
    await setUi($, { confirm: 'send', held: e.text, coldOk: cold.key, switchStep: '', move: null })
    // Holding was turned off while this decided: the message goes, and its question with it.
    if (gen !== holdGen || !isOn('holdCold')) {
      await update($, uiA, (u: UiState): UiState => (u.confirm === 'send' && u.held === e.text ? { ...u, confirm: '', held: '' } : u))
      return next(e)
    }
    return { drop: `held by quota-band: the next turn starts cold and ${rewriteText(cold.tokens, cost)}. Enter sends it.` }
  }).catch(($, e, next) => next(e)) // a guard that fails lets the message through

  // A turn of the reader's: the cache is not kept warm while it runs, a new idle stretch starts
  // after it, and a question about a held message is settled. A prompt starts it; the band's own
  // model calls start no turn.
  // A subagent's turn is not the reader's: the main loop's alone is followed.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    mainTurn = e.turnId
    stopWarm()
    await update($, cacheA, c => (c.warmed || c.warmStop ? { ...c, warmed: 0, warmStop: false } : c))
    await update($, uiA, (u: UiState): UiState => {
      // After a press stopped a turn, how to go on is told until another main turn starts.
      const press = u.press?.stage === 'stopping' && u.press.turnId !== e.turnId && !u.press.since ? { ...u.press, since: true } : u.press
      const pressed = u.pressed && !u.pressed.since ? { ...u.pressed, since: true } : u.pressed
      if (u.confirm !== 'send' && press === u.press && pressed === u.pressed) return u
      return { ...u, ...(u.confirm === 'send' ? { confirm: '', held: '' } : {}), press, pressed }
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const gen = generation
    // A cache entry lives from its request's start, the time spent answering included. The clock
    // is asked before the step and answers after it: a streaming hook passes the step on first.
    const asked = $.clock.now()
    // The reader's own step (not a subagent's, nor the band's model call): its content chunks say
    // whether it is answering (text, thinking, a tool call or its input; never the engine's own
    // items, such as its retry marker).
    const watched = !ownStep(e) && (!mainTurn || e.turnId === mainTurn)
    const mine = (l: Live) => l.step?.turnId === e.turnId && l.step.index === e.index
    const ofStep = (p: Press) => p.turnId === e.turnId && p.index === e.index
    if (watched) {
      const [startedAt, snap, sess] = await Promise.all([asked, read($, snapA), read($, sessA)])
      const generation = snap?.sessions[sess.id]?.generation
      await update($, liveA, l => ({ ...l, step: { turnId: e.turnId, index: e.index, startedAt, contentAt: 0, generation } }))
    }
    const inner = next(e)
    let r: Awaited<ReturnType<typeof inner.next>>['value'] | undefined
    let done = false
    try {
      for (;;) {
        const item = await inner.next()
        if (item.done) {
          r = item.value
          done = true
          break
        }
        const chunk = item.value
        if (watched && chunk.kind !== 'engine' && chunk.kind !== 'stop') {
          const at = await $.clock.now()
          let answered = false
          await update($, liveA, l => {
            const step = mine(l) ? stepAfter(l.step, chunk, at) : l.step
            answered = step !== l.step
            return answered ? { ...l, step } : l
          })
          if (answered) await voidPress($, ofStep)
        }
        yield chunk
      }
    } finally {
      if (!done) await inner.return?.(undefined as never)
      if (watched) {
        await update($, liveA, l => (mine(l) ? { ...l, step: null } : l))
        await voidPress($, ofStep)
      }
    }
    const started = await asked
    // A step of another conversation (one a /clear or a resume left) is not this one's.
    if (gen === generation && !ownStep(e) && r?.usage) {
      const u = r.usage
      const [snap, sess] = await Promise.all([read($, snapA), read($, sessA)])
      // Only a reply that read or wrote the cache says it is warm; one that did neither, as one under
      // the provider's smallest cached prompt, leaves it unknown.
      const cached = u.cache_read_input_tokens + u.cache_creation_input_tokens > 0
      // Checked again as it is written: a /clear or resume while the reads above ran leaves it.
      await update($, cacheA, c => (gen !== generation ? c : {
        ...c,
        lastAt: cached ? started : 0,
        prompt: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        read: u.cache_read_input_tokens,
        creation: u.cache_creation_input_tokens,
        input: u.input_tokens,
        model: e.model || c.model,
        route: snap?.sessions[sess.id]?.route?.model ?? '',
      }))
      if (e.effort !== undefined) await update($, sessA, s => ({ ...s, effort: String(e.effort) }))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (!ownStep(e)) {
      await update($, cacheA, c => ({ ...c, lastAnswer: e.answer }))
      await update($, uiA, (u: UiState): UiState => ({ ...u, turns: u.turns + 1 }))
      await endPress($, e.turnId, e.reason)
      // The end of the reader's turn, or of one the band did not hear start (it reloaded).
      if (!mainTurn || e.turnId === mainTurn) {
        mainTurn = ''
        await scheduleWarm($)
      }
    }
    const result = await next(e)
    void refresh($, false)
    // quota-pilot writes its snapshot about a second after the response; pick it up then.
    $.clock.after(1500, () => {
      void refresh($, false)
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    // After a clear or a resume the process goes on with another conversation: a handoff's
    // notice and the move it leaves for the new one stay.
    if (e.reason === 'clear' || e.reason === 'resume') {
      // Another conversation taken up in this window starts from the defaults; a /clear, the
      // handoff's too, goes on with the work and keeps the choice.
      if (e.reason === 'resume') mine = NO_CHOICE
      generation++
      leftTurn = mainTurn
      mainTurn = ''
      stopWarm()
      await update($, cacheA, c => ({ ...EMPTY_CACHE, ttlMs: c.ttlMs }))
      await update($, uiA, (u: UiState): UiState => ({ ...EMPTY_UI, notice: u.notice, noticeIsError: u.noticeIsError, busy: u.busy, held: u.held, afterHandoff: u.afterHandoff }))
    }
    const result = await next(e)
    void refresh($, true)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // The band is one link of a chain: what the hooks beneath draw (another mod's band, such as
    // pasted image thumbnails) goes under it, by the prompt, and the engine's own drawing comes
    // back as `{ type: 'engine' }`. No link can shrink another's `maxRows`, so while something is
    // drawn beneath, the band keeps to its one line, as while Claude works; `more` opens the cards.
    const below = await next(e)
    const beneath = below.type !== 'engine'
    working = e.props.isWorking
    const input = await bandInput($, working)
    const act = actsOf($)
    const f = bandFacts(input, act)
    const els = $.ui.resolve(e)
    const site = { bodyColumns: e.props.bodyColumns, maxRows: e.props.maxRows, working, beneath }
    if (e.surface === 'desktop' && 'Svg' in els) return desktopBand(els, input, f, act, site, below)
    return terminalBand(els, input, f, act, site, below)
  })

  // The pane: the proxy's accounts, or why there are none, then what the plugin and the band are
  // set to, the band's own settings always, with a control to flip each automatic feature here.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const P = e.surface === 'desktop' ? DESK : C
    const { Text } = els
    const [snap, bandError, now0, sess, auto] = await Promise.all([read($, snapA), read($, bandErrorA), read($, nowA), read($, sessA), read($, autoA)])
    const now = now0 || Date.now()
    const bar = e.surface === 'desktop' && 'Svg' in els ? lengthBar(els) : cellBar(els)
    const band = settingsRows({ settings, auto, unattended }, actsOf($))
    if (!sess.proxied || !snap) {
      const why = !sess.proxied
        ? <Text key="why" color={P.dim}>This session signs in to Claude directly, not through the proxy: the band shows this account's own limits.</Text>
        : bandError
          ? <Text key="why" color={P.orange}>{`No quota data: ${bandErrorText(bandError)}`}</Text>
          : <Text key="why" color={P.dim}>No quota-pilot snapshot found. Is the proxy plugin running?</Text>
      return quotaPane(els, P, [why], band, e.props.bodyColumns, bar)
    }
    const accounts = accountsPart(els, P, snap, sessionAccount(snap, sess.id), now, e.props.bodyColumns, bar)
    const items: SettingRow[] = [...accounts.items, ...band]
    return quotaPane(els, P, accounts.rows, items, e.props.bodyColumns, bar, snap.last_error)
  })
}
