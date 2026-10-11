// quota-band's state contract and the quota-pilot snapshot it reads from the proxy's /band route.

export type SnapWindow = {
  kind: string
  label: string
  remaining: number
  reset_at?: string
  observed_at: string
  stale: boolean
}

export type SnapCred = {
  id: string
  auth_index: string
  label: string
  email?: string
  /** Subscription plan, e.g. Max 20x; absent until the plugin has read it. */
  plan?: string
  order: number
  tier: number
  reason: string
  sessions: number
  /** Disabled, or known unable to serve now. */
  unavailable?: boolean
  disabled?: boolean
  /** When the window that limits it resets; absent when nothing limits it or the time is unknown. */
  back_at?: string
  windows: SnapWindow[]
  /** Window kinds the provider said the account does not have, as a Codex account's 5-hour one. */
  absent?: string[]
  /** The credential of the same provider account the proxy also holds: one quota, counted under that one. */
  same_as?: string
}

export type SnapProvider = { health: string; credentials: SnapCred[] }

export type SnapTokens = {
  input: number
  output: number
  cache_read: number
  cache_creation: number
  at?: string
}

/**
 * Where the session's next turn goes (the route's provider and model, else the provider of the
 * model it asks for, and the account bound there). served_auth_id answered its last turn.
 */
export type SnapSession = {
  provider: string
  model: string
  requested_model?: string
  route_note?: string
  auth_id: string
  served_auth_id?: string
  auth_label: string
  binding_reason: string
  switched?: boolean
  route?: { provider: string; model: string; auto: boolean; at: string }
  last_switch?: { from: string; to: string; at: string; reason: string }
  switch_imminent: boolean
  switch_reason?: string
  next_auth_id?: string
  /** Accounts of its provider that cannot serve its next model, as one whose Opus quota is used up. */
  blocked?: string[]
  totals: SnapTokens
  last: SnapTokens
  last_seen: string
}

export type SnapAck = { command_id: string; session?: string; status: string; reason?: string; at: string }

export type Snap = {
  schema_version: number
  boot_id: string
  sequence: number
  generated_at: string
  config: {
    cross_provider: string
    fallback_map: Record<string, string>
    min_five_hour_left_percent: number
    idle_poll_minutes: number
  }
  providers: Record<string, SnapProvider>
  sessions: Record<string, SnapSession>
  acks: SnapAck[]
  context_lengths: Record<string, number>
  last_error?: string
  /** The account a new session of each provider gets for the model the band named, as a pick ranks them. */
  expected?: Record<string, string>
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type SessionInfo = {
  id: string
  model: string
  effort: string
  cwd: string
  contextTokens: number | null
  contextWindow: number
  rateLimits: RateLimit[]
  proxied: boolean
  home: string
}

/**
 * What the band tells the proxy of its session, which only this device knows. Claude Code's hook
 * events and the band's reads each write only their own fields.
 */
export type SessionAbout = {
  /** The session this is about; another id starts over. */
  id: string
  /** Its transcript, from Claude Code's hook events. */
  transcript: string
  /** Its title as Claude Code's hook events last said it. */
  eventTitle: string
  /** Its title as its transcript names it, for when no event has said one, and when it was read. */
  fileTitle: string
  fileTitleAt: number
  /** Its first request, from its transcript: its name while Claude Code has given it no title. */
  request: string
  /** The folder it started in, kept from its first read (a `/cd` later does not move it), and the repository it is in ("" outside one). */
  start: string
  root: string
  /** That repository as its git remote names it ("github.com/owner/name"), the same on every device; "" without one. */
  repo: string
}

export type CacheInfo = {
  lastAt: number
  prompt: number
  read: number
  creation: number
  input: number
  ttlMs: number
  lastAnswer: string
  /** The model that answered the last main-thread request: another one next finds nothing cached. */
  model: string
  /** The route the last reply went by ('' for none), as the snapshot said then; null when not known (a resumed conversation). */
  route: string | null
  /** Times the cache was kept warm since the reader's last prompt, and whether keeping it stopped: a refresh found it gone. */
  warmed: number
  warmStop: boolean
}

/** A command sent and not yet acknowledged: the proxy run (boot id) it was sent to, and when. */
export type Pending = { id: string; text: string; boot: string; at: number }

/**
 * Why the band read no snapshot from the proxy's `/band`: an error status (401 before the proxy
 * has accepted the key for a request), an answer that is not a snapshot, or no answer at all.
 */
export type BandError =
  | { kind: 'status'; status: number }
  | { kind: 'body' }
  | { kind: 'network'; message: string }

export type ModelInfo = { id: string; owned_by: string; created: number }

/** A switch or a route as the band sends it: the command, its fields, and how it is told. */
export type Move = { action: string; fields: Record<string, string>; text: string }

export type UiState = {
  /** '' for the first switch step, else the provider whose models are listed. */
  switchStep: string
  /**
   * The question above the band: a handoff, the switch menu, a move that would start the next
   * turn cold (`move`), or a message held because it would (`send`).
   */
  confirm: '' | 'handoff' | 'switch' | 'move' | 'send'
  /** The move `confirm: 'move'` asks about. */
  move: Move | null
  /** The message the send guard held, which a handoff carries on with. */
  held: string
  /** The cold spell (ColdTurn key) the reader chose to send into anyway, and the one whose notice they dismissed. */
  coldOk: string
  coldDismissed: string
  /** The context share, in percent, at which the reader dismissed the handoff suggestion: it comes back 10 points on. */
  handoffDismissedAt: number
  /** A move a handoff leaves for its new session (`to`), sent once the proxy has seen that session, if within ten minutes (`at`). */
  afterHandoff: (Move & { to: string; at: number }) | null
  pending: Pending[]
  notice: string
  noticeIsError: boolean
  busy: boolean
  /**
   * The reader's choice of one line or cards, kept for the phase (working or idle) and the turn it
   * was made in; the band goes back to its default when either changes.
   */
  viewOverride: '' | 'cards' | 'line'
  viewPhase: '' | 'working' | 'idle'
  viewTurn: number
  /** Main-conversation turns completed in this session. */
  turns: number
  /** The account switch whose notice the reader dismissed, by its time. */
  dismissedSwitch: string
}

declare module 'claude-code' {
  interface PluginState {
    'quota-band': {
      snap: Snap | null
      bandError: BandError | null
      now: number
      session: SessionInfo
      about: SessionAbout
      cache: CacheInfo
      ui: UiState
      models: ModelInfo[]
    }
  }
}
