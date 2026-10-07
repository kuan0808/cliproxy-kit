// quota-band's state contract and the quota-pilot snapshot it reads
// (~/.cache/cliproxy-kit/snapshot.json, written by the proxy plugin).

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
  /** The proxy's files are not on this machine for this user (another machine, a container): the snapshot comes over the network and changes are made on the host. */
  remote: boolean
  home: string
}

/**
 * What the band on another device tells the proxy of its session, which the proxy cannot read
 * there. Claude Code's hook events and the band's reads each write only their own fields.
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
}

export type CacheInfo = {
  lastAt: number
  prompt: number
  read: number
  creation: number
  input: number
  ttlMs: number
  lastAnswer: string
}

/** A command sent and not yet acknowledged: the proxy run (boot id) it was written for, and when. */
export type Pending = { id: string; text: string; boot: string; at: number }

/**
 * Why the band read no snapshot from the proxy's `/band`: an error status (401 when the key is
 * not in `band_tokens`), an answer that is not a snapshot, or no answer at all.
 */
export type BandError =
  | { kind: 'status'; status: number }
  | { kind: 'body' }
  | { kind: 'network'; message: string }

export type ModelInfo = { id: string; owned_by: string; created: number }

export type UiState = {
  /** '' for the first switch step, else the provider whose models are listed. */
  switchStep: string
  confirm: '' | 'compact' | 'handoff' | 'switch'
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
