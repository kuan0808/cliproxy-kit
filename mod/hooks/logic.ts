// Pure helpers for the band: no `$`, so the tests call them directly.
import type { CacheInfo, ModelInfo, Snap, SnapCred, SnapProvider, SnapSession, SnapWindow } from '../types'

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

/** Color for a remaining percentage: green when plenty, red when nearly gone. */
export const sev = (remainingPct: number): string =>
  remainingPct < 10 ? C.red : remainingPct < 25 ? C.orange : remainingPct < 50 ? C.yellow : C.green

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
  const weekly = view.credentials.filter(c => !c.disabled).map(c => windowOf(c, '7d'))
  const parts = weekly.map(w => (w ? Math.round(w.remaining * 100) : null))
  const known = parts.filter((p): p is number => p !== null)
  return {
    left: known.length && known.length === parts.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
    parts,
    stale: weekly.some(w => w?.stale),
  }
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

/** The account a new session or a switch would land on next, other than `current`. */
export function nextUp(view: SnapProvider, current: string, now: number): string {
  const others = view.credentials.filter(c => c.id !== current && !c.disabled)
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

/** Accounts the switch list offers: same provider, not the current one, able to serve. */
export function switchTargets(view: SnapProvider, current: string): SnapCred[] {
  return view.credentials.filter(c => c.id !== current && c.tier < 3 && !c.unavailable)
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

/** Whether the compact and handoff buttons are offered: a cache rewrite is coming and still avoidable. */
export function offerCacheActions(state: CacheState, acct: SessionAccount | null): boolean {
  return state === 'expiring' || state === 'cold' || Boolean(acct?.session.switch_imminent)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse the snapshot file; null when missing, unreadable, of another schema or missing a part the band reads. */
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

/** TTL the main conversation's cache uses: the override, else 1 hour on a subscription, 5 minutes on a key. */
export function cacheTtlMs(override: string | undefined, proxied: boolean): number {
  if (override === '1h') return HOUR
  if (override === '5m') return 5 * MIN
  return proxied ? 5 * MIN : HOUR
}

export const HANDOFF_PROMPT = [
  'Write a handoff note so a new session can continue this work without the transcript.',
  'Cover: the goal, decisions made and why, current state of the code and files touched,',
  'what was verified and how, open problems, and the exact next step.',
  'Be specific with paths, commands and names. Plain markdown, no preamble.',
].join(' ')

/** The account a new session of `provider` would get: first in the plugin's routing order. */
export function likelyAccount(snap: Snap | null, provider: string): { provider: string; cred: SnapCred; total: number } | null {
  if (!snap || !provider) return null
  const view = snap.providers[provider]
  const cred = view?.credentials[0]
  return view && cred ? { provider, cred, total: view.credentials.length } : null
}

/** Who publishes each provider's models in the proxy's /v1/models list. Add a provider once its owner is seen there. */
const MODEL_OWNER: Record<string, string> = { claude: 'anthropic', codex: 'openai' }

/** "Codex", "Claude". */
export const providerTitle = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1)

/** The provider a model id belongs to, by its owner. */
export function providerOfModel(model: string): string {
  return /^(gpt-|codex)/i.test(model) ? 'codex' : /^claude-/i.test(model) ? 'claude' : ''
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

