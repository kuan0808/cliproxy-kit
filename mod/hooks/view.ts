// What the band shows, whichever surface draws it: the terminal's cells and the desktop app's
// cards read the same facts and the same row above them, with the same actions behind them.
import type { Auto, BandError, CacheInfo, Live, ModelInfo, Move, Press, SessionInfo, Snap, UiState } from '../types'
import { W, type Words } from './wording'
import {
  autoState,
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
  restingNow,
  rewriteBrief,
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
  /** The detail in fewer words, for a row too narrow for it. */
  brief?: string
  /** The whole row in fewer words, drawn in place of title and detail when it does not fit. */
  short?: string
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
  /** This session's choice of a feature; null follows `/config`. */
  auto: (feature: keyof Auto, value: boolean | null) => unknown
  /** The band's settings, for a session with no proxy accounts to list. */
  settings: () => unknown
  /** Switch now: send the switch of a press, and stop the waiting turn once it applies. */
  press: (op: Press) => unknown
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
  /** This session's own choice of the automatic features, and whether nobody attends it. */
  auto: Auto
  unattended: boolean
  /** The band's own main step, and its clock against the proxy's. */
  live: Live
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
    /** Keeping warm runs in this session. */
    keepWarmOn: boolean
  }
  /** Holding a message into a cold turn runs in this session. */
  holdOn: boolean
  pool: { left: number | null; parts: (number | null)[]; stale: boolean; caption: string } | null
  /** `quota` lists the proxy's accounts; a direct login, with none to list, opens the band's settings in its place. */
  controls: { switch?: Act; unroute?: Act; quota?: Act }
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
    // The plan only: a move is told once, by the row above the band. While the account rests, when
    // it is tried again.
    note = restingNow(acct.cred, now) ? `resting, back in ${fmtDuration(Date.parse(acct.cred.rest!.until) - now)}` : acct.cred.plan ?? ''
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

  // A move ends what is cached: from the reader's size (Hold above; 0 any), the band says what it
  // costs first, whether holding is on or not, as the reader pressed for it.
  const asks = cache.prompt >= settings.confirmAbove && !cold && cs.state !== 'unknown'
  const pick = (move: Move) => {
    if (asks) act.ui({ confirm: 'move', move, switchStep: '' })
    else act.send(move)
  }
  const unroute: Move = { action: 'unroute', fields: {}, text: W.backTo(providerTitle(original)) }

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
    cache: { ...cs, rate: hitRate(cache), cold, cost, tokens: cache.prompt, warmed: cache.warmed, keepWarm: settings.keepWarm, keepWarmOn: autoState('keepWarm', settings, i.auto, i.unattended).on },
    holdOn: autoState('holdCold', settings, i.auto, i.unattended).on,
    pool: all && poolView ? { ...all, caption: nextUp(poolView, poolCurrent, now) } : null,
    controls: {
      switch: canSwitch ? { key: 'switch', label: 'switch', run: () => act.ui({ confirm: ui.confirm === 'switch' ? '' : 'switch', switchStep: '' }) } : undefined,
      unroute: route && canSend ? { key: 'unroute', label: 'back', run: () => pick(unroute) } : undefined,
      quota: sess.proxied ? { key: 'quota', label: 'quota', run: act.quota } : { key: 'settings', label: 'settings', run: act.settings },
    },
    top: null,
  }
  facts.top = topRow(i, facts, act, { pick, unroute, switchProviders, canSend, original, asks })
  return facts
}

type Menu = { pick: (move: Move) => void; unroute: Move; switchProviders: string[]; canSend: boolean; original: string; asks: boolean }

/** The one row above the band: a question first, then what came of an action, then an alert. */
function topRow(i: BandInput, f: Facts, act: Do, menu: Menu): Row | null {
  const { ui, snap, now, settings, working, cache, bandError } = i
  const { acct, cache: c } = f
  const cancel = (patch: Partial<UiState> = {}): Act => ({ key: 'no', label: 'cancel', run: () => act.ui({ confirm: '', switchStep: '', move: null, ...patch }) })
  const ask = (title: string, detail: string, acts: Act[], close = cancel(), brief?: string): Row => ({ key: 'ask', tone: 'ask', title, detail, brief, acts, close })

  if (ui.confirm === 'handoff') {
    const q = W.handoffAsk(Boolean(ui.held))
    return ask(q.title, q.detail,
      [{ key: 'yes-handoff', label: 'hand off', main: true, run: () => act.handoff({ held: ui.held || undefined }) }],
      cancel({ held: '' }))
  }
  // A question left from before holding was turned off (an upgrade, /config) is not asked.
  if (ui.confirm === 'send' && c.cold && f.holdOn) {
    const cold = c.cold
    // Enter sends it: the line Claude Code prints for the held message says so.
    const q = W.held(cold.why, rewriteText(cold.tokens, c.cost), c.cost ? fmtUsd(c.cost.cold) : '')
    return {
      ...ask(q.title, q.detail,
        [
          { key: 'send-held', label: 'send', main: true, run: act.sendHeld },
          { key: 'handoff-held', label: 'hand off with it', run: () => act.handoff({ held: ui.held, fromBox: true }) },
        ],
        cancel({ coldOk: cold.key, held: '' })),
      short: q.short,
    }
  }
  if (ui.confirm === 'move' && ui.move) {
    const move = ui.move
    const target = move.action === 'route' ? move.fields.model ?? f.model : f.model
    const cost = turnCost(target, cache.prompt, cache.ttlMs)
    const q = W.moveAsk(move.text, rewriteText(cache.prompt, cost), rewriteBrief(cache.prompt, cost))
    return ask(q.title, q.detail,
      [
        { key: 'yes-move', label: move.action === 'switch' ? 'switch' : move.action === 'route' ? 'route' : 'go back', main: true, run: () => act.send(move) },
        { key: 'handoff-move', label: 'hand off first', run: () => act.handoff({ move }) },
      ],
      cancel(),
      q.brief)
  }
  if (ui.confirm === 'switch' && acct) {
    // Two steps: accounts of this provider and the providers to route to, then that provider's models.
    const route = acct.session.route
    if (ui.switchStep) {
      const provider = ui.switchStep
      return ask(W.modelMenu(providerTitle(provider)), '', [
        ...latestModels(i.models, provider).map((m): Act => route?.model === m
          ? { key: `model-${m}`, label: `${m} (now)`, name: true }
          : { key: `model-${m}`, label: m, name: true, main: true, run: () => menu.pick({ action: 'route', fields: { provider, model: m }, text: W.switchTo(m) }) }),
        { key: 'back', label: '‹ back', run: () => act.ui({ switchStep: '' }) },
      ])
    }
    const ready = new Set(switchTargets(acct.view, acct.session.auth_id, acct.session.blocked).map(x => x.id))
    return ask(W.switchMenu, '', [
      ...otherAccounts(acct.view, acct.session.auth_id).map((x): Act => ready.has(x.id)
        ? { key: `to-${x.id}`, label: `${x.label} ${usedText(windowOf(x, '7d'))}`, name: true, main: true, run: () => menu.pick({ action: 'switch', fields: { auth_id: x.id }, text: W.switchTo(x.label) }) }
        : { key: `not-${x.id}`, label: cannotTake(x, acct.session.model, now), name: true }),
      ...(route ? [{ key: 'unroute', label: `back to ${providerTitle(menu.original)}`, main: true, run: () => menu.pick(menu.unroute) }] : []),
      ...menu.switchProviders.map((p): Act => ({ key: `prov-${p}`, label: `${providerTitle(p)} ›`, main: true, run: () => act.ui({ switchStep: p }) })),
    ])
  }
  // Switch now: its question, then the press under way until the turn it stops has ended.
  const press = ui.press
  if (press?.stage === 'asking') {
    const cost = turnCost(f.model, cache.prompt, cache.ttlMs)
    const q = W.pressAsk(press.label, rewriteText(cache.prompt, cost))
    return {
      ...ask(q.title, q.detail, [{ key: 'switch-now', label: 'switch now', main: true, run: () => act.press(press) }],
        { key: 'keep-waiting', label: 'keep waiting', run: () => act.ui({ press: null }) }),
      short: q.short,
    }
  }
  if (press) {
    const unconfirmed = press.stage === 'stopping' && now - press.abortAt >= PRESS_WAIT_MS
    return { key: 'notice', tone: 'info', title: unconfirmed ? W.stopUnconfirmed(press.label) : W.sending(W.switchTo(press.label)), detail: '', acts: [] }
  }
  // A notice with a life of its own goes by itself, so a waiting row and its control come back.
  const life = ui.noticeLife?.text === ui.notice ? ui.noticeLife : null
  if (ui.notice && !(life && now >= life.until)) {
    return {
      key: 'notice', tone: ui.noticeIsError ? 'warn' : 'info', title: ui.notice, detail: '', short: life?.short || undefined, acts: [], busy: ui.busy,
      close: ui.busy ? undefined : { key: 'dismiss', label: 'ok', run: () => act.ui({ notice: '' }) },
    }
  }
  const handoff: Act = { key: 'alert-handoff', label: 'hand off', main: true, run: () => act.ui({ confirm: 'handoff' }) }
  // Without quota data from the proxy, the reason it gave goes first.
  if (bandError) return { key: 'alert', tone: 'warn', title: bandErrorText(bandError), detail: '', acts: [] }
  const alert = pickAlert(snap, acct, i.sess.proxied, now, ui.dismissedSwitch, ui.pressed)
  const live = liveRows(i, acct)
  // The proxy's alerts go before a cold turn: a retry of the session's account, waiting or running,
  // first; then the plugin's warnings; then the band's own hang watch. That the session moved, or
  // stayed, comes after the cold turn.
  // Each live row offers `switch to k•••` while a press could stop the waiting turn (pressAct).
  const liveAct = live && pressAct(i, acct, menu, act)
  if (live?.kind === 'retry' && !alert?.text.startsWith('quota data is')) return liveRow(live, liveAct)
  if (alert && alert.action !== 'dismiss') {
    const fallback = acct ? snap?.config.fallback_map[acct.provider] : undefined
    const [fbProvider, fbModel] = (fallback ?? ':').split(':')
    const acts: Act[] = alert.action === 'route' && fbProvider && fbModel && menu.canSend
      ? [{ key: 'route', label: `use ${fbModel}`, name: true, run: () => menu.pick({ action: 'route', fields: { provider: fbProvider, model: fbModel }, text: W.routeTo(fbModel) }) }]
      : alert.action === 'handoff' && !working ? [handoff] : []
    return { key: 'alert', tone: alert.level, title: alert.text, detail: '', short: alert.short, acts }
  }
  if (live?.kind === 'watch') return liveRow(live, liveAct)
  const cold = c.cold
  if (cold && !working && cold.tokens >= COLD_NOTICE_FLOOR && !coldConfirmed(cold, ui.coldDismissed)) {
    return {
      key: 'alert', tone: 'warn', ...W.coldTurn(cold.why, rewriteText(cold.tokens, c.cost), rewriteBrief(cold.tokens, c.cost)),
      acts: [handoff], close: { key: 'cold-ok', label: 'ok', run: () => act.ui({ coldDismissed: cold.key }) },
    }
  }
  if (alert) {
    // Back to the account a move left, by today's switch and its question about a cold turn.
    const back = alert.back && acct && menu.canSend ? acct.view.credentials.find(c => c.id === alert.back) : undefined
    const acts: Act[] = back
      ? [{ key: 'switch-back', label: 'switch back', run: () => menu.pick({ action: 'switch', fields: { auth_id: back.id }, text: W.switchTo(back.label) }) }]
      : []
    return { key: 'alert', tone: alert.level, title: alert.text, detail: '', short: alert.short, acts, close: { key: 'alert-ok', label: 'ok', run: () => act.ui({ dismissedSwitch: alert.key ?? '' }) } }
  }
  const used = f.ctx ? Math.round(100 - f.ctx.left) : 0
  if (settings.handoffAt > 0 && used >= settings.handoffAt && !working && (!ui.handoffDismissedAt || used >= ui.handoffDismissedAt + 10)) {
    return {
      key: 'alert', tone: 'info', ...W.context(used),
      acts: [handoff], close: { key: 'handoff-ok', label: 'ok', run: () => act.ui({ handoffDismissedAt: used }) },
    }
  }
  return null
}

/**
 * The live rows, from the band's own main step and the plugin's retry of its account: while a retry
 * waits or runs, shown only while the step has had no content since the first failure; else, a
 * step with no content in its first 30 seconds (the hang watch). Times the plugin gives are on its
 * clock, compared on the band's shifted by the skew of the last read.
 */
function liveRows(i: BandInput, acct: SessionAccount | null): (Words & { kind: 'retry' | 'watch' }) | null {
  const step = i.live.step
  if (!step || !acct) return null
  const s = acct.session
  const onBand = (iso: string) => Date.parse(iso) + i.live.skew
  const label = (id: string | undefined) => acct.view.credentials.find(c => c.id === id)?.label
  const next = label(s.takeover)
  const r = s.retry
  if (r) {
    if (step.contentAt >= onBand(r.first_failure_at)) return null
    const from = label(r.account) ?? 'this account'
    const noQuota = otherAccounts(acct.view, r.account).filter(c => !c.disabled).every(c => c.unavailable)
    if (r.try_started_at) return { kind: 'retry', ...W.running(from, r.cause, i.now - onBand(r.try_started_at), next, noQuota) }
    const giveUpS = Math.round((Date.parse(r.give_up_at) - Date.parse(r.first_failure_at)) / 1000)
    const pastGiveUp = Date.parse(r.next_try_at) > Date.parse(r.give_up_at)
    return { kind: 'retry', ...W.waiting(from, r.cause, onBand(r.next_try_at) - i.now, pastGiveUp, giveUpS, next, noQuota) }
  }
  if (step.contentAt === 0 && i.now - step.startedAt >= HANG_WATCH_MS) return { kind: 'watch', ...W.hangWatch(i.now - step.startedAt, Boolean(next)) }
  return null
}

/** A live row: a warning, which goes when it stops being true; its only control is `switch to k•••`. */
const liveRow = (w: Words, act: Act | null): Row => ({ key: 'alert', tone: 'warn', title: w.text, detail: '', short: w.short, acts: act ? [act] : [] })

/** How long a press waits for the proxy's acknowledgement, and then for the turn it stopped to end. */
export const PRESS_WAIT_MS = 5_000

/**
 * The live rows' control, `switch to k•••` (Switch now), k••• being the account quota-pilot says
 * would take over: offered only while the step's request is surely still on the bound account (no
 * pick of its binding answered another account since a second before the step began, and the
 * session not moved since: its generation is the one the step began under), the band can send
 * commands, and no press is under way. A press asks first by today's rule for a switch.
 */
function pressAct(i: BandInput, acct: SessionAccount | null, menu: Menu, act: Do): Act | null {
  const step = i.live.step
  const s = acct?.session
  const to = s?.takeover && acct?.view.credentials.find(c => c.id === s.takeover)
  if (!step || !s || !to || !menu.canSend || i.ui.press || step.generation === undefined || s.generation !== step.generation) return null
  if (s.elsewhere_at && Date.parse(s.elsewhere_at) + i.live.skew >= step.startedAt - 1000) return null
  const op: Press = {
    id: '', turnId: step.turnId, index: step.index, startedAt: step.startedAt, generation: step.generation, to: to.id, label: to.label,
    stage: 'asking', sentAt: 0, abortAt: 0, switchAt: '', since: false,
  }
  return { key: 'switch-now', label: W.switchNow(to.label), run: () => (menu.asks ? act.ui({ press: op }) : act.press(op)) }
}

/** How long the band's main step goes with no content before it says so. */
const HANG_WATCH_MS = 30_000

/**
 * The cache card's caption: what is left of it and what keeping it warm did, or what a cold turn
 * rewrites. `wide` spells it out, as the desktop app's card has room to.
 */
export function cacheCaption(f: Facts, wide: boolean): string {
  const c = f.cache
  if (f.isCodex) return 'last request'
  if (c.state === 'unknown') return 'after the first reply'
  if (c.state === 'cold') return `rewrites ${fmtTokens(c.tokens)}${c.cost ? ` ≈${fmtUsd(c.cost.cold)}` : ''}`
  // While keeping warm runs, its count shows from the start of the idle stretch.
  if (!c.keepWarmOn) return `expires in ${fmtDuration(c.leftMs)}`
  return wide ? `expires in ${fmtDuration(c.leftMs)} · kept warm ${c.warmed} of ${c.keepWarm}` : `kept warm ${c.warmed}/${c.keepWarm} · ${fmtDuration(c.leftMs)}`
}

/** A row of the band's settings in the pane: what it is, where it stands, and a control to flip it. */
export type SettingRow = { label: string; value: string; act?: Act }

/**
 * The band's settings as the pane lists them: the handoff suggestion, then holding and keeping
 * warm, each with where it stands in this session and why, and a control that flips it here
 * (none in a session nobody attends).
 */
export function settingsRows(i: Pick<BandInput, 'settings' | 'auto' | 'unattended'>, act: Pick<Do, 'auto'>): SettingRow[] {
  const { settings } = i
  const row = (feature: keyof Auto, label: string, tuning: string): SettingRow => {
    const { on, why } = autoState(feature, settings, i.auto, i.unattended)
    const where = why === 'unattended' ? 'off: unattended' : `${on ? 'on' : 'off'} ${why === 'session' ? 'in this session' : 'by default'}`
    return {
      label,
      value: `${where} · ${tuning}`,
      act: why === 'unattended' ? undefined : { key: `auto-${feature}`, label: on ? 'turn off here' : 'turn on here', run: () => act.auto(feature, !on) },
    }
  }
  return [
    { label: 'Handoff suggested', value: settings.handoffAt > 0 ? `from ${settings.handoffAt}% of the context` : 'off' },
    row('holdCold', 'Cold messages wait', settings.confirmAbove > 0 ? `from ${fmtTokens(settings.confirmAbove)} tokens` : 'at any size'),
    row('keepWarm', 'Cache kept warm', `up to ${settings.keepWarm} ${settings.keepWarm === 1 ? 'time' : 'times'}`),
  ]
}
