// quota-band: the cards above the Claude Code prompt. Session, context and cache come from
// Claude Code itself; accounts, quota and routing come from the quota-pilot snapshot file.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { BandError, CacheInfo, ModelInfo, SessionAbout, SessionInfo, Snap, UiState } from '../types'
import {
  C,
  HANDOFF_PROMPT,
  bandErrorText,
  barFill,
  blockedOthers,
  cacheState,
  cannotTake,
  cacheTtlMs,
  fmtDuration,
  fmtTokens,
  hitRate,
  currentModel,
  latestModels,
  missingText,
  usedText,
  nextTurnMoves,
  providerOfModel,
  providerTitle,
  layout,
  tileWidths,
  tilesSpan,
  likelyAccount,
  nextUp,
  offerCacheActions,
  parseModels,
  parseSnap,
  pickAlert,
  pooled,
  readBand,
  resetText,
  sessionAccount,
  settlePending,
  sev,
  snapIsLive,
  switchTargets,
  untilIso,
  weeklyFor,
  windowOf,
  type Alert,
  type SessionAccount,
} from './logic'

const PANE = 'quota'

const EMPTY_SESSION: SessionInfo = {
  id: '', model: '', effort: '', cwd: '',
  contextTokens: null, contextWindow: 0, rateLimits: [], proxied: false, remote: false, home: '',
}
const EMPTY_ABOUT: SessionAbout = { id: '', transcript: '', eventTitle: '', fileTitle: '', fileTitleAt: 0, request: '', start: '', root: '' }
const EMPTY_CACHE: CacheInfo = { lastAt: 0, prompt: 0, read: 0, creation: 0, input: 0, ttlMs: 0, lastAnswer: '' }
const EMPTY_UI: UiState = {
  switchStep: '', confirm: '', pending: [], notice: '', noticeIsError: false, busy: false,
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

/** Patch the band's UI state; typed so literal fields keep their union types. */
const setUi = ($: $T, patch: Partial<UiState>) => update($, uiA, (u: UiState): UiState => ({ ...u, ...patch }))

const kitPath = (home: string, rest: string) => `${home}/.cache/cliproxy-kit/${rest}`

// ---- data refresh ----

// One refresh runs at a time, so a slow one never writes over the result of a newer one, and at
// most one waits behind it, standing for every request made meanwhile (a full one if any was):
// a slow network read never builds a queue.
let running: Promise<void> | null = null
let waiting: Promise<void> | null = null
let waitingFull = false

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
  const [home, base, ttl, token] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('ANTHROPIC_BASE_URL'),
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    $.env.get('ANTHROPIC_AUTH_TOKEN'),
  ])
  const [id, model, usage, cwd] = await Promise.all([$.session.id(), $.session.model(), $.session.usage(), $.session.cwd()])
  const proxied = Boolean(base)
  const now = await $.clock.now()
  // Beside a proxy that runs as this user the snapshot is a file; when none reads here (another
  // machine, a proxy in a container or run as another user) it comes over the network. The file
  // is the proxy's only while it keeps it fresh: a stopped proxy leaves its last one behind.
  const localBase = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(base ?? '')
  const file = home && (!proxied || localBase)
    ? parseSnap(await $.fs.read(kitPath(home, 'snapshot.json')).catch(() => ''))
    : null
  const localSnap = file && (!proxied || snapIsLive(file, now)) ? file : null
  const remote = proxied && !localSnap
  const prev = await read($, sessA)
  const next: SessionInfo = {
    ...prev,
    id, model, cwd, proxied, remote, home: home ?? '',
    contextTokens: usage.context.tokens ?? null,
    contextWindow: usage.context.window,
    rateLimits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) await update($, sessA, () => next)
  const about = remote ? await learnAbout($, id, now) : EMPTY_ABOUT
  const ttlMs = cacheTtlMs(ttl, proxied)
  if ((await read($, cacheA)).ttlMs !== ttlMs) await update($, cacheA, c => ({ ...c, ttlMs }))

  if (full && proxied && !remote && base && token) {
    try {
      const r = await $.http.fetch(`${base.replace(/\/+$/, '')}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })
      const list = r.ok ? parseModels(r.text) : null
      if (list) await update($, modelsA, () => list)
    } catch {
      // The switch row then offers accounts only.
    }
  }

  if (home || remote) {
    let snap = localSnap
    let error: BandError | null = null
    if (remote && base && token) {
      try {
        // What the band knows of its session goes in headers, kept out of the proxy's request log.
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
        const said: [string, string][] = [
          ['X-Band-Session', id],
          ['X-Band-Title', about.eventTitle || about.fileTitle || about.request],
          ['X-Band-Cwd', about.start],
          ['X-Band-Root', about.root],
        ]
        for (const [name, value] of said) if (value) headers[name] = encodeURIComponent(value)
        const r = await $.http.fetch(`${base.replace(/\/+$/, '')}/v0/resource/plugins/quota-pilot/band`, { headers })
        ;({ snap, error } = readBand(r.status, r.text))
      } catch (err) {
        snap = null
        error = { kind: 'network', message: err instanceof Error ? err.message : String(err) }
      }
    }
    // Nothing fresher came: a stopped proxy's last snapshot shows, which the band marks as old,
    // beside why the proxy gave none.
    snap ??= file
    const old = await read($, snapA)
    if (snap?.sequence !== old?.sequence || snap?.boot_id !== old?.boot_id || snap?.generated_at !== old?.generated_at) {
      await update($, snapA, () => snap)
    }
    if (JSON.stringify(error) !== JSON.stringify(await read($, bandErrorA))) await update($, bandErrorA, () => error)
    // Every read, changed or not: a command can also expire, or its proxy be gone.
    await settle($, snap, now)
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
    learned.start = await $.session.root()
    learned.root = (await $.session.repo().catch(() => null))?.root ?? ''
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

/** Settle pending commands by the snapshot just read (see `settlePending`). */
async function settle($: $T, snap: Snap | null, now: number): Promise<void> {
  if (!(await read($, uiA)).pending.length) return
  await update($, uiA, (u: UiState): UiState => {
    const { left, notice } = settlePending(u.pending, snap, now)
    return notice ? { ...u, pending: left, notice: notice.text, noticeIsError: notice.isError } : u
  })
}

/** Write a command for quota-pilot and track it until the snapshot acknowledges it. */
async function sendCommand($: $T, action: string, fields: Record<string, string>, text: string): Promise<void> {
  const [sess, snap] = await Promise.all([read($, sessA), read($, snapA)])
  if (sess.remote) {
    await setUi($, { notice: 'Account and route changes are made on the proxy host', noticeIsError: true, confirm: '' })
    return
  }
  if (!snap || !sess.home) {
    await setUi($, { notice: 'The proxy plugin is not running', noticeIsError: true, confirm: '' })
    return
  }
  const id = crypto.randomUUID()
  const at = await $.clock.now()
  const doc = { command_id: id, session: sess.id, boot_id: snap.boot_id, created_at: new Date(at).toISOString(), action, ...fields }
  await $.fs.write(kitPath(sess.home, `commands/${id}.json`), JSON.stringify(doc))
  const pending = { id, text, boot: snap.boot_id, at }
  await update($, uiA, (u: UiState): UiState => ({ ...u, confirm: '', switchStep: '', notice: `${text}…`, noticeIsError: false, pending: [...u.pending, pending] }))
}

async function setNotice($: $T, notice: string, isError: boolean): Promise<void> {
  await setUi($, { notice, noticeIsError: isError, busy: false, confirm: '' })
}

async function compactNow($: $T): Promise<void> {
  await setUi($, { busy: true, confirm: '', notice: 'Compacting…', noticeIsError: false })
  try {
    const r = await $.session.compact({})
    if ('skip' in r && r.skip) await setNotice($, `Compaction skipped: ${r.skip}`, true)
    else await setNotice($, 'Compacted', false)
  } catch (err) {
    await setNotice($, `Compaction failed: ${String(err)}`, true)
  }
}

/** Summary first, saved and read back, then clear, then pre-fill the new session's prompt. */
async function handoffNow($: $T): Promise<void> {
  await setUi($, { busy: true, confirm: '', notice: 'Writing handoff note…', noticeIsError: false })
  const [sess, cache] = await Promise.all([read($, sessA), read($, cacheA)])
  try {
    const tail = cache.lastAnswer ? `\n\nYour latest reply, which may be missing from this request, was:\n${cache.lastAnswer.slice(0, 6000)}` : ''
    const r = await $.model.fork({ prompt: HANDOFF_PROMPT + tail })
    if (!r.isAnswered || !r.text.trim()) {
      await setNotice($, `Handoff stopped: no summary (${r.isAnswered ? 'empty' : r.reason}); conversation kept`, true)
      return
    }
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
    const path = kitPath(sess.home, `handoff/${sess.id}-${stamp}.md`)
    await $.fs.write(path, r.text)
    if ((await $.fs.read(path)) !== r.text) {
      await setNotice($, 'Handoff stopped: the note could not be saved; conversation kept', true)
      return
    }
    await $.command.run({ command: 'clear' })
    // From here on the note is the only copy of the context: every message names where it is.
    try {
      if ((await $.session.id()) === sess.id) {
        await setNotice($, `Note saved at ${path}; the session did not clear`, true)
        return
      }
      const fill = await $.prompt.fill({ text: `Continue from this handoff note (saved at ${path}):\n\n${r.text}` })
      await setNotice($, fill.isFilled ? 'New session started with the handoff note in the prompt' : `New session started. Note saved at ${path}`, false)
    } catch (err) {
      await setNotice($, `New session started; the note is at ${path} (${String(err)})`, true)
    }
  } catch (err) {
    await setNotice($, `Handoff failed: ${String(err)}`, true)
  }
}

// ---- hooks ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quota', description: 'Show every account, quota window and route of the proxy' })
    await refresh($, true)
    $.clock.every(10_000, () => {
      void refresh($, false)
    })
    return next(e)
  })

  // What Claude Code's hook events say of a session, for the band on another device to pass on:
  // a session reloaded mid-way hears no start, so its prompts say it too.
  // These events wait for their hooks: what the band learns from them never holds them up.
  on('classic.SessionStart', async ($, e, next) => {
    await heardAbout($, e.session_id, e.transcript_path, e.session_title).catch(() => undefined)
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await heardAbout($, e.session_id, e.transcript_path, e.session_title).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'quota' }, async $ => {
    await refresh($, true)
    await $.ui.open({ id: PANE, title: 'Accounts and quota' })
    return { text: 'Quota pane opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!e.agentId && r?.usage) {
      const u = r.usage
      const now = await $.clock.now()
      await update($, cacheA, c => ({
        ...c,
        lastAt: now,
        prompt: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        read: u.cache_read_input_tokens,
        creation: u.cache_creation_input_tokens,
        input: u.input_tokens,
      }))
      if (e.effort !== undefined) await update($, sessA, s => ({ ...s, effort: String(e.effort) }))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, cacheA, c => ({ ...c, lastAnswer: e.answer }))
      await update($, uiA, (u: UiState): UiState => ({ ...u, turns: u.turns + 1 }))
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
    // After a clear or a resume the process goes on with another conversation.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, cacheA, c => ({ ...EMPTY_CACHE, ttlMs: c.ttlMs }))
      await update($, uiA, (u: UiState): UiState => ({ ...EMPTY_UI, notice: u.notice, noticeIsError: u.noticeIsError, busy: u.busy }))
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const [snap, bandError, now0, sess, cache, ui, models] = await Promise.all([
      read($, snapA), read($, bandErrorA), read($, nowA), read($, sessA), read($, cacheA), read($, uiA), read($, modelsA),
    ])
    const now = now0 || Date.now()
    const acct = sess.proxied ? sessionAccount(snap, sess.id) : null
    // Right after a switch, a move or a route the next turn lands where nothing is cached yet.
    const cs = nextTurnMoves(acct) ? { state: 'cold' as const, leftMs: 0, frac: 0 } : cacheState(cache, now)
    const working = e.props.isWorking
    // One column of air before the engine's own [-] at the top right.
    const rowWidth = Math.max(20, e.props.bodyColumns - 1)
    // One line while Claude works and cards while it waits, unless the reader chose otherwise
    // for this stretch; cards only where the terminal has room for them.
    const phase = working ? 'working' : 'idle'
    const roomy = layout(rowWidth, e.props.maxRows, false)
    const chosen = ui.viewPhase === phase && ui.viewTurn === ui.turns ? ui.viewOverride : ''
    const mode = chosen === 'line' ? 'compact' : chosen === 'cards' ? roomy : layout(rowWidth, e.props.maxRows, working || beneath)
    const setView = (view: 'cards' | 'line') => setUi($, { viewOverride: view, viewPhase: phase, viewTurn: ui.turns })

    const dim = (t: string) => <Text color={C.dim}>{t}</Text>
    const bar = (fraction: number, cells: number, color: string) => {
      const n = barFill(fraction, cells)
      return (
        <Box>
          <Text color={color}>{'━'.repeat(n)}</Text>
          <Text color={C.track}>{'━'.repeat(Math.max(0, cells - n))}</Text>
        </Box>
      )
    }
    // Every meter reads as used, as Claude's own /usage and the usage view do: a fresh session's
    // context and a new week start empty and fill. The colour still warns as what is left runs low.
    const pctText = (remaining: number, stale = false) => (
      <Text bold color={stale ? C.dim : sev(remaining)}>{`${Math.round(100 - remaining)}%${stale ? '~' : ''}`}</Text>
    )
    const usedFrac = (remaining: number) => (100 - remaining) / 100
    const usedBar = (remaining: number, cells: number, color: string) => bar(usedFrac(remaining), cells, color)
    // Controls read as words, not boxes: dim at rest, bright under the pointer or the focus.
    // No hotkey letters: they only work once the band has the keyboard (ctrl+x tab), so a letter
    // beside a control reads as a shortcut that does nothing. Main actions are bright.
    const link = (key: string, label: string, onPress: () => void, main = false) => (
      <Button key={key} label={label} plain dimColor={!main} onPress={onPress} />
    )

    // -- what the band shows --
    // A routed session runs the route's model; otherwise the model and context window are Claude
    // Code's own, which change with /model before any reply.
    const route = acct?.session.route
    const ctxWindow = route && snap?.context_lengths[route.model] ? snap.context_lengths[route.model]! : sess.contextWindow
    const ctxUsed = sess.contextTokens
    const ctxLeft = ctxUsed != null && ctxWindow > 0 ? Math.max(0, 100 - (ctxUsed / ctxWindow) * 100) : null
    const model = route ? route.model : currentModel(sess.model, acct?.session.requested_model || (acct?.provider === 'claude' ? acct.session.model : ''))
    const isCodex = acct?.provider === 'codex'
    const longContext = !route && /\[1m\]$/.test(sess.model) ? ' 1M' : ''
    const modelName = `${model.replace(/^claude-/, '')}${longContext}`
    const rate = hitRate(cache)

    type Meter = { remaining: number; reset: string; stale: boolean; label: string }
    const meterOf = (w: { remaining: number; reset_at?: string; stale: boolean; label: string } | undefined): Meter | undefined =>
      w ? { remaining: w.remaining * 100, reset: untilIso(w.reset_at, now), stale: w.stale, label: w.label } : undefined
    let five: Meter | undefined
    let week: Meter | undefined
    let acctLabel = ''
    let acctNote = ''
    const likely = sess.proxied && !acct?.cred ? likelyAccount(snap, acct?.provider ?? providerOfModel(sess.model)) : null
    if (acct?.cred) {
      acctLabel = acct.cred.label
      // The plan only: a move is told once, by the switch notice above the band.
      acctNote = acct.cred.plan ?? ''
      five = meterOf(windowOf(acct.cred, '5h'))
      week = meterOf(weeklyFor(acct.cred, model))
    } else if (likely) {
      // Before the proxy has seen this session: the account a new session gets.
      acctLabel = likely.cred.label
      acctNote = [likely.cred.plan, 'expected'].filter(Boolean).join(' · ')
      five = meterOf(windowOf(likely.cred, '5h'))
      week = meterOf(weeklyFor(likely.cred, model))
    } else if (!sess.proxied) {
      acctLabel = 'claude.ai'
      acctNote = 'direct login'
      const r5 = sess.rateLimits.find(r => r.kind === 'five_hour')
      const r7 = sess.rateLimits.find(r => r.kind === 'seven_day')
      five = r5 && { remaining: 100 - r5.percentUsed, reset: untilIso(r5.resetsAt, now), stale: false, label: '5-hour' }
      week = r7 && { remaining: 100 - r7.percentUsed, reset: untilIso(r7.resetsAt, now), stale: false, label: 'Weekly' }
    } else {
      acctLabel = 'proxy'
      acctNote = 'no quota data'
    }
    const poolView = acct?.view ?? (likely ? snap?.providers[likely.provider] : undefined)
    const poolCurrent = acct?.session.auth_id ?? likely?.cred.id ?? ''
    const all = poolView && poolView.credentials.length ? pooled(poolView) : null
    const shownCred = acct?.cred ?? likely?.cred
    // The provider the session asks for, which `back` returns a routed session to.
    const original = acct?.session.requested_model ? providerOfModel(acct.session.requested_model) : acct?.provider ?? ''
    // Providers this proxy has accounts and models for: the switch row offers the others, and while
    // routed the route's own too, for another of its models.
    const switchProviders = acct && snap
      ? Object.keys(snap.providers).filter(p => (route ? p !== original : p !== acct.provider) && latestModels(models, p).length)
      : []
    const canSwitch = Boolean(acct && !sess.remote && (acct.view.credentials.length > 1 || switchProviders.length || acct.session.route))
    const toggleSwitch = () => setUi($, { confirm: ui.confirm === 'switch' ? '' : 'switch', switchStep: '' })

    // -- rows above the band: a confirmation, a notice or an alert --
    const width = mode === 'compact' ? rowWidth : tilesSpan(mode, rowWidth)
    const rowBox = (key: string, bg: string, children: RenderChildren[]) => (
      <Box key={key} backgroundColor={bg} paddingX={2} justifyContent="space-between" width={width}>
        {children}
      </Box>
    )
    const say = (mark: string, color: string, text: string) => <Text><Text bold color={color}>{mark}</Text>{text}</Text>
    const top: RenderChildren[] = []
    if (ui.confirm === 'compact') {
      top.push(rowBox('ask', C.askBg, [
        say('? ', C.accent, `Compact this conversation? A summary replaces ${fmtTokens(cache.prompt)} of history.`),
        <Box gap={2}>
          {link('yes-compact', 'compact', () => compactNow($), true)}
          {link('no', 'cancel', () => setUi($, { confirm: '' }))}
        </Box>,
      ]))
    } else if (ui.confirm === 'handoff') {
      top.push(rowBox('ask', C.askBg, [
        say('? ', C.accent, 'Hand off to a new session? Writes a note, clears this conversation, fills the prompt.'),
        <Box gap={2}>
          {link('yes-handoff', 'hand off', () => handoffNow($), true)}
          {link('no', 'cancel', () => setUi($, { confirm: '' }))}
        </Box>,
      ]))
    } else if (ui.confirm === 'switch' && acct) {
      // Two steps: accounts of this provider and the providers to route to, then that provider's models.
      const close = () => setUi($, { confirm: '', switchStep: '' })
      if (ui.switchStep) {
        const provider = ui.switchStep
        const list = latestModels(models, provider)
        top.push(rowBox('ask', C.askBg, [
          say('? ', C.accent, `${providerTitle(provider)} model, the next reply resends the conversation (${fmtTokens(cache.prompt)})`),
          <Box gap={2}>
            {list.map(m => route?.model === m
              ? dim(`${m} (now)`)
              : link(`model-${m}`, m, () => sendCommand($, 'route', { provider, model: m }, `Switch to ${m}`), true))}
            {link('back', '‹ back', () => setUi($, { switchStep: '' }))}
            {link('no', 'cancel', close)}
          </Box>,
        ]))
      } else {
        const others = acct.view.credentials.filter(c => c.id !== acct.session.auth_id)
        const ready = new Set(switchTargets(acct.view, acct.session.auth_id, acct.session.blocked).map(c => c.id))
        top.push(rowBox('ask', C.askBg, [
          say('? ', C.accent, 'Switch this session to:'),
          <Box gap={2}>
            {others.map(c => ready.has(c.id)
              ? link(`to-${c.id}`, `${c.label} ${usedText(windowOf(c, '7d'))}`,
                  () => sendCommand($, 'switch', { auth_id: c.id }, `Switch to ${c.label}`), true)
              : dim(cannotTake(c, acct.session.model, now)))}
            {route
              ? link('unroute', `back to ${providerTitle(original)}`, () => sendCommand($, 'unroute', {}, `Back to ${providerTitle(original)}`), true)
              : null}
            {switchProviders.map(p => link(`prov-${p}`, `${providerTitle(p)} ›`, () => setUi($, { switchStep: p }), true))}
            {link('no', 'cancel', close)}
          </Box>,
        ]))
      }
    } else if (ui.notice) {
      top.push(rowBox('notice', ui.noticeIsError ? C.warnBg : C.infoBg, [
        say(ui.noticeIsError ? '! ' : '· ', ui.noticeIsError ? C.orange : C.aqua, ui.notice),
        ui.busy ? dim('working…') : link('dismiss', 'ok', () => setUi($, { notice: '' })),
      ]))
    } else {
      // Without quota data from the proxy, the reason it gave goes first.
      const alert: Alert | null = bandError
        ? { level: 'warn', text: bandErrorText(bandError) }
        : pickAlert(snap, acct, sess.proxied, now, ui.dismissedSwitch)
      if (alert) {
        const fallback = acct ? snap?.config.fallback_map[acct.provider] : undefined
        const [fbProvider, fbModel] = (fallback ?? ':').split(':')
        top.push(rowBox('alert', alert.level === 'warn' ? C.warnBg : C.infoBg, [
          say(alert.level === 'warn' ? '! ' : '↪ ', alert.level === 'warn' ? C.orange : C.aqua, alert.text),
          alert.action === 'route' && fbProvider && fbModel && !sess.remote
            ? link('route', `use ${fbModel}`, () => sendCommand($, 'route', { provider: fbProvider, model: fbModel }, `Route to ${fbModel}`))
            : alert.action === 'handoff' && !working
              ? link('alert-handoff', 'hand off', () => setUi($, { confirm: 'handoff' }))
              : alert.action === 'dismiss'
                ? link('alert-ok', 'ok', () => setUi($, { dismissedSwitch: alert.key ?? '' }))
                : <Text> </Text>,
        ]))
      }
    }

    const cacheWord = isCodex
      ? rate == null ? dim('waiting') : <Text bold color={sev(rate * 100)}>{`hit ${Math.round(rate * 100)}%`}</Text>
      : cs.state === 'warm' ? <Text bold color={C.green}>Warm</Text>
      : cs.state === 'expiring' ? <Text bold color={C.yellow}>Expiring</Text>
      : cs.state === 'cold' ? <Text bold color={C.red}>Cold</Text>
      : dim('waiting')
    const cacheFrac = isCodex ? rate ?? 0 : cs.frac
    const cacheColor = isCodex ? sev((rate ?? 0) * 100) : cs.state === 'expiring' ? C.yellow : cs.state === 'cold' ? C.red : C.green

    // -- one or two rows: while Claude works, or when the terminal is too narrow for tiles --
    if (mode === 'compact') {
      // The width of a meter's figure, which shows what is used.
      const pctWidth = (remaining: number) => `${Math.round(100 - remaining)}%`.length
      const hit = rate == null ? '' : `hit ${Math.round(rate * 100)}%`
      const cacheValue = isCodex ? (hit || '—') : cs.state === 'unknown' ? '—' : cs.state === 'cold' ? 'cold' : fmtDuration(cs.leftMs)
      const cacheTone = isCodex ? (rate == null ? C.dim : sev(rate * 100)) : cs.state === 'unknown' ? C.dim : cacheColor
      const effort = sess.effort ? ` · ${sess.effort}` : ''
      // `drop` orders what goes first when even the plainest row is too wide: higher goes first.
      type Slot = { width: number; node: RenderChildren; drop: number; model?: true }
      // label, a five-cell bar filled to `fill` (unless plain), the value, and an optional dim tail.
      // A quota meter fills with what is used; the cache's with what its tile's bar shows.
      const mini = (drop: number, label: string, fill: number, color: string, value: RenderChildren, valueWidth: number, bars: boolean, tail = ''): Slot => ({
        drop,
        width: label.length + 1 + (bars ? 6 : 0) + valueWidth + (tail ? tail.length + 1 : 0),
        node: <Box key={`meter-${label}`} gap={1}>{dim(label)}{bars ? bar(fill, 5, color) : null}{value}{tail ? dim(tail) : null}</Box>,
      })
      // Who and what: the account, then the model with its effort (or the route).
      const identity = (withEffort: boolean, divider: boolean): Slot[] => {
        const model = route ? `→ ${route.model}` : modelName
        const tail = route || !withEffort ? '' : effort
        return [
          { drop: 0, width: acctLabel.length, node: <Text bold>{acctLabel}</Text> },
          {
            drop: 4,
            model: true,
            // A divider after the model is counted here and drawn only when something follows it.
            width: model.length + tail.length + (divider ? 4 : 0),
            node: <Text><Text color={route ? C.aqua : C.fg}>{model}</Text><Text color={C.dim}>{tail}</Text></Text>,
          },
        ]
      }
      // The meters at a detail level: 0 everything, 1 without the pool and cache hit, 2 without
      // reset times, 4 without bars.
      const meters = (level: number): Slot[] => {
        const bars = level < 4
        const row: Slot[] = []
        if (ctxLeft != null) row.push(mini(1, 'ctx', usedFrac(ctxLeft), sev(ctxLeft), pctText(ctxLeft), pctWidth(ctxLeft), bars))
        for (const [drop, label, m] of [[2, '5h', five], [3, '7d', week]] as const) {
          if (!m) continue
          row.push(mini(drop, label, usedFrac(m.remaining), m.stale ? C.dim : sev(m.remaining), pctText(m.remaining, m.stale),
            pctWidth(m.remaining) + (m.stale ? 1 : 0), bars, level < 2 ? m.reset : ''))
        }
        row.push(mini(5, 'cache', cacheFrac, cacheTone, <Text bold color={cacheTone}>{cacheValue}</Text>, cacheValue.length, bars,
          level < 1 && !isCodex && hit ? `· ${hit}` : ''))
        if (level < 1 && all && all.left !== null && all.parts.length > 1) {
          const left = all.left
          row.push({ drop: 6, width: 5 + pctWidth(left) + (all.stale ? 1 : 0), node: <Box gap={1}>{dim('all')}{pctText(left, all.stale)}</Box> })
        }
        return row
      }
      // The way into the switch menu, and the cards where the terminal has room for them: kept to
      // the last when space runs out.
      const controls: Slot[] = []
      if (canSwitch) controls.push({ drop: -1, width: 6, node: link('switch', 'switch', toggleSwitch) })
      if (roomy !== 'compact') controls.push({ drop: -1, width: 4, node: link('view-cards', 'more', () => setView('cards')) })
      const budget = rowWidth - 4
      const span = (row: Slot[]) => row.reduce((sum, s) => sum + s.width, 0) + 3 * (row.length - 1)
      // The richest level that fits (level 3 also drops the effort), then items by `drop`.
      const fit = (build: (level: number) => Slot[]) => {
        let level = 0
        let row = build(level)
        while (span(row) > budget && level < 4) row = build(++level)
        while (span(row) > budget && row.length > 1) {
          const worst = row.reduce((a, b) => (b.drop > a.drop ? b : a))
          row = row.filter(s => s !== worst)
        }
        return row
      }
      const withControls = (row: Slot[]) => [...row, ...controls]
      const full = withControls([...identity(true, true), ...meters(0)])
      // Everything on one row when it fits; else, given the height and nothing drawn beneath, who
      // and what on one row and the meters with full detail on a second; else one row that sheds
      // detail, leaving the rest of the band to what lies beneath.
      const lines: Slot[][] = span(full) <= budget
        ? [full]
        : !beneath && e.props.maxRows >= top.length + 2
          ? [fit(level => withControls(identity(level < 1, false))), fit(meters)]
          : [fit(level => withControls([...identity(level < 3, true), ...meters(level)]))]
      return (
        <Box flexDirection="column">
          {top}
          {lines.map((row, n) => (
            <Box key={`line-${n}`} paddingX={2} gap={3} width={rowWidth}>
              {row.map((s, i) => (s.model && lines.length === 1 && i < row.length - 1 ? <Box key="model" gap={3}>{s.node}{dim('│')}</Box> : s.node))}
            </Box>
          ))}
          {below}
        </Box>
      )
    }

    // -- tiles: this session, then its quota, context, cache and the account pool --
    const tws = tileWidths(mode, rowWidth)
    // A tile: label and value, a meter as wide as the tile's inside, a caption.
    const tile = (key: string, label: string, value: RenderChildren, meter: (cells: number) => RenderChildren, caption: RenderChildren) => {
      const w = tws[tiles.length % tws.length]!
      return (
        <Box key={key} width={w} paddingX={2} flexDirection="column" backgroundColor={C.tile}>
          <Box justifyContent="space-between">{dim(label)}{value}</Box>
          {meter(w - 4)}
          {caption}
        </Box>
      )
    }
    const used = (m: Meter | undefined) => m ? <Box>{pctText(m.remaining, m.stale)}{dim(' used')}</Box> : dim('—')
    const meterBar = (m: Meter | undefined) => (cells: number) => m ? usedBar(m.remaining, cells, m.stale ? C.dim : sev(m.remaining)) : bar(0, cells, C.track)
    const caption = (t: string) => <Text color={C.dim} wrap="truncate-end">{t}</Text>
    const tiles: RenderChildren[] = []
    // A routed session's route goes with `back` beside it: the controls row has no room for both
    // `back` and `switch`, and `switch` stays, for another account or model.
    tiles.push(
      <Box key="account" width={tws[0]} paddingX={2} flexDirection="column" backgroundColor={C.tile}>
        <Box justifyContent="space-between">
          {dim('Account')}
          <Text bold color={C.fg}>{acctLabel}</Text>
        </Box>
        {route
          ? (
            <Box justifyContent="space-between" gap={1}>
              <Text color={C.aqua} wrap="truncate-end">{`→ ${route.model}`}</Text>
              {sess.remote ? null : link('unroute', 'back', () => sendCommand($, 'unroute', {}, `Back to ${providerTitle(original)}`))}
            </Box>
          )
          : <Text color={C.dim} wrap="truncate-end">{acctNote}</Text>}
        <Box gap={2}>
          {canSwitch ? link('switch', 'switch', toggleSwitch) : null}
          {link('quota', 'quota', () => $.ui.open({ id: PANE, title: 'Accounts and quota' }))}
          {link('view-line', 'less', () => setView('line'))}
        </Box>
      </Box>,
    )
    tiles.push(tile('five', '5-hour', used(five), meterBar(five), caption(five ? resetText(five.reset) : missingText(shownCred, '5h'))))
    tiles.push(tile('week', week?.label ?? 'Weekly', used(week), meterBar(week), caption(week ? resetText(week.reset) : missingText(shownCred, '7d'))))
    tiles.push(tile('ctx', 'Context', ctxLeft != null ? <Box>{pctText(ctxLeft)}{dim(' used')}</Box> : dim('—'),
      cells => ctxLeft != null ? usedBar(ctxLeft, cells, sev(ctxLeft)) : bar(0, cells, C.track),
      <Text wrap="truncate-end"><Text color={C.dim}>{modelName}</Text><Text color={C.dim}>{sess.effort ? ` · ${sess.effort}` : ''}</Text></Text>))
    tiles.push(tile('cache', 'Cache', cacheWord, cells => bar(cacheFrac, cells, cacheColor),
        !working && !ui.busy && offerCacheActions(cs.state, acct)
          ? <Box gap={2}>{link('compact', 'compact', () => setUi($, { confirm: 'compact' }), true)}{link('handoff', 'hand off', () => setUi($, { confirm: 'handoff' }), true)}</Box>
          : caption(isCodex ? 'last request' : cs.state === 'unknown' ? 'after the first reply' : cs.state === 'cold' ? `next turn rewrites ${fmtTokens(cache.prompt)}` : `expires in ${fmtDuration(cs.leftMs)}`)))
    if (mode === 'tiles6' || mode === 'grid') {
      if (all && poolView && all.parts.length) {
        const parts = all.parts
        tiles.push(tile('all', 'Accounts', all.left === null ? dim('—') : <Box>{pctText(all.left, all.stale)}{dim(' used')}</Box>,
          cells => {
            const each = Math.floor((cells - (parts.length - 1)) / parts.length)
            return <Box gap={1}>{parts.map((p, i) => <Box key={`p-${i}`}>{p === null ? bar(0, each, C.track) : usedBar(p, each, sev(p))}</Box>)}</Box>
          },
          caption(nextUp(poolView, poolCurrent, now))))
      } else {
        tiles.push(tile('all', 'Accounts', dim('—'), cells => bar(0, cells, C.track), caption(sess.proxied ? 'no quota data' : 'direct login')))
      }
    }

    return (
      <Box flexDirection="column">
        {top}
        {mode === 'grid' ? (
          <Box key="tiles" flexDirection="column">
            <Box gap={1}>{tiles.slice(0, 3)}</Box>
            <Box gap={1}>{tiles.slice(3)}</Box>
          </Box>
        ) : (
          <Box key="tiles" gap={1}>{tiles}</Box>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [snap, bandError, now0, sess] = await Promise.all([read($, snapA), read($, bandErrorA), read($, nowA), read($, sessA)])
    const now = now0 || Date.now()
    if (!snap) {
      return bandError
        ? <Text color={C.orange}>{`No quota data: ${bandErrorText(bandError)}`}</Text>
        : <Text color={C.dim}>No quota-pilot snapshot found. Is the proxy plugin running?</Text>
    }
    const acct: SessionAccount | null = sessionAccount(snap, sess.id)
    const cols = Math.max(36, e.props.bodyColumns - 1)
    // label, percent, bar, time to reset: the bar takes what is left, up to 24 cells.
    const LABEL = 14
    const PCT = 5
    const RESET = 8
    const barCells = Math.max(6, Math.min(24, cols - LABEL - PCT - RESET - 2))
    const title = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1)
    const rows: RenderChildren[] = []
    for (const [provider, view] of Object.entries(snap.providers)) {
      const health = view.health === 'healthy' ? ['ready', C.green] : view.health === 'exhausted' ? ['used up', C.red] : ['unknown', C.dim]
      rows.push(
        <Box key={`h-${provider}`} marginTop={rows.length ? 1 : 0} width={cols} justifyContent="space-between">
          <Text bold color={C.fg}>{title(provider)}</Text>
          <Text color={health[1]}>{health[0]}</Text>
        </Box>,
      )
      // Every kind any account of the provider reports, so the accounts line up row by row.
      const kinds = [...new Set(view.credentials.flatMap(c => c.windows.map(w => w.kind)))]
        .sort((a, b) => (a === '5h' ? -1 : b === '5h' ? 1 : a === '7d' ? -1 : b === '7d' ? 1 : a.localeCompare(b)))
      for (const c of view.credentials) {
        const mine = acct?.session.auth_id === c.id
        const blocked = c.tier === 3
        rows.push(
          <Box key={`c-${c.id}`} marginTop={1} width={cols} justifyContent="space-between">
            <Text bold color={mine ? C.accent : C.fg}>{c.label}</Text>
            {mine ? <Text color={C.accent}>this session</Text> : null}
          </Box>,
          <Text key={`s-${c.id}`} color={blocked ? C.orange : C.dim} wrap="truncate-end">
            {[c.plan, blocked ? blockedOthers({ ...view, credentials: [c] }, '', now).replace(`${c.label} `, '') : '', !blocked && c.sessions ? `${c.sessions} ${c.sessions === 1 ? 'session' : 'sessions'}` : ''].filter(Boolean).join(' · ') || ' '}
          </Text>,
        )
        for (const kind of kinds) {
          const w = c.windows.find(x => x.kind === kind)
          const left = w ? Math.round(w.remaining * 100) : 0
          const tone = !w || w.stale ? C.dim : sev(left)
          const fill = w ? barFill(1 - w.remaining, barCells) : 0
          const label = w?.label ?? view.credentials.flatMap(x => x.windows).find(x => x.kind === kind)?.label ?? kind
          rows.push(
            <Box key={`w-${c.id}-${kind}`} width={cols}>
              <Box width={LABEL}><Text color={C.dim}>{label}</Text></Box>
              <Box width={PCT} justifyContent="flex-end"><Text bold color={tone}>{w ? `${100 - left}%` : '—'}</Text></Box>
              <Box width={barCells + 2} paddingX={1} flexShrink={0}>
                <Text color={tone}>{'━'.repeat(fill)}</Text>
                <Text color={C.track}>{'━'.repeat(barCells - fill)}</Text>
              </Box>
              <Text color={C.dim} wrap="truncate-end">{w ? untilIso(w.reset_at, now) : 'not reported'}</Text>
            </Box>,
          )
        }
      }
    }
    // What the plugin is set to, in words, as a two-column list.
    const fallbacks = Object.entries(snap.config.fallback_map)
    const age = Math.max(0, now - Date.parse(snap.generated_at))
    const settings: [string, string][] = [
      ...fallbacks.map(([from, to]): [string, string] => {
        const [provider, model] = to.split(':')
        return [`When ${title(from)} is used up`, model ? `use ${model} (${title(provider ?? '')})` : to]
      }),
      ['Switch automatically', snap.config.cross_provider === 'auto' ? 'on' : 'off'],
      ['New sessions avoid', `accounts that have used over ${100 - snap.config.min_five_hour_left_percent}% of their 5-hour quota`],
      ['Updated', age < 30_000 ? 'just now' : `${fmtDuration(age)} ago`],
    ]
    const keyWidth = Math.max(...settings.map(([k]) => k.length)) + 2
    rows.push(<Text key="rule" color={C.track}>{'─'.repeat(cols)}</Text>)
    for (const [k, v] of settings) {
      rows.push(
        <Box key={`set-${k}`} width={cols}>
          <Box width={keyWidth} flexShrink={0}><Text color={C.dim}>{k}</Text></Box>
          <Text wrap="truncate-end">{v}</Text>
        </Box>,
      )
    }
    if (snap.last_error) rows.push(<Text key="err" color={C.orange} wrap="truncate-end">{`last plugin error: ${snap.last_error}`}</Text>)
    return <Box flexDirection="column">{rows}</Box>
  })
}
