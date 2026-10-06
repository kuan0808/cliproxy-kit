/** Provider tab order, and the order provider groups are listed in. */
export const QUOTA_TAB_ORDER: readonly string[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
];

export type QuotaTabId = string;

/** ledger = one dense row per credential in routing order; usage = what each session used. */
export const QUOTA_VIEWS = ['ledger', 'usage'] as const;

export type QuotaView = (typeof QUOTA_VIEWS)[number];

/** Remaining-quota levels, as the panel's quota meters colour them: high from 70%, medium from 30%. */
export const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
export const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;
