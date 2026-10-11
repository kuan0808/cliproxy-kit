// What the band shows, whichever surface draws it: the terminal's cells and the desktop app's
// cards read the same facts and the same row above them, with the same actions behind them.
import type { BandError, CacheInfo, ModelInfo, Move, SessionInfo, Snap, UiState } from '../types'
import {
  bandErrorText,
  cacheState,
  cannotTake,
  coldConfirmed,
  coldTurn,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  currentModel,
  latestModels,
  likelyAccount,
  missingText,
  nextUp,
  otherAccounts,
  pickAlert,
  pooled,
  providerOfModel,
  providerTitle,
  rewriteText,
  sessionAccount,
  switchTargets,
  turnCost,
  untilIso,
  usedText,
  weeklyFor,
  windowOf,
  hitRate,
  type CacheState,
  type ColdTurn,
  type SessionAccount,
  type Settings,
} from './logic'

export type Meter = { remaining: number; reset: string; stale: boolean; label: string }

/**
 * A control: pressed, it runs `run`; one without `run` is a note in its place, drawn dim. A
 * `name` label (an account, a model) is drawn as written, never recased.
 */
export type Act = { key: string; label: string; run?: () => unknown; main?: boolean; name?: true }

/**
 * The row above the band: a question (`ask`), what came of an action (`notice`) or an alert. The
 * terminal draws `title: detail` on one line; the desktop app sets the title apart.
 */
export type Row = {
  key: 'ask' | 'notice' | 'alert'
  tone: 'ask' | 'warn' | 'info'
  title: string
  detail: string
  acts: Act[]
  /** Something runs meanwhile: the row has no way to close it. */
  busy?: boolean
  /** Closes the row; the desktop app draws it as its close control. */
  close?: Act
}

/**
 * What a handoff carries on with: a message for the new session after the note (taken from the
 * prompt box when `fromBox`, where a held message went back and may have been edited), and a move
 * for the new session.
 */
export type Handoff = { held?: string; fromBox?: true; move?: Move }

/** What the band's controls do, from the module that holds its state; each settles when done. */
export type Do = {
  ui: (patch: Partial<UiState>) => unknown
  send: (move: Move) => unknown
  handoff: (then: Handoff) => unknown
  sendHeld: () => unknown
  quota: () => unknown
}

export type BandInput = {
  snap: Snap | null
  bandError: BandError | null
  now: number
  sess: SessionInfo
  cache: CacheInfo
  ui: UiState
  models: ModelInfo[]
  settings: Settings
  working: boolean
}

export type Facts = {
  /** Through the proxy; else signed in to Claude directly (the desktop app), with no accounts to show or switch. */
  proxied: boolean
  acct: SessionAccount | null
  /** The account: this session's, the one a new session gets, or claude.ai on a direct login; and a note. */
  account: string
  note: string
  /** The route's model, '' when the session is not routed. */
  route: string
  /** The model the next turn runs, as the proxy names it; and as the band shows it ("opus-5-5 1M"). */
  model: string
  modelName: string
  effort: string
  isCodex: boolean
  five?: Meter
  week?: Meter
  fiveMissing: string
  weekMissing: string
  ctx: { used: number; window: number; left: number } | null
  cache: {
    state: CacheState
    leftMs: number
    frac: number
    /** Codex's cache reads as the share of the last prompt it served. */
    rate: number | null
    cold: ColdTurn | null
    cost: { cold: number; warm: number } | null
    tokens: number
    warmed: number
    keepWarm: number
  }
  pool: { left: number | null; parts: (number | null)[]; stale: boolean; caption: string } | null
  controls: { switch?: Act; unroute?: Act; quota: Act }
  top: Row | null
}

/** A cold turn over less than this is not worth a word. */
const COLD_NOTICE_FLOOR = 20_000

/**
 * What the next turn finds of the cache: the session's account, the model that serves it, why it
 * starts cold (null when it does not) and what that costs. The band shows it, the send guard and
 * keeping warm decide by it.
 */
export function nextTurn(i: BandInput): { acct: SessionAccount | null; model: string; isCodex: boolean; cold: ColdTurn | null; cost: { cold: number; warm: number } | null } {
  const { snap, sess, cache, now } = i
  const acct = sess.proxied ? sessionAccount(snap, sess.id) : null
  // A routed session runs the route's model; otherwise the model is Claude Code's own, which
  // /model changes before any reply.
  const route = acct?.session.route
  const seen = acct?.session.requested_model || (acct?.provider === 'claude' ? acct.session.model : '')
  const model = route ? route.model : currentModel(sess.model, seen || cache.model)
  const isCodex = acct?.provider === 'codex'
  // Codex's cache keeps no time the band knows: only a move makes its next turn cold. The model
  // compared is the one Claude Code asks for; a route's is told by the move.
  const cold = coldTurn(isCodex ? { ...cache, ttlMs: 0 } : cache, acct, sess.model, now)
  return { acct, model, isCodex, cold, cost: turnCost(model, cache.prompt, cache.ttlMs) }
}

export function bandFacts(i: BandInput, act: Do): Facts {
  const { snap, bandError, now, sess, cache, ui, models, settings } = i
  const { acct, model, isCodex, cold, cost } = nextTurn(i)
  const route = acct?.session.route
  const ctxWindow = route && snap?.context_lengths[route.model] ? snap.context_lengths[route.model]! : sess.contextWindow
  const ctx = sess.contextTokens != null && ctxWindow > 0
    ? { used: sess.contextTokens, window: ctxWindow, left: Math.max(0, 100 - (sess.contextTokens / ctxWindow) * 100) }
    : null
  const longContext = !route && /\[1m\]$/.test(sess.model) ? ' 1M' : ''

  const meterOf = (w: { remaining: number; reset_at?: string; stale: boolean; label: string } | undefined): Meter | undefined =>
    w ? { remaining: w.remaining * 100, reset: untilIso(w.reset_at, now), stale: w.stale, label: w.label } : undefined
  let five: Meter | undefined
  let week: Meter | undefined
  let account = ''
  let note = ''
  const likely = sess.proxied && !acct?.cred ? likelyAccount(snap, acct?.provider ?? providerOfModel(sess.model)) : null
  if (acct?.cred) {
    account = acct.cred.label
    // The plan only: a move is told once, by the row above the band.
    note = acct.cred.plan ?? ''
    five = meterOf(windowOf(acct.cred, '5h'))
    week = meterOf(weeklyFor(acct.cred, model))
  } else if (likely) {
    // Before the proxy has seen this session: the account a new session gets.
    account = likely.cred.label
    note = [likely.cred.plan, 'expected'].filter(Boolean).join(' · ')
    five = meterOf(windowOf(likely.cred, '5h'))
    week = meterOf(weeklyFor(likely.cred, model))
  } else if (!sess.proxied) {
    account = 'claude.ai'
    note = 'direct login'
    const r5 = sess.rateLimits.find(r => r.kind === 'five_hour')
    const r7 = sess.rateLimits.find(r => r.kind === 'seven_day')
    five = r5 && { remaining: 100 - r5.percentUsed, reset: untilIso(r5.resetsAt, now), stale: false, label: '5-hour' }
    week = r7 && { remaining: 100 - r7.percentUsed, reset: untilIso(r7.resetsAt, now), stale: false, label: 'Weekly' }
  } else {
    account = 'proxy'
    note = 'no quota data'
  }
  const shownCred = acct?.cred ?? likely?.cred
  const poolView = acct?.view ?? (likely ? snap?.providers[likely.provider] : undefined)
  const poolCurrent = acct?.session.auth_id ?? likely?.cred.id ?? ''
  const all = poolView && poolView.credentials.length ? pooled(poolView) : null

  const cs = cold ? { state: 'cold' as const, leftMs: 0, frac: 0 } : cacheState(cache, now)

  // The provider the session asks for, which `back` returns a routed session to.
  const original = acct?.session.requested_model ? providerOfModel(acct.session.requested_model) : acct?.provider ?? ''
  // Providers this proxy has accounts and models for: the switch menu offers the others, and while
  // routed the route's own too, for another of its models.
  const switchProviders = acct && snap
    ? Object.keys(snap.providers).filter(p => (route ? p !== original : p !== acct.provider) && latestModels(models, p).length)
    : []
  // Commands reach the proxy as the snapshot does: not while it gives none.
  const canSend = !bandError
  const canSwitch = Boolean(acct && canSend && (acct.view.credentials.length > 1 || switchProviders.length || route))

  // A move ends what is cached: past the reader's threshold, the band says what it costs first.
  const pick = (move: Move) => {
    const asks = settings.confirmAbove > 0 && cache.prompt >= settings.confirmAbove && !cold && cs.state !== 'unknown'
    if (asks) act.ui({ confirm: 'move', move, switchStep: '' })
    else act.send(move)
  }
  const unroute: Move = { action: 'unroute', fields: {}, text: `Back to ${providerTitle(original)}` }

  const facts: Facts = {
    proxied: sess.proxied,
    acct,
    account,
    note,
    route: route?.model ?? '',
    model,
    modelName: `${model.replace(/^claude-/, '')}${longContext}`,
    effort: sess.effort,
    isCodex,
    five,
    week,
    fiveMissing: missingText(shownCred, '5h'),
    weekMissing: missingText(shownCred, '7d'),
    ctx,
    cache: { ...cs, rate: hitRate(cache), cold, cost, tokens: cache.prompt, warmed: cache.warmed, keepWarm: settings.keepWarm },
    pool: all && poolView ? { ...all, caption: nextUp(poolView, poolCurrent, now) } : null,
    controls: {
      switch: canSwitch ? { key: 'switch', label: 'switch', run: () => act.ui({ confirm: ui.confirm === 'switch' ? '' : 'switch', switchStep: '' }) } : undefined,
      unroute: route && canSend ? { key: 'unroute', label: 'back', run: () => pick(unroute) } : undefined,
      quota: { key: 'quota', label: 'quota', run: act.quota },
    },
    top: null,
  }
  facts.top = topRow(i, facts, act, { pick, unroute, switchProviders, canSend, original })
  return facts
}

type Menu = { pick: (move: Move) => void; unroute: Move; switchProviders: string[]; canSend: boolean; original: string }

/** The one row above the band: a question first, then what came of an action, then an alert. */
function topRow(i: BandInput, f: Facts, act: Do, menu: Menu): Row | null {
  const { ui, snap, now, settings, working, cache, bandError } = i
  const { acct, cache: c } = f
  const cancel = (patch: Partial<UiState> = {}): Act => ({ key: 'no', label: 'cancel', run: () => act.ui({ confirm: '', switchStep: '', move: null, ...patch }) })
  const ask = (title: string, detail: string, acts: Act[], close = cancel()): Row => ({ key: 'ask', tone: 'ask', title, detail, acts, close })

  if (ui.confirm === 'handoff') {
    return ask('Hand off to a new session?',
      `Claude writes a summary (goal, done, not done, changes, watch out, next step) and saves it; this conversation clears and a new one starts from the summary${ui.held ? ', with your message after it' : ''}.`,
      [{ key: 'yes-handoff', label: 'hand off', main: true, run: () => act.handoff({ held: ui.held || undefined }) }],
      cancel({ held: '' }))
  }
  if (ui.confirm === 'send' && c.cold) {
    const cold = c.cold
    return ask('Message held',
      // Enter sends it: the line Claude Code prints for the held message says so.
      `next turn starts cold (${cold.why}): ${rewriteText(cold.tokens, c.cost)}`,
      [
        { key: 'send-held', label: 'send', main: true, run: act.sendHeld },
        { key: 'handoff-held', label: 'hand off with it', run: () => act.handoff({ held: ui.held, fromBox: true }) },
      ],
      cancel({ coldOk: cold.key, held: '' }))
  }
  if (ui.confirm === 'move' && ui.move) {
    const move = ui.move
    const target = move.action === 'route' ? move.fields.model ?? f.model : f.model
    return ask(`${move.text}?`,
      `The next turn then starts cold: it ${rewriteText(cache.prompt, turnCost(target, cache.prompt, cache.ttlMs))}.`,
      [
        { key: 'yes-move', label: move.action === 'switch' ? 'switch' : move.action === 'route' ? 'route' : 'go back', main: true, run: () => act.send(move) },
        { key: 'handoff-move', label: 'hand off first', run: () => act.handoff({ move }) },
      ])
  }
  if (ui.confirm === 'switch' && acct) {
    // Two steps: accounts of this provider and the providers to route to, then that provider's models.
    const route = acct.session.route
    if (ui.switchStep) {
      const provider = ui.switchStep
      return ask(`${providerTitle(provider)} model`, '', [
        ...latestModels(i.models, provider).map((m): Act => route?.model === m
          ? { key: `model-${m}`, label: `${m} (now)`, name: true }
          : { key: `model-${m}`, label: m, name: true, main: true, run: () => menu.pick({ action: 'route', fields: { provider, model: m }, text: `Switch to ${m}` }) }),
        { key: 'back', label: '‹ back', run: () => act.ui({ switchStep: '' }) },
      ])
    }
    const ready = new Set(switchTargets(acct.view, acct.session.auth_id, acct.session.blocked).map(x => x.id))
    return ask('Switch this session to:', '', [
      ...otherAccounts(acct.view, acct.session.auth_id).map((x): Act => ready.has(x.id)
        ? { key: `to-${x.id}`, label: `${x.label} ${usedText(windowOf(x, '7d'))}`, name: true, main: true, run: () => menu.pick({ action: 'switch', fields: { auth_id: x.id }, text: `Switch to ${x.label}` }) }
        : { key: `not-${x.id}`, label: cannotTake(x, acct.session.model, now), name: true }),
      ...(route ? [{ key: 'unroute', label: `back to ${providerTitle(menu.original)}`, main: true, run: () => menu.pick(menu.unroute) }] : []),
      ...menu.switchProviders.map((p): Act => ({ key: `prov-${p}`, label: `${providerTitle(p)} ›`, main: true, run: () => act.ui({ switchStep: p }) })),
    ])
  }
  if (ui.notice) {
    return {
      key: 'notice', tone: ui.noticeIsError ? 'warn' : 'info', title: ui.notice, detail: '', acts: [], busy: ui.busy,
      close: ui.busy ? undefined : { key: 'dismiss', label: 'ok', run: () => act.ui({ notice: '' }) },
    }
  }
  const handoff: Act = { key: 'alert-handoff', label: 'hand off', main: true, run: () => act.ui({ confirm: 'handoff' }) }
  // Without quota data from the proxy, the reason it gave goes first.
  if (bandError) return { key: 'alert', tone: 'warn', title: bandErrorText(bandError), detail: '', acts: [] }
  const alert = pickAlert(snap, acct, i.sess.proxied, now, ui.dismissedSwitch)
  // What the proxy warns of goes before a cold turn; that the session moved, after it.
  if (alert && alert.action !== 'dismiss') {
    const fallback = acct ? snap?.config.fallback_map[acct.provider] : undefined
    const [fbProvider, fbModel] = (fallback ?? ':').split(':')
    const acts: Act[] = alert.action === 'route' && fbProvider && fbModel && menu.canSend
      ? [{ key: 'route', label: `use ${fbModel}`, name: true, run: () => menu.pick({ action: 'route', fields: { provider: fbProvider, model: fbModel }, text: `Route to ${fbModel}` }) }]
      : alert.action === 'handoff' && !working ? [handoff] : []
    return { key: 'alert', tone: alert.level, title: alert.text, detail: '', acts }
  }
  const cold = c.cold
  if (cold && !working && cold.tokens >= COLD_NOTICE_FLOOR && !coldConfirmed(cold, ui.coldDismissed)) {
    return {
      key: 'alert', tone: 'warn', title: 'Next turn starts cold', detail: `${cold.why}; it ${rewriteText(cold.tokens, c.cost)}`,
      acts: [handoff], close: { key: 'cold-ok', label: 'ok', run: () => act.ui({ coldDismissed: cold.key }) },
    }
  }
  if (alert) {
    return { key: 'alert', tone: alert.level, title: alert.text, detail: '', acts: [], close: { key: 'alert-ok', label: 'ok', run: () => act.ui({ dismissedSwitch: alert.key ?? '' }) } }
  }
  const used = f.ctx ? Math.round(100 - f.ctx.left) : 0
  if (settings.handoffAt > 0 && used >= settings.handoffAt && !working && (!ui.handoffDismissedAt || used >= ui.handoffDismissedAt + 10)) {
    return {
      key: 'alert', tone: 'info', title: `Context ${used}% used`, detail: 'hand off to a new session that starts from a summary?',
      acts: [handoff], close: { key: 'handoff-ok', label: 'ok', run: () => act.ui({ handoffDismissedAt: used }) },
    }
  }
  return null
}

/**
 * The cache card's caption: what is left of it and what keeping it warm did, or what a cold turn
 * rewrites. `wide` spells it out, as the desktop app's card has room to.
 */
export function cacheCaption(f: Facts, wide: boolean): string {
  const c = f.cache
  if (f.isCodex) return 'last request'
  if (c.state === 'unknown') return 'after the first reply'
  if (c.state === 'cold') return `rewrites ${fmtTokens(c.tokens)}${c.cost ? ` ≈${fmtUsd(c.cost.cold)}` : ''}`
  if (!c.warmed) return `expires in ${fmtDuration(c.leftMs)}`
  return wide ? `expires in ${fmtDuration(c.leftMs)} · kept warm ${c.warmed} of ${c.keepWarm}` : `kept warm ${c.warmed}/${c.keepWarm} · ${fmtDuration(c.leftMs)}`
}
