/**
 * quota-pilot plugin snapshot, normalized for the panel.
 *
 * Mirrors the subset of the plugin's `core.Snapshot` the Quota Ledger reads.
 * Instants are epoch ms (null when absent); `remaining` is a 0..1 fraction.
 */

export type QuotaPilotHealth = 'healthy' | 'exhausted' | 'unknown';

export interface QuotaPilotWindow {
  /** `5h`, `7d`, `7d_opus`, `7d_sonnet`, `7d_fable`, or a future kind. */
  kind: string;
  label: string;
  remaining: number;
  resetAtMs: number | null;
  observedAtMs: number | null;
  stale: boolean;
}

export interface QuotaPilotCredential {
  id: string;
  authIndex: string;
  /** Masked by the plugin, e.g. `d•••`. */
  label: string;
  email: string;
  /** Subscription plan, e.g. `Max 20x`; '' when not read yet. */
  plan: string;
  /** Routing order; 1 is the account a new session gets. */
  order: number;
  /** 1 ready, 2 quota unknown, 3 limited. */
  tier: number;
  reason: string;
  /** Sessions bound to this account now. */
  sessions: number;
  unavailable: boolean;
  windows: QuotaPilotWindow[];
}

export interface QuotaPilotProvider {
  health: QuotaPilotHealth;
  /** Already in routing order. */
  credentials: QuotaPilotCredential[];
}

export interface QuotaPilotConfig {
  crossProvider: string;
  fallbackMap: Record<string, string>;
  minFiveHourLeftPercent: number;
  idlePollMinutes: number;
}

export interface QuotaPilotSnapshot {
  schemaVersion: number;
  bootId: string;
  sequence: number;
  generatedAtMs: number | null;
  config: QuotaPilotConfig;
  providers: Record<string, QuotaPilotProvider>;
  lastError: string;
}

/** Token counts summed over requests. */
export interface QuotaPilotTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Requests, tokens and their estimated weight by kind of token. */
export interface QuotaPilotComposition {
  requests: number;
  tokens: QuotaPilotTokens;
  weights: QuotaPilotTokens;
}

export interface QuotaPilotUsageSession {
  /** Claude Code session id; '' for requests that carried none. */
  id: string;
  /** Claude Code's title for the session; '' when its transcript is not on this machine. */
  title: string;
  /** Part of one account's weekly quota (account, provider) or of all usage (all), 0..1. */
  used: number;
  requests: number;
  lastMs: number | null;
  tokens: QuotaPilotTokens;
  /** Ids of the accounts that served it in the period, most used first. */
  accounts: string[];
  /** What started a Codex session ("Claude Code", "codex-tui"…), or how a Claude Code session was run ("sdk-py"…); '' for the interactive CLI. */
  origin: string;
  /** Mode `all`: its part of each provider's weekly quota, in that provider's unit. */
  usedBy: Record<string, number>;
  /** False when none of its requests fell where quota readings exist: only its tokens are known. */
  metered: boolean;
  /** The providers it used in the range. */
  providers: string[];
}

export interface QuotaPilotUsageProject {
  /** Repository or folder name; '' for sessions with no transcript here. */
  name: string;
  path: string;
  used: number;
  usedBy: Record<string, number>;
  metered: boolean;
  requests: number;
  lastMs: number | null;
  tokens: QuotaPilotTokens;
  sessions: QuotaPilotUsageSession[];
}

/** One account over its current window of the range: its week, or over 5h its 5-hour window. */
export interface QuotaPilotUsageAccount {
  id: string;
  label: string;
  plan: string;
  provider: string;
  resetAtMs: number | null;
  /** Routing order; 1 is the account a new session gets. */
  order: number;
  /** Sessions bound to it now. */
  sessions: number;
  used: number;
  /** False when no quota reading fell in the window yet; `used` then means nothing. */
  known: boolean;
  beforeLog: number;
  outside: number;
  /** Project name to its part of this account's week. */
  projects: Record<string, number>;
  /** When the log began to see this account; what it had used by then is `beforeLog`. */
  coveredFromMs: number | null;
  /** Named by the log but not held by the proxy: one removed since, or a Codex login elsewhere. */
  offProxy: boolean;
  /** When its window started over before its reset (a plan change): the window counts from then. */
  restartedAtMs: number | null;
  /** 5h: the account has no 5-hour window (a Codex account may have only a weekly one). */
  noWindow: boolean;
}

export interface QuotaPilotUsageProvider {
  provider: string;
  /** Accounts in use first, then routing order. */
  accounts: QuotaPilotUsageAccount[];
}

/** One provider's local day in a 7- or 30-day range. */
export interface QuotaPilotUsageDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Project name to its part of one account's weekly quota. */
  projects: Record<string, number>;
  outside: number;
  /** A quota reading fell on the day; without one only tokens are known. */
  metered: boolean;
  /** What the scope's requests ran that day, whether or not readings tell their quota. */
  requests: number;
  tokens: QuotaPilotTokens;
  /**
   * The day's largest sessions, up to three: those readings tell by their part (`used`), then the
   * rest by weight (`used` null).
   */
  sessions: { id: string; title: string; used: number | null }[];
}

/** One 5-hour window of one account, in parts of that window. */
export interface QuotaPilotUsageWindow {
  account: string;
  fromMs: number;
  /** When it resets, or ended when the next began first. */
  toMs: number;
  /** The window the summary shows. */
  running: boolean;
  /** Its last reading. */
  used: number;
  beforeLog: number;
  outside: number;
  /** Project name to its part of the window. */
  projects: Record<string, number>;
  requests: number;
  tokens: QuotaPilotTokens;
  /** Its largest sessions, up to three, by their part. */
  sessions: { id: string; title: string; used: number | null }[];
}

/** A name with a share of weight. */
export interface QuotaPilotPart {
  name: string;
  weight: number;
}

/** One stretch of a session's time: what it used and what used it. */
export interface QuotaPilotUsageBucket {
  atMs: number;
  weight: number;
  requests: number;
  tokens: QuotaPilotTokens;
  /** Weight sent by subagents. */
  agent: number;
  /** Weight by model, by account ('' when not known) and by provider, largest first. */
  models: QuotaPilotPart[];
  accounts: QuotaPilotPart[];
  providers: QuotaPilotPart[];
  /**
   * Each provider's part of one account's weekly quota in the stretch, from the requests readings
   * settled; a provider none of whose requests were settled is not in it.
   */
  quota: Record<string, number>;
}

/** One provider's accounts in the range, in parts of one account's weekly quota. */
export interface QuotaPilotUsageTotals {
  capacity: number;
  used: number;
  /** A reading fell in the range for some account; without one, `used` means nothing. */
  known: boolean;
  beforeLog: number;
  unplaced: number;
  /** The part of `outside` read across midnight: in `used`, on no day. */
  undated: number;
  outside: number;
  /** 7d and 30d: accounts with no reading in the range, whose use is not known. */
  unread: string[];
}

/**
 * Each account's current 5-hour window or week (each over its own), or the last 7 or 30 local
 * days.
 */
export type QuotaPilotUsageRange = '5h' | 'week' | '7d' | '30d';

/**
 * Where usage went, for one scope over one range. Mode `account`: one account. Mode `provider`:
 * a provider's accounts added up, in units of one account's weekly quota. Mode `all`: every
 * provider, each in its own unit (Totals and `usedBy`), never added across providers. 5h and week:
 * `used` is the windows' readings; 7d and 30d: what the range used across the weeks it touches.
 * Every report also lists every account's current window of the range, read in the same pass, for
 * the picker. Over 5h the unit is one account's 5-hour window.
 */
export interface QuotaPilotUsage {
  mode: 'account' | 'provider' | 'all';
  /** The account id, `provider:<name>` or `all` this report answers. */
  scope: string;
  range: QuotaPilotUsageRange;
  provider: string;
  capacity: number;
  fromMs: number;
  toMs: number;
  used: number;
  /** A reading fell in the range for some account of the scope; without one, `used` means nothing. */
  known: boolean;
  beforeLog: number;
  /**
   * 7d and 30d: used before logging in a week that began before the range. How much of it fell
   * inside the range is not known, so `used` leaves it out.
   */
  unplaced: number;
  /** The part of `outside` read across midnight: in `used`, on no day. */
  undated: number;
  outside: number;
  /** 7d and 30d: accounts of the scope with no reading in the range, whose use is not known. */
  unread: string[];
  /** Mode `all`: each provider's part. */
  totals: Record<string, QuotaPilotUsageTotals>;
  composition: QuotaPilotComposition;
  projects: QuotaPilotUsageProject[];
  providers: QuotaPilotUsageProvider[];
  /** Each provider's days, oldest first; none over 5h. */
  daily: Record<string, QuotaPilotUsageDay[]>;
  /** 5h: each provider's windows of the last day, oldest first. */
  windows: Record<string, QuotaPilotUsageWindow[]>;
  /** 5h: since when every 5-hour window of the scope is known, when that is within the last day. */
  windowsFromMs: number | null;
}

/** One session within a scope and range. */
/** Requests to a provider by the service tier they asked for and the one reported; '' for none. */
export interface QuotaPilotUsageTier {
  provider: string;
  asked: string;
  served: string;
  requests: number;
}

export interface QuotaPilotUsageSessionDetail {
  id: string;
  title: string;
  project: string;
  firstMs: number | null;
  lastMs: number | null;
  composition: QuotaPilotComposition;
  /** Bucket length. */
  unit: '10m' | 'hour' | 'day';
  buckets: QuotaPilotUsageBucket[];
  models: QuotaPilotPart[];
  /** Weight sent by subagents. */
  agent: number;
  /** Label '' when the account is no longer on the proxy. */
  accounts: { id: string; label: string; provider: string; weight: number }[];
  /** Includes lines recovered from transcripts, which sum a whole day. */
  history: boolean;
  origin: string;
  /** Most requests first. */
  tiers: QuotaPilotUsageTier[];
}
