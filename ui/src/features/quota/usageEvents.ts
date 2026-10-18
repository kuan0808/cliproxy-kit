/**
 * A session's failed attempts, retries and moves in words, as its detail lists them under "Failures
 * and moves": the wording of the plugin's failure kinds and move kinds, in the page's languages.
 */
import type { TFunction } from 'i18next';
import type { QuotaPilotMoveCause, QuotaPilotUsageEvent } from '@/types';
import { modelName } from './usageFormat';

/** How an event reads: a failure in the warning colour, a retry that worked in the success colour. */
export type EventTone = 'failure' | 'kept' | 'plain';

/** "45s", "2m 15s", "2m", "1h 5m": a wait as long as its seconds matter, in the page's language. */
export function waitText(t: TFunction, ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return t('quota_usage.event_wait_s', { s });
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return s % 60
      ? t('quota_usage.event_wait_ms', { m, s: s % 60 })
      : t('quota_usage.event_wait_m', { m });
  }
  const m = Math.round(s / 60);
  return m % 60
    ? t('quota_usage.event_wait_hm', { h: Math.floor(m / 60), m: m % 60 })
    : t('quota_usage.event_wait_h', { h: m / 60 });
}

/** What a failure did: "hung for 2m 15s", "returned HTTP 529" ("again" when the one before did too). */
function failureText(
  t: TFunction,
  f: { kind: string; status: number; waitMs: number; answered?: boolean; model?: string },
  model: string,
  again = false
): string {
  switch (f.kind) {
    case 'hang':
      return t('quota_usage.event_hang', { wait: waitText(t, f.waitMs) });
    case 'connection':
      return t('quota_usage.event_connection');
    case 'timeout':
      return t('quota_usage.event_timeout');
    case 'rate':
      return t('quota_usage.event_rate');
    case 'sign-in':
      return f.status
        ? t('quota_usage.event_sign_in', { status: f.status })
        : t('quota_usage.event_sign_in_plain');
    case 'model':
      return t('quota_usage.event_model', { model: modelName(f.model || model) });
    case 'request':
      // A client's cancel (499): how long it had waited, and whether it had begun answering.
      if (f.status === 499)
        return t(
          f.answered ? 'quota_usage.event_answered_cancelled' : 'quota_usage.event_cancelled',
          {
            wait: waitText(t, f.waitMs),
          }
        );
  }
  const status = f.status || (f.kind === 'overloaded' ? 529 : 0);
  if (!status) return t('quota_usage.event_failed');
  return t(again ? 'quota_usage.event_status_again' : 'quota_usage.event_status', { status });
}

/** A quota or idle move's reading, "d••• weekly quota used up", from the plugin's English reason. */
function readingText(t: TFunction, from: string, reason: string): string {
  const m = /^(weekly|5-hour) quota (used up|low)$/i.exec(reason);
  if (!m) return t('quota_usage.event_reading', { from, reason });
  const window = t(
    m[1].toLowerCase() === 'weekly'
      ? 'quota_usage.event_window_weekly'
      : 'quota_usage.event_window_5h'
  );
  return t(m[2] === 'low' ? 'quota_usage.event_quota_low' : 'quota_usage.event_quota_used_up', {
    from,
    window,
  });
}

/** Why a session moved, from its switch record: "d••• hung for 2m 15s; the retry got no answer". */
function moveWhy(
  t: TFunction,
  kind: string,
  c: QuotaPilotMoveCause | null,
  from: string,
  model: string
): string {
  const cause = c ?? {
    kind: '',
    status: 0,
    waitMs: 0,
    count: 0,
    reason: '',
    model: '',
    retries: 0,
    lastRetry: null,
    answered: false,
    waitedMs: 0,
  };
  switch (kind) {
    case 'user':
      return cause.waitedMs > 0
        ? t('quota_usage.event_by_you_waited', { wait: waitText(t, cause.waitedMs) })
        : t('quota_usage.event_by_you');
    case 'quota':
      return readingText(t, from, cause.reason || 'weekly quota used up');
    case 'idle':
      return cause.reason
        ? t('quota_usage.event_idle', { why: readingText(t, from, cause.reason) })
        : t('quota_usage.event_idle_only');
    case 'gone':
      return t(
        cause.reason === 'disabled' ? 'quota_usage.event_disabled' : 'quota_usage.event_removed',
        { from }
      );
    case 'left-out':
      return t('quota_usage.event_left_out', { from });
    case 'rest':
      return t('quota_usage.event_rest', { from, count: Math.max(cause.count, 2) });
  }
  // A failure of the account it left (sign-in and model included), with how the last retry failed.
  const what = t('quota_usage.event_from', { from, what: failureText(t, cause, model) });
  const r = cause.lastRetry;
  if (!r || (r.kind === cause.kind && r.kind !== 'request')) return what;
  if (r.kind === 'request' && !r.answered)
    return t('quota_usage.event_retry_no_answer', { why: what });
  return t('quota_usage.event_retry_then', { why: what, what: failureText(t, r, model) });
}

/** The account a line names: its label, else that it is no longer on the proxy. */
const accountText = (t: TFunction, label: string) => label || t('quota_usage.account_removed');

/**
 * Event `i` of a session's events in words, and its tone. A retry that failed with the status the
 * failure before it on that account had says "again".
 */
export function eventText(
  t: TFunction,
  events: QuotaPilotUsageEvent[],
  i: number
): { account: string; text: string; tone: EventTone } {
  const e = events[i];
  const model = e.model;
  const account = accountText(t, e.label);
  if (e.event === 'move') {
    const why = moveWhy(t, e.move, e.why, account, model);
    return {
      account,
      text: t('quota_usage.event_moved', { to: accountText(t, e.toLabel), why }),
      tone: 'plain',
    };
  }
  if (e.event === 'failed') {
    return {
      account,
      text: failureText(t, { kind: e.cause, status: e.status, waitMs: e.waitMs }, model),
      tone: 'failure',
    };
  }
  // How long after the first failure the retry started, in seconds as the band says it ("61s later").
  const later =
    e.sinceFirstMs >= 1000
      ? t('quota_usage.event_wait_s', { s: Math.round(e.sinceFirstMs / 1000) })
      : '';
  if (e.ok) {
    return {
      account,
      text: later
        ? t('quota_usage.event_retry_worked_later', { later })
        : t('quota_usage.event_retry_worked'),
      tone: 'kept',
    };
  }
  if (e.cause === 'hang')
    return {
      account,
      text: t('quota_usage.event_retry_hung', { wait: waitText(t, e.waitMs) }),
      tone: 'failure',
    };
  if (e.cause === 'request' && e.status === 499) {
    const key = e.answered
      ? 'quota_usage.event_retry_answered_cancelled'
      : 'quota_usage.event_retry_cancelled';
    return { account, text: t(key, { wait: waitText(t, e.waitMs) }), tone: 'failure' };
  }
  const before = events
    .slice(0, i)
    .reverse()
    .find((x) => x.event === 'failed' && x.account === e.account);
  const what = failureText(
    t,
    { kind: e.cause, status: e.status, waitMs: e.waitMs },
    model,
    Boolean(e.status && before?.status === e.status)
  );
  return {
    account,
    text: later
      ? t('quota_usage.event_retry_failed', { later, what })
      : t('quota_usage.event_retry_failed_now', { what }),
    tone: 'failure',
  };
}
