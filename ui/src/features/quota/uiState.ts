import { QUOTA_VIEWS, type QuotaTabId, type QuotaView } from './constants';

/** The page's choices, kept in this browser so the page opens the way it was left. */
export type QuotaUiState = {
  tab?: QuotaTabId;
  view?: QuotaView;
  /** Ledger shows full emails instead of masked labels. */
  showEmails?: boolean;
};

const QUOTA_UI_STATE_KEY = 'quota-pilot.uiState';

const QUOTA_VIEW_SET = new Set<string>(QUOTA_VIEWS);

export const isQuotaView = (value: unknown): value is QuotaView =>
  typeof value === 'string' && QUOTA_VIEW_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      // A provider tab is checked against the providers on screen when the page draws.
      tab: typeof parsed.tab === 'string' && parsed.tab ? parsed.tab : undefined,
      view: isQuotaView(parsed.view) ? parsed.view : undefined,
      showEmails: typeof parsed.showEmails === 'boolean' ? parsed.showEmails : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored: callers write one preference at a time, so a
 * whole-object write would drop the others.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.localStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // Without storage the page opens on its defaults.
  }
};
