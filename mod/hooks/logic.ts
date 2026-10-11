// Pure helpers for the band: no `$`, so the tests call them directly.
import type { BandError, CacheInfo, ModelInfo, Pending, Snap, SnapCred, SnapProvider, SnapSession, SnapWindow } from '../types'

export const C = {
  fg: '#ebdbb2',
  dim: '#928374',
  track: '#504945',
  tile: '#32302f',
  red: '#fb4934',
  orange: '#fe8019',
  yellow: '#fabd2f',
  green: '#b8bb26',
  aqua: '#8ec07c',
  accent: '#d97757',
  warnBg: '#4a2a12',
  infoBg: '#1f3a3d',
  askBg: '#3c3836',
}

/** The colors a drawing uses, by role: the terminal's own, or the desktop app's theme names (DESK). */
export type Palette = { [K in keyof typeof C]: string }

/**
 * The desktop app's theme colors, which follow its light or dark theme: text, its secondary and
 * muted shades, and the fills and tracks of its own usage meters.
 */
export const DESK: Palette = {
  fg: 'text',
  dim: 'inactive',
  track: 'rate_limit_empty',
  tile: 'userMessageBackground',
  red: 'error',
  orange: 'warning',
  yellow: 'warning',
  green: 'success',
  aqua: 'permission',
  accent: 'claude',
  warnBg: 'userMessageBackground',
  infoBg: 'userMessageBackground',
  askBg: 'userMessageBackground',
}

/** Color for a remaining percentage: green when plenty, red when nearly gone. */
export const sevIn = (p: Palette, remainingPct: number): string =>
  remainingPct < 10 ? p.red : remainingPct < 25 ? p.orange : remainingPct < 50 ? p.yellow : p.green
export const sev = (remainingPct: number): string => sevIn(C, remainingPct)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

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

/** "412k", "1.2M", "1M", "830". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** Number of filled cells of a bar. Anything above zero shows at least one cell. */
export function barFill(fraction: number, cells: number): number {
  const f = Math.max(0, Math.min(1, fraction))
  if (f <= 0 || cells <= 0) return 0
  return Math.max(1, Math.round(f * cells))
}

export type CacheState = 'unknown' | 'warm' | 'expiring' | 'cold'

/** Estimated prompt-cache state from the last main-thread response and the TTL in use. */
export function cacheState(cache: CacheInfo, now: number): { state: CacheState; leftMs: number; frac: number } {
  if (!cache.lastAt || !cache.ttlMs) return { state: 'unknown', leftMs: 0, frac: 0 }
  const leftMs = cache.lastAt + cache.ttlMs - now
  const frac = Math.max(0, Math.min(1, leftMs / cache.ttlMs))
  if (leftMs <= 0) return { state: 'cold', leftMs: 0, frac: 0 }
  // The warning starts five minutes before expiry, or in the last quarter of a shorter TTL.
  if (leftMs <= Math.min(5 * MIN, cache.ttlMs / 4)) return { state: 'expiring', leftMs, frac }
  return { state: 'warm', leftMs, frac }
}

/** Share of the last main-thread prompt served from cache, 0..1, or null before any response. */
export function hitRate(cache: CacheInfo): number | null {
  const total = cache.input + cache.read + cache.creation
  return total > 0 ? cache.read / total : null
}

export type Layout = 'tiles6' | 'tiles5' | 'grid' | 'compact'

// Tile widths: the session tile first, then the metric tiles. One column between tiles.
const TILE_MINS = [24, 22, 22, 24, 22, 22]
const TILE_MAX = 48
// Two rows of three: Account, 5-hour, Weekly over Context, Cache, Accounts.
const GRID_MINS = [24, 22, 22]
const minsOf = (mode: TileLayout) => (mode === 'tiles6' ? TILE_MINS : mode === 'tiles5' ? TILE_MINS.slice(0, 5) : GRID_MINS)
export type TileLayout = Exclude<Layout, 'compact'>
const spanOf = (ws: number[]) => ws.reduce((a, b) => a + b, 0) + ws.length - 1

/**
 * Six tiles in a row when they fit, else five without Accounts, else two rows of three when the
 * band has the height, else one row. One row also while Claude works.
 */
export function layout(width: number, maxRows: number, working: boolean): Layout {
  if (working || maxRows < 3) return 'compact'
  if (width >= spanOf(TILE_MINS)) return 'tiles6'
  if (width >= spanOf(TILE_MINS.slice(0, 5))) return 'tiles5'
  return width >= spanOf(GRID_MINS) && maxRows >= 7 ? 'grid' : 'compact'
}

/** Tile widths for a band `width` columns wide: spare columns go one at a time to the narrowest tile. */
export function tileWidths(mode: TileLayout, width: number): number[] {
  const ws = minsOf(mode).slice()
  let spare = width - spanOf(ws)
  while (spare > 0) {
    const narrowest = Math.min(...ws)
    if (narrowest >= TILE_MAX) break
    ws[ws.indexOf(narrowest)]!++
    spare--
  }
  return ws
}

/** Width of the whole row of tiles, which the alert rows share. */
export function tilesSpan(mode: TileLayout, width: number): number {
  return spanOf(tileWidths(mode, width))
}

export type SessionAccount = {
  provider: string
  view: SnapProvider
  cred: SnapCred | undefined
  session: SnapSession
}

/** The snapshot's view of this Claude Code session, when the proxy has seen it. */
export function sessionAccount(snap: Snap | null, sessionId: string): SessionAccount | null {
  const session = snap?.sessions[sessionId]
  if (!snap || !session || !session.provider) return null
  const view = snap.providers[session.provider]
  if (!view) return null
  const cred = view.credentials.find(c => c.id === session.auth_id)
  return { provider: session.provider, view, cred, session }
}

export function windowOf(cred: SnapCred | undefined, kind: string): SnapWindow | undefined {
  return cred?.windows.find(w => w.kind === kind)
}

/** Time until an ISO timestamp, or '' when absent or past. */
export function untilIso(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || t <= now) return ''
  return fmtDuration(t - now)
}

/**
 * Weekly quota left across a provider's accounts, as one percentage, and per account. Disabled
 * accounts stay out, and an account without a reading is unknown (null), not empty; while one is,
 * so is the whole.
 */
export function pooled(view: SnapProvider): { left: number | null; parts: (number | null)[]; stale: boolean } {
  // A second credential of one provider account has no quota of its own.
  const weekly = view.credentials.filter(c => !c.disabled && !c.same_as).map(c => windowOf(c, '7d'))
  const parts = weekly.map(w => (w ? Math.round(w.remaining * 100) : null))
  const known = parts.filter((p): p is number => p !== null)
  return {
    left: known.length && known.length === parts.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
    parts,
    stale: weekly.some(w => w?.stale),
  }
}

/** A window kind as the plugin labels it: "5-hour", "Weekly", "Weekly Fable". */
export function kindLabel(kind: string): string {
  if (kind === '5h') return '5-hour'
  if (kind === '7d') return 'Weekly'
  const family = kind.startsWith('7d_') ? kind.slice(3) : ''
  return family ? `Weekly ${family.charAt(0).toUpperCase()}${family.slice(1)}` : kind
}

/** "7% used", "7%~ used" when stale, "—" without a reading. */
export function usedText(w: SnapWindow | undefined): string {
  return w ? `${Math.round((1 - w.remaining) * 100)}%${w.stale ? '~' : ''} used` : '—'
}

const modelBucket = (model: string) =>
  /opus/i.test(model) ? '7d_opus' : /sonnet/i.test(model) ? '7d_sonnet' : /fable/i.test(model) ? '7d_fable' : ''

/** The weekly window that limits `model` on an account: its own weekly window when lower than the plain one. */
export function weeklyFor(cred: SnapCred | undefined, model: string): SnapWindow | undefined {
  const plain = windowOf(cred, '7d')
  const bucket = modelBucket(model)
  const own = bucket ? windowOf(cred, bucket) : undefined
  return own && (!plain || own.remaining < plain.remaining) ? own : plain
}

/**
 * The model the next turn runs: Claude Code's own choice, which /model changes at once, shown as
 * the full id the proxy last saw for the session when that id is of the same line ("opus" to
 * "claude-opus-5-5").
 */
export function currentModel(ownModel: string, seen: string): string {
  const own = ownModel.replace(/\[1m\]$/, '')
  if (!seen || /^(claude|gpt)-/i.test(own)) return own
  return seen.toLowerCase().includes(own.toLowerCase()) ? seen : own
}

/**
 * Whether the session's next turn goes to another account or provider than the one that answered
 * its last turn, right after a switch, a move or a route: the cache there starts empty.
 */
export function nextTurnMoves(acct: SessionAccount | null): boolean {
  const s = acct?.session
  return Boolean(s?.served_auth_id) && s?.served_auth_id !== s?.auth_id
}

/**
 * The provider's accounts other than `current`'s, each once: a second credential of an account
 * (`same_as`) is that account, not another.
 */
export function otherAccounts(view: SnapProvider, current: string): SnapCred[] {
  const own = view.credentials.find(c => c.id === current)?.same_as || current
  return view.credentials.filter(c => !c.same_as && c.id !== own && c.id !== current)
}

/** The account a new session or a switch would land on next, other than `current`. */
export function nextUp(view: SnapProvider, current: string, now: number): string {
  const others = otherAccounts(view, current).filter(c => !c.disabled)
  const ready = others.find(c => c.tier < 3)
  if (ready) return `next up: ${ready.label} ${usedText(windowOf(ready, '7d'))}`
  // When the window that stops each account resets: the plugin knows which one it is.
  const back = others
    .map(c => ({ c, t: Date.parse(c.back_at ?? '') }))
    .filter(x => Number.isFinite(x.t) && x.t > now)
    .sort((a, b) => a.t - b.t)[0]
  if (back) return `${back.c.label} back in ${fmtDuration(back.t - now)}`
  return others.length ? 'no other account ready' : 'single account'
}

/** Why no other account of the provider can take the session, account by account. */
export function blockedOthers(view: SnapProvider, current: string, now: number): string {
  return view.credentials
    .filter(c => c.id !== current)
    .map(c => {
      if (c.disabled) return `${c.label} disabled`
      const back = untilIso(c.back_at, now)
      return `${c.label} ${c.reason}${back ? `, back in ${back}` : ''}`
    })
    .join('; ')
}

/** "resets in 3h 20m", "resetting now", or "no reset pending". */
export function resetText(reset: string): string {
  if (!reset) return 'no reset pending'
  return reset === 'now' ? 'resetting now' : `resets in ${reset}`
}

/** Accounts the switch list offers: same provider, another account, able to serve the session's next model. */
export function switchTargets(view: SnapProvider, current: string, blocked: readonly string[] = []): SnapCred[] {
  return otherAccounts(view, current).filter(c => c.tier < 3 && !c.unavailable && !blocked.includes(c.id))
}

/**
 * Why the switch list cannot offer an account: what stops it for every model, else what stops it
 * for the session's model alone (that model's own weekly quota used up).
 */
export function cannotTake(c: SnapCred, model: string, now: number): string {
  if (c.disabled || c.unavailable || c.tier >= 3) return blockedOthers({ health: '', credentials: [c] }, '', now)
  const w = weeklyFor(c, model)
  if (w && w.remaining <= 0) {
    const back = untilIso(w.reset_at, now)
    return `${c.label} ${w.label} used up${back ? `, back in ${back}` : ''}`
  }
  return `${c.label} cannot serve ${model} now`
}

/**
 * What a meter without a reading of its window says: the provider said the account has no such
 * window, it has not reported one yet, or the account was never read.
 */
export function missingText(cred: SnapCred | undefined, kind: string): string {
  if (cred?.absent?.includes(kind)) return 'no such limit'
  return cred?.windows.length ? 'not reported yet' : 'after the first reply'
}

/** `key` names what a dismissal hides, for alerts that can be dismissed. */
export type Alert = { level: 'warn' | 'info'; text: string; action?: 'handoff' | 'route' | 'dismiss'; key?: string }

/**
 * The single alert the band shows, most important first. Confirmations and notices are drawn
 * by the caller before this.
 */
export function pickAlert(snap: Snap | null, acct: SessionAccount | null, proxied: boolean, now: number, dismissed = ''): Alert | null {
  if (proxied && snap) {
    const age = now - Date.parse(snap.generated_at)
    if (age > 3 * MIN) return { level: 'warn', text: `quota data is ${fmtDuration(age)} old; is the proxy running?` }
  }
  if (!acct || !snap) return null
  const { session, view, provider } = acct
  if (session.route_note) return { level: 'warn', text: session.route_note, action: 'handoff' }
  if (view.health === 'exhausted' && !session.route) {
    const fallback = snap.config.fallback_map[provider]
    const back = nextUp(view, '', now)
    return {
      level: 'warn',
      text: `${provider} accounts are used up · ${back}`,
      action: fallback ? 'route' : undefined,
    }
  }
  if (session.switch_imminent) {
    // An account read as used up often answers a while longer: the session moves once it refuses.
    const reason = session.switch_reason ?? 'quota low'
    const label = acct.cred?.label ?? 'this account'
    const next = view.credentials.find(c => c.id === session.next_auth_id)
    const when = reason.endsWith('used up') ? `once ${label} stops answering` : 'on the next turn'
    const tail = next ? `moves to ${next.label} (${usedText(windowOf(next, '7d'))}) ${when}` : 'no other account has quota'
    return { level: 'warn', text: `${reason} on ${label} · ${tail}` }
  }
  // A move shows for 15 minutes, or until dismissed, and says why the session left.
  const sw = session.last_switch
  if (sw && sw.at !== dismissed && now - Date.parse(sw.at) < 15 * MIN) {
    const fromCred = view.credentials.find(c => c.id === sw.from)
    const from = fromCred?.label ?? 'previous account'
    const to = view.credentials.find(c => c.id === sw.to)?.label ?? 'another account'
    const why = sw.reason.includes('by user')
      ? 'switched by you'
      : fromCred?.tier === 3 ? `${from} ${fromCred.reason}` : `${from} was unavailable`
    return { level: 'info', text: `Switched ${from} → ${to} · ${why}`, action: 'dismiss', key: sw.at }
  }
  return null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse the snapshot; null when missing, unreadable, of another schema or missing a part the band reads. */
export function parseSnap(text: string): Snap | null {
  try {
    const s = JSON.parse(text) as unknown
    if (!isObject(s) || s.schema_version !== 1 || typeof s.sequence !== 'number') return null
    if (typeof s.boot_id !== 'string' || typeof s.generated_at !== 'string') return null
    if (!isObject(s.config) || !isObject(s.config.fallback_map)) return null
    if (!isObject(s.providers) || !isObject(s.sessions) || !isObject(s.context_lengths) || !Array.isArray(s.acks)) return null
    const providersOk = Object.values(s.providers).every(p => isObject(p) && Array.isArray(p.credentials) &&
      p.credentials.every(c => isObject(c) && typeof c.id === 'string' && Array.isArray(c.windows)))
    return providersOk ? (s as unknown as Snap) : null
  } catch {
    return null
  }
}

/**
 * A repository as its git remote names it, the same on every device and in every worktree:
 * "github.com/owner/name", without credentials or ".git"; "" for none, or a remote on a path of
 * this machine (relative, absolute or file://), which names no repository the same everywhere.
 */
export function repoOf(remote: string | null | undefined): string {
  const r = remote?.trim() ?? ''
  // A URL (https://, ssh://, git://), else scp's form ([user@]host:path); a bare one-letter host
  // is a drive (C:\repos).
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(r)
  const scp = url ? null : /^(?:([^@/:]+)@)?([^@/:\\]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(r)
  const drive = scp && !scp[1] && scp[2]!.length === 1
  const [host, path] = url ? (url[1]!.toLowerCase() === 'file' ? [] : [url[2], url[3]]) : scp && !drive ? [scp[2], scp[3]] : []
  const name = path?.replace(/^(?:\.?\/)+/, '')
  return host && name ? `${host.toLowerCase()}/${name}` : ''
}

/** The proxy's `/band` answer: a snapshot, or why there is none. */
export function readBand(status: number, text: string): { snap: Snap; error: null } | { snap: null; error: BandError } {
  if (status < 200 || status > 299) return { snap: null, error: { kind: 'status', status } }
  const snap = parseSnap(text)
  return snap ? { snap, error: null } : { snap: null, error: { kind: 'body' } }
}

/** Why the band has no quota data from the proxy, in words. */
export function bandErrorText(error: BandError): string {
  if (error.kind === 'network') return `cannot reach the proxy for quota data: ${error.message}`
  if (error.kind === 'body') return "the proxy's quota data is not in a form this band reads; are both the same version?"
  if (error.status === 401) return 'quota data comes once this key has sent a request through the proxy'
  if (error.status === 404) return 'the proxy has no quota-pilot band route (404); is the plugin installed there?'
  return `the proxy answered HTTP ${error.status} for quota data`
}

// A command goes with the band's next read of /band, which answers with its acknowledgement: a
// minute without one means the proxy is not answering.
const PENDING_MS = MIN

/**
 * Pending commands as the snapshot leaves them: its acknowledgement settles one; one sent to an
 * earlier run of the proxy will not be acknowledged, as acknowledgements do not survive a
 * restart; one unanswered for a minute expires. `notice` tells the last outcome, null for none.
 */
export function settlePending(pending: readonly Pending[], snap: Snap | null, now: number): {
  left: Pending[]
  notice: { text: string; isError: boolean } | null
} {
  const left: Pending[] = []
  let notice: { text: string; isError: boolean } | null = null
  for (const p of pending) {
    const ack = snap?.acks.find(a => a.command_id === p.id)
    if (ack) {
      notice = ack.status === 'applied'
        ? { text: `${p.text}: done`, isError: false }
        : { text: `${p.text}: ${ack.reason ?? 'rejected'}`, isError: true }
    } else if (snap && snap.boot_id !== p.boot) {
      notice = { text: `${p.text}: the proxy restarted before confirming it`, isError: true }
    } else if (now - p.at > PENDING_MS) {
      notice = { text: `${p.text}: no answer from the proxy; is it running?`, isError: true }
    } else {
      left.push(p)
    }
  }
  return { left, notice }
}

/**
 * TTL the main conversation's cache uses: the override, else 5 minutes for a session that sends a
 * key (a proxy's client key, an API key) and an hour for one signed in to a subscription, as the
 * desktop app's sessions are.
 */
export function cacheTtlMs(override: string | undefined, keyed: boolean): number {
  if (override === '1h') return HOUR
  if (override === '5m') return 5 * MIN
  return keyed ? 5 * MIN : HOUR
}

export const HANDOFF_PROMPT = [
  'Write a handoff note so a new session can carry on this work without this conversation.',
  'Use these sections, in this order, each as a markdown heading:',
  'Goal (what the user wants, and why);',
  'Done (what was finished, and how it was verified);',
  'Not done (what is left, and what was tried that failed);',
  'Changes (each file touched, and what changed in it);',
  'Watch out (decisions made and why, and the limits and preferences the user stated, in their words where it matters);',
  'Next step (the one exact next action).',
  'Be specific: paths, commands, names, numbers. Write in the language the user writes in. No preamble.',
].join(' ')

/** Whether a base URL is Anthropic's own API, as the desktop app's sessions sign in to directly: no proxy is there. */
export function isAnthropicHost(base: string | undefined): boolean {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(base?.trim() ?? '')?.[1]?.toLowerCase() ?? ''
  return /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/.test(host)
}

/**
 * What the band's settings are, from the plugin's `userConfig` values, each kept in its range:
 * the context share at which it suggests a handoff, the conversation size from which a message
 * that would start cold waits to be confirmed, and how many times the cache is kept warm while
 * idle. 0 turns each off.
 */
export type Settings = { handoffAt: number; confirmAbove: number; keepWarm: number }

export function settingsOf(options: Readonly<Record<string, unknown>>): Settings {
  const num = (key: string, fallback: number, max: number) => {
    const v = Number(options[key] ?? fallback)
    return Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : fallback
  }
  return { handoffAt: num('handoffAt', 60, 100), confirmAbove: num('confirmColdAbove', 100_000, 10_000_000), keepWarm: num('keepWarm', 3, 10) }
}

/**
 * What a million tokens cost at API prices: written to the cache for five minutes or an hour, and
 * read from it. `over` names the prompt size above which `long` applies. Checked on 2026-10-11
 * against platform.claude.com/docs/en/about-claude/pricing and
 * developers.openai.com/api/docs/pricing (Standard); a model not listed shows tokens only.
 */
type Price = { write5m: number; write1h: number; read: number }
type PriceRow = { price: Price; over?: number; long?: Price }
const claude = (write5m: number, write1h: number, read: number): Price => ({ write5m, write1h, read })
// OpenAI's cache has one write price; its long context is a prompt over 272k tokens.
const openai = (write: number, read: number): PriceRow => ({
  price: { write5m: write, write1h: write, read },
  over: 272_000,
  long: { write5m: write * 2, write1h: write * 2, read: read * 2 },
})
const PRICES: [RegExp, PriceRow][] = [
  [/^claude-(fable|mythos)-5-1$/, { price: claude(12.5, 20, 0.25) }],
  [/^claude-(fable|mythos)-5$/, { price: claude(12.5, 20, 1) }],
  [/^claude-opus-5-5$/, { price: claude(5, 8, 0.2) }],
  [/^claude-opus-(5|4-[5-8])$/, { price: claude(6.25, 10, 0.5) }],
  [/^claude-opus-4(-1)?$/, { price: claude(18.75, 30, 1.5) }],
  [/^claude-sonnet-5-5$/, { price: claude(2.5, 4, 0.1) }],
  [/^claude-sonnet-5$/, { price: claude(2.5, 4, 0.2) }],
  [/^claude-sonnet-4(-[56])?$/, { price: claude(3.75, 6, 0.3) }],
  [/^claude-haiku-5-5$/, { price: claude(0.125, 0.2, 0.01), over: 100_000, long: claude(0.625, 1, 0.05) }],
  [/^claude-haiku-4-5$/, { price: claude(1.25, 2, 0.1) }],
  [/^gpt-6-astra$/, openai(12.5, 1)],
  [/^gpt-6\.1-sol$/, openai(2.5, 0.1)],
  [/^gpt-6-sol$/, openai(2.5, 0.2)],
  [/^gpt-6-luna$/, openai(0.125, 0.01)],
  [/^gpt-5\.6-sol$/, openai(5, 0.4)],
  [/^gpt-5\.6-terra$/, openai(2.5, 0.2)],
  [/^gpt-5\.6-luna$/, openai(0.25, 0.02)],
  // Older models charge nothing extra for a cache write: a miss costs the input price.
  [/^gpt-5\.5$/, openai(5, 0.5)],
  [/^gpt-5\.4$/, openai(2.5, 0.25)],
]

/**
 * What resending `tokens` of conversation to `model` costs at API prices: cold, all written to
 * the cache again (at the price of the TTL in use), or warm, all read from it. Null for a model
 * without a known price.
 */
export function turnCost(model: string, tokens: number, ttlMs: number): { cold: number; warm: number } | null {
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
  const row = PRICES.find(([re]) => re.test(id))?.[1]
  if (!row || tokens <= 0) return null
  const p = row.over && row.long && tokens > row.over ? row.long : row.price
  const write = ttlMs > 5 * MIN ? p.write1h : p.write5m
  return { cold: (tokens * write) / 1e6, warm: (tokens * p.read) / 1e6 }
}

/** "$3.30", "$12", "<$0.01". */
export function fmtUsd(n: number): string {
  if (n < 0.01) return '<$0.01'
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`
}

/** "rewrites 412k tokens, ≈$3.30 at API prices ($0.08 warm)", or the tokens alone without a price. */
export function rewriteText(tokens: number, cost: { cold: number; warm: number } | null): string {
  const base = `rewrites ${fmtTokens(tokens)} tokens`
  return cost ? `${base}, ≈${fmtUsd(cost.cold)} at API prices (${fmtUsd(cost.warm)} warm)` : base
}

/** Whether two names are one model: an alias (`opus`, `sonnet[1m]`) is the line of the full id it is part of. */
export function sameModel(a: string, b: string): boolean {
  const clean = (m: string) => m.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
  const x = clean(a)
  const y = clean(b)
  return x === y || (!/^(claude|gpt)-/.test(x) && y.includes(x)) || (!/^(claude|gpt)-/.test(y) && x.includes(y))
}

/**
 * Why the session's next turn finds nothing cached, when it will: its account or provider
 * changed since the last reply (a switch, a move, a route), its model did (`/model`), or the
 * cache's time ran out. `key` names this cold spell, so a dismissal or a confirmation holds
 * until the next one; `tokens` is what the next turn resends.
 */
export type ColdTurn = { reason: 'moved' | 'model' | 'expired'; why: string; key: string; tokens: number }

/**
 * The key of the cold spell a move to account `to` makes, known before the move, so a move the
 * reader chose is not asked about again; `*` for a route or going back from one, whichever account
 * the proxy then picks.
 */
export const movedKey = (cache: CacheInfo, to: string) => `moved:${cache.lastAt}:${to}`

/** Whether a cold spell is the one the reader confirmed (or dismissed) by `key`. */
export function coldConfirmed(cold: ColdTurn, key: string): boolean {
  return cold.key === key || (key.endsWith(':*') && cold.key.startsWith(key.slice(0, -1)))
}

/**
 * `asked` is the model Claude Code asks for, as `/model` set it: a route serves another, which
 * the move to its account already tells.
 */
export function coldTurn(cache: CacheInfo, acct: SessionAccount | null, asked: string, now: number): ColdTurn | null {
  const tokens = cache.prompt
  if (tokens <= 0) return null
  const s = acct?.session
  // A route to another model of the same account moves nothing the proxy tells, but what the
  // last reply's route was, as the band saw it then.
  const rerouted = s && cache.route !== null && (s.route?.model ?? '') !== cache.route
  if (s && (nextTurnMoves(acct) || rerouted)) {
    const label = acct?.view.credentials.find(c => c.id === s.auth_id)?.label ?? 'another account'
    return { reason: 'moved', why: s.route ? `routed to ${s.route.model}` : `moved to ${label}`, key: movedKey(cache, s.auth_id), tokens }
  }
  if (cache.model && asked && !sameModel(asked, cache.model)) {
    const name = asked.replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '')
    return { reason: 'model', why: `model changed to ${name}`, key: `model:${asked}:${cache.lastAt}`, tokens }
  }
  const cs = cacheState(cache, now)
  if (cs.state === 'cold') {
    const ago = now - cache.lastAt - cache.ttlMs
    return { reason: 'expired', why: `cache expired${ago > MIN ? ` ${fmtDuration(ago)} ago` : ''}`, key: `expired:${cache.lastAt}`, tokens }
  }
  return null
}

/**
 * When the cache is next kept warm, while idle: shortly before it would expire (five minutes, or a
 * fifth of a shorter TTL), so a refresh reads it while it is still there.
 */
export function warmDueAt(cache: CacheInfo): number {
  if (!cache.lastAt || !cache.ttlMs) return 0
  return cache.lastAt + cache.ttlMs - Math.min(5 * MIN, cache.ttlMs / 5)
}

/**
 * The account a new session of `provider` would get: the one the plugin ranks first for the model
 * the band named in its read, else the first in its routing order.
 */
export function likelyAccount(snap: Snap | null, provider: string): { provider: string; cred: SnapCred } | null {
  const view = snap?.providers[provider]
  const cred = view?.credentials.find(c => c.id === snap?.expected?.[provider]) ?? view?.credentials[0]
  return cred ? { provider, cred } : null
}

/** Who publishes each provider's models in the proxy's /v1/models list. Add a provider once its owner is seen there. */
const MODEL_OWNER: Record<string, string> = { claude: 'anthropic', codex: 'openai' }

/** "Codex", "Claude". */
export const providerTitle = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1)

/**
 * The provider a model belongs to, by its owner. Claude Code names its own models by alias too
 * (`opus`, `opus[1m]`, `sonnet`, `opusplan`, `default`), with a suffix such as `[1m]`.
 */
export function providerOfModel(model: string): string {
  const id = model.trim().replace(/\[[^\]]*\]$/, '')
  if (/^(gpt-|codex)/i.test(id)) return 'codex'
  return /^(claude-|opus|sonnet|haiku|fable)|^(default|best)$/i.test(id) ? 'claude' : ''
}

/** A model id as a product line and a version: gpt-6.1-sol is line gpt-sol, version 6.1. */
function modelLine(id: string): { line: string; version: number } | null {
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/.exec(id)
  if (gpt) return { line: `gpt-${gpt[2] ?? ''}`, version: Number(gpt[1]) }
  // claude-opus-5-5, claude-fable-5-1, claude-sonnet-5; dated snapshots are left out.
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d))?$/.exec(id)
  if (claude) return { line: `claude-${claude[1]}`, version: Number(claude[2]) + Number(claude[3] ?? 0) / 10 }
  return null
}

/** The newest model of each product line of a provider, newest first, at most `n`. */
export function latestModels(models: ModelInfo[], provider: string, n = 3): string[] {
  const owner = MODEL_OWNER[provider]
  if (!owner) return []
  const best = new Map<string, { id: string; version: number }>()
  for (const m of models) {
    if (m.owned_by !== owner) continue
    const parsed = modelLine(m.id)
    if (!parsed) continue
    const current = best.get(parsed.line)
    if (!current || parsed.version > current.version) best.set(parsed.line, { id: m.id, version: parsed.version })
  }
  return [...best.values()]
    .sort((a, b) => b.version - a.version || a.id.localeCompare(b.id))
    .slice(0, n)
    .map(m => m.id)
}

/** The proxy's /v1/models answer; null when it is not one. */
export function parseModels(text: string): ModelInfo[] | null {
  try {
    const body = JSON.parse(text) as unknown
    if (!isObject(body) || !Array.isArray(body.data)) return null
    return body.data
      .filter((m): m is Record<string, unknown> => isObject(m) && typeof m.id === 'string')
      .map(m => ({ id: m.id as string, owned_by: typeof m.owned_by === 'string' ? m.owned_by : '', created: typeof m.created === 'number' ? m.created : 0 }))
  } catch {
    return null
  }
}

