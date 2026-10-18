// Every row the band shows above its cards, in words: the one wording table (spec, "Band and
// page states"). The rows' text, short form and kind come from here and nowhere else; the Codex
// notice in the plugin says the moves in the same words (tests/moves.js holds both sides').
import type { BandError, SnapCause, SnapSwitch } from '../types'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** A row's words: in full, and as a whole in fewer, for a band too narrow for them. */
export type Words = { text: string; short?: string }

/** "3h 20m", "1d 3h", "52m", "now". */
export function fmtDuration(ms: number): string {
  if (ms <= 30_000) return 'now'
  const total = Math.round(ms / MIN)
  const d = Math.floor(total / (DAY / MIN))
  const h = Math.floor((total % (DAY / MIN)) / 60)
  const m = total % 60
  if (d > 0) return `${d}d ${h}h`
  if (h >= 10 || (h > 0 && m === 0)) return `${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${Math.max(1, m)}m`
}


/** "45s", "2m 15s", "2m", "1h 5m": a wait as long as the seconds matter. */
export function fmtWait(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`
  const m = Math.round(s / 60)
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`
}

const times = (n: number | undefined) => (n && n > 1 ? (n === 2 ? ' twice' : ` ${n} times`) : '')

/**
 * Why a session left `from`, worded from its switch record and never from the account's state
 * now: `why` for the row, `short` for a narrow one. The Codex notice says the same words
 * (tests/moves.js holds both sides' expected wording). A record from an older plugin says only
 * what it can confirm.
 */
export function moveWhy(sw: SnapSwitch, from: string, now: number): { why: string; short: string } {
  const c = sw.cause ?? {}
  const status = c.status ? ` (HTTP ${c.status})` : ''
  const said = (why: string, short = why.split('; ')[0]!) => ({ why, short })
  if (sw.kind === 'rest') {
    // The failures that rested it, while their kind agrees, and when it is tried again.
    const left = Date.parse(c.until ?? '') - now
    const what = c.kind ? failedWhy(c, from) : `${from} resting after ${c.count ?? 2} failures`
    return left > 0 ? { why: c.kind ? `${what}; resting, back in ${fmtDuration(left)}` : what, short: `${from} resting` } : said(what)
  }
  switch (sw.kind) {
    case undefined:
    case '':
      if (sw.reason.includes('by user')) return said('switched by you')
      return said(sw.reason.startsWith('moved while idle') ? 'moved while idle' : 'reason not recorded')
    case 'user':
      return said('switched by you')
    case 'quota':
      return said(`${from} ${c.reason || 'quota used up'}`)
    case 'idle':
      return said(c.reason ? `${from} ${c.reason}; moved while idle` : 'moved while idle')
    case 'gone':
      return said(c.reason === 'disabled' ? `${from} is disabled` : `${from} was removed`)
    case 'sign-in':
      return said(`${from} refused sign-in${status}`)
    case 'model':
      return said(`${from} cannot serve ${(c.model ?? 'this model').replace(/^claude-/, '')}`)
    case 'left-out':
      return said(`the proxy left ${from} out; no failure recorded`, 'reason unknown')
  }
  return said(failedWhy(c, from) + retryTail(c), c.kind === 'hang' ? `${from} hung` : undefined)
}

/** How the last retry failed, when that says more than its count: "; the retry got no answer". */
function retryTail(c: NonNullable<SnapSwitch['cause']>): string {
  const r = c.last_retry
  if (!r || (r.kind === c.kind && r.kind !== 'request')) return ''
  if (r.kind === 'request') return r.answered ? '; the retry was cancelled' : '; the retry got no answer'
  return `; ${failedWhy({ ...r, count: 1 }, 'the retry')}`
}

/** What a failure, or a run of failures of one kind, did: "d••• returned HTTP 529 twice". */
function failedWhy(c: NonNullable<SnapSwitch['cause']>, from: string): string {
  const n = times(c.count)
  switch (c.kind) {
    case 'hang':
      return n ? `${from} hung${n}` : `${from} hung for ${fmtWait(c.wait_ms ?? 0)}`
    case 'connection':
      return `${from} lost its connection${n}`
    case 'timeout':
      return `${from} timed out${n}`
    case 'overloaded':
      return `${from} returned HTTP ${c.status || 529}${n}`
    case 'server':
      return `${from} returned HTTP ${c.status}${n}`
    case 'rate':
      return `${from} was rate-limited${n}`
  }
  return `${from} failed${c.status ? ` (HTTP ${c.status})` : ''}${n}`
}


/** What a failure did, as a live row says it: "returned HTTP 529", "hung for 2m 15s". */
export function failurePhrase(c: SnapCause): string {
  switch (c.kind) {
    case 'hang':
      return `hung for ${fmtWait(c.wait_ms ?? 0)}`
    case 'connection':
      return 'lost its connection'
    case 'timeout':
      return 'timed out'
    case 'rate':
      return 'was rate-limited'
  }
  return c.status ? `returned HTTP ${c.status}` : 'failed'
}

const shortFailure = (c: SnapCause) => (c.kind === 'hang' ? 'hung' : failurePhrase(c))

/** The tail of a live row: who takes over if the retry fails, or that nobody can. */
const nextTail = (next: string | undefined, noQuota: boolean) => (next ? `; ${next} is next if needed` : noQuota ? '; no other account has quota' : '')

/** What happened before a retry that worked: "HTTP 529", "a lost connection", "a 2m 15s hang". */
function before(c: SnapCause): string {
  switch (c.kind) {
    case 'hang':
      return `a ${fmtWait(c.wait_ms ?? 0)} hang`
    case 'connection':
      return 'a lost connection'
    case 'timeout':
      return 'a timeout'
    case 'rate':
      return 'a rate limit'
  }
  return c.status ? `HTTP ${c.status}` : 'a failure'
}

/** Why the band has no quota data from the proxy. */
export function bandErrorText(error: BandError): string {
  if (error.kind === 'network') return `cannot reach the proxy for quota data: ${error.message}`
  if (error.kind === 'body') return "the proxy's quota data is not in a form this band reads; are both the same version?"
  if (error.status === 401) return 'quota data comes once this key has sent a request through the proxy'
  if (error.status === 404) return 'the proxy has no quota-pilot band route (404); is the plugin installed there?'
  return `the proxy answered HTTP ${error.status} for quota data`
}

export const W = {
  // Questions.
  handoffAsk: (held: boolean) => ({
    title: 'Hand off to a new session?',
    detail: `Claude writes a summary (goal, done, not done, changes, watch out, next step) and saves it; this conversation clears and a new one starts from the summary${held ? ', with your message after it' : ''}.`,
  }),
  /** A message held before a cold turn: why it starts cold and what that rewrites. */
  held: (why: string, rewrite: string, cost: string): Words & { title: string; detail: string } => ({
    title: 'Message held', detail: `next turn starts cold (${why}): ${rewrite}`, text: '', short: `Message held: starts cold${cost ? `, ≈${cost}` : ''}`,
  }),
  moveAsk: (what: string, rewrite: string, brief: string) => ({ title: `${what}?`, detail: `The next turn then starts cold: it ${rewrite}.`, brief: `then starts cold: ${brief}` }),
  switchMenu: 'Switch this session to:',
  modelMenu: (provider: string) => `${provider} model`,
  // Notes of the band's own.
  coldTurn: (why: string, rewrite: string, brief: string) => ({ title: 'Next turn starts cold', detail: `${why}; it ${rewrite}`, brief: `${why}; ${brief}` }),
  context: (used: number) => ({ title: `Context ${used}% used`, detail: 'hand off to a new session that starts from a summary?' }),
  // The proxy's alerts.
  stale: (age: string): Words => ({ text: `quota data is ${age} old; is the proxy running?` }),
  exhausted: (provider: string, back: string): Words => ({ text: `${provider} accounts are used up · ${back}` }),
  /** An account read as used up: the session moves once it refuses, or at the next turn. */
  limited: (reason: string, label: string, next: string | null, used: string, when: string): Words => ({
    text: `${reason} on ${label} · ${next ? `moves to ${next} (${used}) ${when}` : 'no other account has quota'}`,
  }),
  /** A move certain at the next turn: the account rests, or its retry got no answer. */
  movesNext: (label: string, reason: string, next: string, used: string): Words => ({
    text: `${label} ${reason} · moves to ${next} (${used}) on the next turn`,
    short: reason.startsWith('resting') ? `${label} resting · moves to ${next} next turn` : `${label} ${reason} · moves next turn`,
  }),
  /** Waiting to retry the bound account: what failed, when it is tried, who takes over. */
  waiting: (from: string, cause: SnapCause, inMs: number, pastGiveUp: boolean, giveUpS: number, next: string | undefined, noQuota: boolean): Words => {
    const when = pastGiveUp ? `waiting up to ${giveUpS}s for it` : inMs < 1000 ? 'retrying it now' : `retrying it in about ${Math.round(inMs / 1000)}s`
    const brief = pastGiveUp ? `waiting up to ${giveUpS}s` : inMs < 1000 ? 'retrying now' : `retrying in ${Math.round(inMs / 1000)}s`
    return { text: `${from} ${failurePhrase(cause)} · ${when}${nextTail(next, noQuota)}`, short: `${from} ${failurePhrase(cause)} · ${brief}` }
  },
  /** A retry of the bound account running: how long so far. */
  running: (from: string, cause: SnapCause, forMs: number, next: string | undefined, noQuota: boolean): Words => ({
    text: `${from} ${failurePhrase(cause)} · retrying it, ${fmtWait(forMs)} so far${nextTail(next, noQuota)}`,
    short: `${from} ${shortFailure(cause)} · retrying it, ${fmtWait(forMs)} so far`,
  }),
  /** The band's own step has had no answer: it names no account, and promises no retry. */
  hangWatch: (forMs: number, takeover: boolean): Words => (takeover
    ? { text: `no answer for ${fmtWait(forMs)} · if it fails, a retry or another account takes over`, short: `no answer for ${fmtWait(forMs)}` }
    : { text: `no answer for ${fmtWait(forMs)}` }),
  // Notes.
  moved: (from: string, to: string, why: { why: string; short: string }): Words => ({ text: `Switched ${from} → ${to} · ${why.why}`, short: `Switched ${from} → ${to} · ${why.short}` }),
  // What came of an action: a move the band sent (named by `switchTo`, `routeTo` or `backTo`), a
  // handoff, a held message.
  switchTo: (to: string) => `Switch to ${to}`,
  routeTo: (model: string) => `Route to ${model}`,
  backTo: (provider: string) => `Back to ${provider}`,
  sending: (what: string) => `${what}…`,
  done: (what: string) => `${what}: done`,
  refused: (what: string, reason = 'rejected') => `${what}: ${reason}`,
  restarted: (what: string) => `${what}: the proxy restarted before confirming it`,
  unanswered: (what: string) => `${what}: no answer from the proxy; is it running?`,
  pluginDown: 'The proxy plugin is not running',
  handoffBusy: 'The band was busy: try the handoff again in a moment',
  writingNote: (own: boolean) => `Writing the handoff note${own ? ' with your prompt' : ''}…`,
  noNote: (why: string) => `Handoff stopped: no note (${why}); the conversation is kept`,
  noteNotSaved: 'Handoff stopped: the note could not be saved; the conversation is kept',
  noteKept: (at: string, why: 'changed' | 'not cleared' | 'another first') =>
    `Note saved at ${at}; ${why === 'changed' ? 'the conversation changed or went on while it was written, so it was not cleared' : why === 'not cleared' ? 'the conversation was not cleared' : 'another conversation came first, so the note was not sent'}`,
  handedOff: (at: string) => `Handed off: the new session starts from ${at}`,
  newSession: (at: string, filled: boolean) => (filled ? 'New session ready: the note is in the prompt; press Enter to start' : `New session started. Note saved at ${at}`),
  handoffFailed: (err: string, saved: string) => `Handoff failed: ${err}${saved ? `; the note is at ${saved}` : ''}`,
  handoffReloaded: 'The band reloaded during a handoff; the conversation is kept',
  sendFromBox: 'Press Enter to send it: a message that names files with @ goes from the prompt box',
  notSent: (drop: string | undefined) => `Not sent${drop ? `: ${drop}` : ''}; the message is back in the prompt`,
  /** A retry that worked: the session stayed, with its cache when the request read it. */
  kept: (from: string, cause: SnapCause, afterMs: number, cacheRead: number): Words => {
    const later = cause.status && afterMs >= 1000 ? ` ${Math.round(afterMs / 1000)}s later` : ''
    return { text: `Stayed on ${from} after ${before(cause)} · the retry${later} worked${cacheRead > 0 ? '; cache kept' : ''}`, short: `Stayed on ${from} · retry worked` }
  },
}
