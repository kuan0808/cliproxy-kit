// quota-band: the cards above the Claude Code prompt. Session, context and cache come from
// Claude Code itself; accounts, quota and routing come from the proxy's quota-pilot snapshot.
// What the band shows is decided once (view.ts) and drawn per surface: in character cells in a
// terminal (terminal.tsx), as cards in the desktop app (desktop.tsx).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BandError, CacheInfo, ModelInfo, Move, SessionAbout, SessionInfo, Snap, UiState } from '../types'
import { desktopBand, lengthBar } from './desktop'
import {
  C,
  DESK,
  HANDOFF_PROMPT,
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
  warmDueAt,
  type Settings,
} from './logic'
import { quotaPane } from './pane'
import { cellBar, terminalBand } from './terminal'
import { bandFacts, nextTurn, type BandInput, type Do, type Handoff } from './view'

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
  viewOverride: '', viewPhase: '', viewTurn: 0, turns: 0, dismissedSwitch: '',
}

const snapA = atom({ plugin: 'quota-band', key: 'snap' } as const, null)
const bandErrorA = atom({ plugin: 'quota-band', key: 'bandError' } as const, null)
const nowA = atom({ plugin: 'quota-band', key: 'now' } as const, 0)
const sessA = atom({ plugin: 'quota-band', key: 'session' } as const, EMPTY_SESSION)
const aboutA = atom({ plugin: 'quota-band', key: 'about' } as const, EMPTY_ABOUT)
const cacheA = atom({ plugin: 'quota-band', key: 'cache' } as const, EMPTY_CACHE)
const uiA = atom({ plugin: 'quota-band', key: 'ui' } as const, EMPTY_UI)
const modelsA = atom({ plugin: 'quota-band', key: 'models' } as const, [] as ModelInfo[])

type $T = EngineInterface

/** The plugin's settings (its `userConfig`), as the module last loaded with them. */
let settings: Settings = settingsOf({})

/** Patch the band's UI state; typed so literal fields keep their union types. */
const setUi = ($: $T, patch: Partial<UiState>) => update($, uiA, (u: UiState): UiState => ({ ...u, ...patch }))

const kitPath = (home: string, rest: string) => `${home}/.cache/cliproxy-kit/${rest}`

/**
 * What the band reads to decide what it shows: as of its last refresh for a drawing, or as of now
 * (`fresh`) for a decision that cannot wait for one.
 */
async function bandInput($: $T, working: boolean, fresh = false): Promise<BandInput> {
  const [snap, bandError, polled, sess, cache, ui, models] = await Promise.all([
    read($, snapA), read($, bandErrorA), read($, nowA), read($, sessA), read($, cacheA), read($, uiA), read($, modelsA),
  ])
  const now = fresh ? await $.clock.now() : polled || Date.now()
  return { snap, bandError, now, sess, cache, ui, models, settings, working }
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
  const ui = await read($, uiA)
  if (ui.pending.length) {
    await update($, uiA, (u: UiState): UiState => {
      const { left, notice } = settlePending(u.pending, snap, now)
      return notice ? { ...u, pending: left, notice: notice.text, noticeIsError: notice.isError } : u
    })
    return
  }
  const landed = snap?.sessions[(await read($, sessA)).id]?.auth_id
  if (!landed || !(ui.coldOk.endsWith(':*') || ui.coldDismissed.endsWith(':*'))) return
  const name = (key: string) => (key.endsWith(':*') ? `${key.slice(0, -1)}${landed}` : key)
  await update($, uiA, (u: UiState): UiState => ({ ...u, coldOk: name(u.coldOk), coldDismissed: name(u.coldDismissed) }))
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
    await setUi($, { notice: bandError ? bandErrorText(bandError) : 'The proxy plugin is not running', noticeIsError: true, confirm: '', move: null })
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
    notice: `${move.text}…`, noticeIsError: false, pending: [...u.pending, pending],
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
  if (!ran && !(await read($, uiA)).busy) await setUi($, { notice: 'The band was busy: try the handoff again in a moment', noticeIsError: true })
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
    await setUi($, { busy: true, confirm: '', move: null, held: then.held ?? '', notice: 'Writing the handoff note…', noticeIsError: false })
    if (given.fromBox) await $.prompt.fill({ text: '' }).catch(() => undefined)
    const tail = cache.lastAnswer ? `\n\nYour latest reply, which may be missing from this request, was:\n${cache.lastAnswer.slice(0, 6000)}` : ''
    const next = then.held ? `\n\nThe new session gets this message from the user right after the note:\n${then.held}` : ''
    forking = true
    const r = await $.model.fork({ prompt: HANDOFF_PROMPT + tail + next }).finally(() => { forking = false })
    if (!r.isAnswered || !r.text.trim()) {
      await setNotice($, `Handoff stopped: no note (${r.isAnswered ? 'empty' : r.reason}); the conversation is kept`, true)
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
      await setNotice($, 'Handoff stopped: the note could not be saved; the conversation is kept', true)
      return
    }
    saved = shown
    // The conversation must be the one the note is about, as it was: not another (a /clear or a
    // resume meanwhile), and not one that went on while the note was written.
    const [id, after] = await Promise.all([$.session.id(), read($, uiA)])
    if (id !== sess.id || after.turns !== before.turns || mainTurn) {
      await setNotice($, `Note saved at ${shown}; the conversation changed or went on while it was written, so it was not cleared`, true)
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
      await setNotice($, `Note saved at ${shown}; ${fresh === sess.id ? 'the conversation was not cleared' : 'another conversation came first, so the note was not sent'}`, true)
      return
    }
    // From here on the note is the only copy of the context: every message names where it is.
    handedOff = true
    if (then.move) await setUi($, { afterHandoff: { ...then.move, to: fresh, at: await $.clock.now() } })
    const text = `Continue from this handoff note (saved at ${path}):\n\n${r.text.trim()}${then.held ? `\n\n---\n\n${then.held}` : ''}`
    const sent = !mentionsFile(then.held ?? '') && await $.prompt.submit({ text, asUser: true }).then(s => !s.drop, () => false)
    if (sent) {
      await setNotice($, `Handed off: the new session starts from ${shown}`, false)
      return
    }
    const fill = await $.prompt.fill({ text }).catch(() => ({ isFilled: false }))
    await setNotice($, fill.isFilled ? 'New session ready: the note is in the prompt; press Enter to start' : `New session started. Note saved at ${shown}`, !fill.isFilled)
  } catch (err) {
    await setNotice($, `Handoff failed: ${String(err)}${saved ? `; the note is at ${saved}` : ''}`, true)
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
      await setUi($, { notice: 'Press Enter to send it: a message that names files with @ goes from the prompt box', noticeIsError: false })
      return
    }
    await $.prompt.fill({ text: '' }).catch(() => undefined)
    const r = await $.prompt.submit({ text, asUser: true }).catch(() => null)
    if (!r || r.drop) {
      await giveBack($, text)
      await setNotice($, `Not sent${r?.drop ? `: ${r.drop}` : ''}; the message is back in the prompt`, true)
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
  if (!settings.keepWarm || mainTurn) return
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
  await exclusive(async () => {
    const [cache, now] = await Promise.all([read($, cacheA), $.clock.now()])
    if (cache.lastAt !== at || mainTurn || working || (await $.session.id()) !== id) return
    if (now >= cache.lastAt + cache.ttlMs - 30_000) return
    const next = nextTurn(await bandInput($, false, true))
    // Again after the reads: a turn the reader started meanwhile keeps the cache itself.
    if (next.isCodex || next.cold || mainTurn || working) return
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
  if (refreshed) await scheduleWarm($)
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
  }
}

const CONFIRMS: readonly UiState['confirm'][] = ['handoff', 'switch', 'move', 'send']

export const register: Register = (on, options) => {
  settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    // A reload keeps the band's state, perhaps an older version's, but none of the module's
    // timers or the actions it was running: a handoff it stopped gives its message back.
    const before = await read($, uiA)
    await update($, cacheA, c => ({ ...EMPTY_CACHE, ...c }))
    await update($, uiA, (u: UiState): UiState => ({
      ...EMPTY_UI, ...u, busy: false, notice: u.busy ? 'The band reloaded during a handoff; the conversation is kept' : u.notice,
      confirm: CONFIRMS.includes(u.confirm) ? u.confirm : '',
    }))
    if (before.busy && before.held) await giveBack($, before.held)
    await $.command.register({ name: 'quota', description: 'Show every account, quota window and route of the proxy' })
    await $.command.register({ name: 'handoff', description: 'Hand off to a new session: a note on this one is saved, it clears, and the new one starts from the note' })
    await refresh($, true)
    $.clock.every(10_000, () => {
      void refresh($, false)
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

  /**
   * A message that would start the next turn cold, in a conversation past the reader's threshold,
   * waits: Claude Code puts a dropped prompt back in the box, and the band asks. Enter again sends
   * it. Never held: one with images (a plugin can send text only), a command, one typed while
   * Claude works, one the reader did not type here, or a cold turn already confirmed.
   */
  on('prompt.submit', async ($, e, next) => {
    if (!settings.confirmAbove || e.turnId || e.attachments?.length || !e.text.trim() || /^\s*[/!]/.test(e.text)) return next(e)
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
    return { drop: `held by quota-band: the next turn starts cold and ${rewriteText(cold.tokens, cost)}. Enter sends it.` }
  }).catch(($, e, next) => next(e)) // a guard that fails lets the message through

  // A turn of the reader's: the cache is not kept warm while it runs, a new idle stretch starts
  // after it, and a question about a held message is settled. A prompt starts it; the band's own
  // model calls start no turn.
  on('turn.start', async ($, e, next) => {
    mainTurn = e.turnId
    stopWarm()
    await update($, cacheA, c => (c.warmed || c.warmStop ? { ...c, warmed: 0, warmStop: false } : c))
    await update($, uiA, (u: UiState): UiState => (u.confirm === 'send' ? { ...u, confirm: '', held: '' } : u))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const gen = generation
    // A cache entry lives from its request's start, the time spent answering included. The clock
    // is asked before the step and answers after it: a streaming hook passes the step on first.
    const asked = $.clock.now()
    const r = yield* next(e)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const P = e.surface === 'desktop' ? DESK : C
    const { Text } = els
    const [snap, bandError, now0, sess] = await Promise.all([read($, snapA), read($, bandErrorA), read($, nowA), read($, sessA)])
    const now = now0 || Date.now()
    if (!sess.proxied) {
      return <Text color={P.dim}>This session signs in to Claude directly, not through the proxy: the band shows this account's own limits.</Text>
    }
    if (!snap) {
      return bandError
        ? <Text color={P.orange}>{`No quota data: ${bandErrorText(bandError)}`}</Text>
        : <Text color={P.dim}>No quota-pilot snapshot found. Is the proxy plugin running?</Text>
    }
    const bar = e.surface === 'desktop' && 'Svg' in els ? lengthBar(els) : cellBar(els)
    return quotaPane(els, P, snap, sessionAccount(snap, sess.id), now, e.props.bodyColumns, settings, bar)
  })
}
