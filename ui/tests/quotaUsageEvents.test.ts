import { afterAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { SessionDetailView, UsageTable } from '@/features/quota/components/QuotaUsageTable';
import { eventText } from '@/features/quota/usageEvents';
import {
  normalizeQuotaPilotUsage,
  normalizeQuotaPilotUsageSession,
} from '@/services/api/quotaPilot';
import type { QuotaPilotMoveCause, QuotaPilotUsageEvent } from '@/types';
// usage/session's answers after the log was read again, written by the plugin's
// TestASessionsEventsAreReadBackFromTheLog.
import fixture from './fixtures/sessionEvents.json';

const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ru'] as const;

afterAll(async () => {
  await i18n.changeLanguage('en');
});

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The lines of a detail's "Failures and moves" as drawn: each one's class and words. */
const drawnEvents = (markup: string) =>
  [
    ...markup.matchAll(
      /<li(?: class="([^"]*)")?><span class="eventTime">[^<]*<\/span><span>([^<]*)<\/span><\/li>/g
    ),
  ].map((m) => `${m[1] ?? 'plain'}: ${decode(m[2])}`);

const detailOf = (id: keyof typeof fixture, locale: string) =>
  renderToStaticMarkup(
    createElement(SessionDetailView, {
      detail: normalizeQuotaPilotUsageSession(fixture[id])!,
      title: id,
      project: '',
      sources: [],
      range: 'week',
      locale,
    })
  );

const EXPECTED: Record<
  (typeof LOCALES)[number],
  Record<'title' | 's7' | 's8' | 's9', string | string[]>
> = {
  en: {
    title: 'Failures and moves',
    s7: [
      'eventFailure: Opus 5.5 · d••• · hung for 2m 15s',
      'eventFailure: Opus 5.5 · d••• · lost its connection',
      'eventFailure: Opus 5.5 · d••• · retry 61s later returned HTTP 529',
    ],
    s8: [
      'eventFailure: Sonnet 5.5 · d••• · returned HTTP 529',
      'eventFailure: Opus 5.5 · d••• · cannot serve Opus 5.5',
      'plain: Opus 5.5 · switched to k•••: d••• cannot serve Opus 5.5',
    ],
    s9: [
      'eventFailure: Opus 5.5 · d••• · retry cancelled after 45s with no answer',
      'eventFailure: Opus 5.5 · d••• · retry answered, then cancelled after 45s',
      'plain: Opus 5.5 · switched to k•••: by you after waiting 2m 55s',
      'eventKept: Opus 5.5 · k••• · retry 61s later worked',
    ],
  },
  'zh-TW': {
    title: '失敗與切換',
    s7: [
      'eventFailure: Opus 5.5 · d••• · 2 分 15 秒沒有回應',
      'eventFailure: Opus 5.5 · d••• · 連線中斷',
      'eventFailure: Opus 5.5 · d••• · 61 秒後重試，回傳 HTTP 529',
    ],
    s8: [
      'eventFailure: Sonnet 5.5 · d••• · 回傳 HTTP 529',
      'eventFailure: Opus 5.5 · d••• · 無法使用 Opus 5.5',
      'plain: Opus 5.5 · 切換到 k•••：d••• 無法使用 Opus 5.5',
    ],
    s9: [
      'eventFailure: Opus 5.5 · d••• · 重試 45 秒沒有回應，已取消',
      'eventFailure: Opus 5.5 · d••• · 重試已開始回應，45 秒時取消',
      'plain: Opus 5.5 · 切換到 k•••：你等了 2 分 55 秒後切換的',
      'eventKept: Opus 5.5 · k••• · 61 秒後重試成功',
    ],
  },
  'zh-CN': {
    title: '失败与切换',
    s7: [
      'eventFailure: Opus 5.5 · d••• · 2 分 15 秒没有响应',
      'eventFailure: Opus 5.5 · d••• · 连接中断',
      'eventFailure: Opus 5.5 · d••• · 61 秒后重试，返回 HTTP 529',
    ],
    s8: [
      'eventFailure: Sonnet 5.5 · d••• · 返回 HTTP 529',
      'eventFailure: Opus 5.5 · d••• · 无法使用 Opus 5.5',
      'plain: Opus 5.5 · 切换到 k•••：d••• 无法使用 Opus 5.5',
    ],
    s9: [
      'eventFailure: Opus 5.5 · d••• · 重试 45 秒没有响应，已取消',
      'eventFailure: Opus 5.5 · d••• · 重试已开始响应，45 秒时取消',
      'plain: Opus 5.5 · 切换到 k•••：你等了 2 分 55 秒后切换的',
      'eventKept: Opus 5.5 · k••• · 61 秒后重试成功',
    ],
  },
  ru: {
    title: 'Сбои и переключения',
    s7: [
      'eventFailure: Opus 5.5 · d••• · 2 мин 15 с без ответа',
      'eventFailure: Opus 5.5 · d••• · соединение потеряно',
      'eventFailure: Opus 5.5 · d••• · повтор через 61 с: вернул HTTP 529',
    ],
    s8: [
      'eventFailure: Sonnet 5.5 · d••• · вернул HTTP 529',
      'eventFailure: Opus 5.5 · d••• · не обслуживает Opus 5.5',
      'plain: Opus 5.5 · переключено на k•••: d••• не обслуживает Opus 5.5',
    ],
    s9: [
      'eventFailure: Opus 5.5 · d••• · повтор отменён через 45 с без ответа',
      'eventFailure: Opus 5.5 · d••• · повтор ответил, затем отменён через 45 с',
      'plain: Opus 5.5 · переключено на k•••: вами после 2 мин 55 с ожидания',
      'eventKept: Opus 5.5 · k••• · повтор через 61 с: успешно',
    ],
  },
};

describe('Failures and moves', () => {
  test('a reloaded log through usage/session and the normalizer to the screen, in every language', async () => {
    for (const locale of LOCALES) {
      await i18n.changeLanguage(locale);
      for (const id of ['s7', 's8', 's9'] as const) {
        const markup = detailOf(id, locale);
        expect(markup, `${locale} ${id}`).toContain(`>${EXPECTED[locale].title}<`);
        expect(drawnEvents(markup), `${locale} ${id}`).toEqual(EXPECTED[locale][id] as string[]);
      }
    }
  });

  test('a session whose every attempt failed shows no models and no split, as it used nothing', async () => {
    await i18n.changeLanguage('en');
    const markup = detailOf('s7', 'en');
    expect(markup).not.toContain('>Models<');
    expect(markup).not.toContain('Main conversation and subagents');
    expect(detailOf('s9', 'en')).toContain('Main conversation and subagents');
  });

  test('a session without events has no such section', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: normalizeQuotaPilotUsageSession({ ...fixture.s9, events: [] })!,
        title: 's9',
        project: '',
        sources: [],
        range: 'week',
        locale: 'en',
      })
    );
    expect(markup).not.toContain('Failures and moves');
  });
});

/** An event as the normalizer gives it, with only what a test sets. */
const event = (e: Partial<QuotaPilotUsageEvent>): QuotaPilotUsageEvent => ({
  atMs: 1,
  event: 'failed',
  account: 'claude-d',
  label: 'd•••',
  to: '',
  toLabel: '',
  model: 'claude-opus-5-5',
  cause: '',
  status: 0,
  waitMs: 0,
  sinceFirstMs: 0,
  ok: false,
  answered: false,
  move: '',
  why: null,
  ...e,
});
const cause = (c: Partial<QuotaPilotMoveCause>): QuotaPilotMoveCause => ({
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
  ...c,
});
const moved = (move: string, why: Partial<QuotaPilotMoveCause>) =>
  event({ event: 'move', to: 'claude-k', toLabel: 'k•••', move, why: cause(why) });

// Every kind of event, in the words of the approved mockups' event table, in every language.
const KINDS: [string, QuotaPilotUsageEvent[], Record<(typeof LOCALES)[number], string>][] = [
  [
    'hang',
    [event({ cause: 'hang', waitMs: 135_000 })],
    {
      en: 'hung for 2m 15s',
      'zh-TW': '2 分 15 秒沒有回應',
      'zh-CN': '2 分 15 秒没有响应',
      ru: '2 мин 15 с без ответа',
    },
  ],
  [
    'connection',
    [event({ cause: 'connection' })],
    {
      en: 'lost its connection',
      'zh-TW': '連線中斷',
      'zh-CN': '连接中断',
      ru: 'соединение потеряно',
    },
  ],
  [
    'status',
    [event({ cause: 'overloaded', status: 529 })],
    {
      en: 'returned HTTP 529',
      'zh-TW': '回傳 HTTP 529',
      'zh-CN': '返回 HTTP 529',
      ru: 'вернул HTTP 529',
    },
  ],
  [
    'timeout',
    [event({ cause: 'timeout', status: 504 })],
    { en: 'timed out', 'zh-TW': '逾時', 'zh-CN': '超时', ru: 'превышено время ожидания' },
  ],
  [
    'rate',
    [event({ cause: 'rate', status: 429 })],
    {
      en: 'rate-limited',
      'zh-TW': '請求過於頻繁',
      'zh-CN': '请求过于频繁',
      ru: 'ограничение частоты запросов',
    },
  ],
  [
    'sign-in',
    [event({ cause: 'sign-in', status: 401 })],
    {
      en: 'refused sign-in (HTTP 401)',
      'zh-TW': '拒絕登入（HTTP 401）',
      'zh-CN': '拒绝登录（HTTP 401）',
      ru: 'отказ во входе (HTTP 401)',
    },
  ],
  [
    'model',
    [event({ cause: 'model', status: 404 })],
    {
      en: 'cannot serve Opus 5.5',
      'zh-TW': '無法使用 Opus 5.5',
      'zh-CN': '无法使用 Opus 5.5',
      ru: 'не обслуживает Opus 5.5',
    },
  ],
  [
    'retry worked',
    [event({ event: 'retry', sinceFirstMs: 61_000, ok: true })],
    {
      en: 'retry 61s later worked',
      'zh-TW': '61 秒後重試成功',
      'zh-CN': '61 秒后重试成功',
      ru: 'повтор через 61 с: успешно',
    },
  ],
  [
    'retry failed',
    [
      event({ cause: 'overloaded', status: 529 }),
      event({ event: 'retry', sinceFirstMs: 61_000, cause: 'overloaded', status: 529 }),
    ],
    {
      en: 'retry 61s later returned HTTP 529 again',
      'zh-TW': '61 秒後重試，再次回傳 HTTP 529',
      'zh-CN': '61 秒后重试，再次返回 HTTP 529',
      ru: 'повтор через 61 с: снова HTTP 529',
    },
  ],
  [
    'retry worked at once',
    [event({ event: 'retry', sinceFirstMs: 200, ok: true })],
    { en: 'retry worked', 'zh-TW': '重試成功', 'zh-CN': '重试成功', ru: 'повтор успешен' },
  ],
  [
    'retry hung',
    [event({ event: 'retry', cause: 'hang', waitMs: 118_000 })],
    {
      en: 'retry hung for 1m 58s',
      'zh-TW': '重試 1 分 58 秒沒有回應',
      'zh-CN': '重试 1 分 58 秒没有响应',
      ru: 'повтор: 1 мин 58 с без ответа',
    },
  ],
  [
    'retry cancelled',
    [event({ event: 'retry', cause: 'request', status: 499, waitMs: 45_000 })],
    {
      en: 'retry cancelled after 45s with no answer',
      'zh-TW': '重試 45 秒沒有回應，已取消',
      'zh-CN': '重试 45 秒没有响应，已取消',
      ru: 'повтор отменён через 45 с без ответа',
    },
  ],
  [
    'retry answered, then cancelled',
    [event({ event: 'retry', cause: 'request', status: 499, waitMs: 45_000, answered: true })],
    {
      en: 'retry answered, then cancelled after 45s',
      'zh-TW': '重試已開始回應，45 秒時取消',
      'zh-CN': '重试已开始响应，45 秒时取消',
      ru: 'повтор ответил, затем отменён через 45 с',
    },
  ],
  [
    'move: failed',
    [moved('failed', { kind: 'hang', waitMs: 135_000 })],
    {
      en: 'switched to k•••: d••• hung for 2m 15s',
      'zh-TW': '切換到 k•••：d••• 2 分 15 秒沒有回應',
      'zh-CN': '切换到 k•••：d••• 2 分 15 秒没有响应',
      ru: 'переключено на k•••: d••• 2 мин 15 с без ответа',
    },
  ],
  [
    'move: failed retry',
    [
      moved('failed', {
        kind: 'hang',
        waitMs: 135_000,
        retries: 1,
        lastRetry: cause({ kind: 'request', status: 499, waitMs: 40_000 }),
      }),
    ],
    {
      en: 'switched to k•••: d••• hung for 2m 15s; the retry got no answer',
      'zh-TW': '切換到 k•••：d••• 2 分 15 秒沒有回應，重試也沒有回應',
      'zh-CN': '切换到 k•••：d••• 2 分 15 秒没有响应，重试也没有响应',
      ru: 'переключено на k•••: d••• 2 мин 15 с без ответа; повтор тоже без ответа',
    },
  ],
  [
    'move: rest',
    [moved('rest', { kind: 'hang', count: 2 })],
    {
      en: 'switched to k•••: d••• resting after 2 failures',
      'zh-TW': '切換到 k•••：d••• 失敗 2 次，暫停使用',
      'zh-CN': '切换到 k•••：d••• 失败 2 次，暂停使用',
      ru: 'переключено на k•••: d••• в резерве после 2 сбоев',
    },
  ],
  [
    'move: left out',
    [moved('left-out', {})],
    {
      en: 'switched to k•••: the proxy left d••• out; no failure recorded',
      'zh-TW': '切換到 k•••：proxy 沒有提供 d•••，沒有記錄到失敗',
      'zh-CN': '切换到 k•••：proxy 没有提供 d•••，没有记录到失败',
      ru: 'переключено на k•••: прокси пропустил d•••; сбой не записан',
    },
  ],
  [
    'move: user',
    [moved('user', {})],
    {
      en: 'switched to k•••: switched by you',
      'zh-TW': '切換到 k•••：你切換的',
      'zh-CN': '切换到 k•••：你切换的',
      ru: 'переключено на k•••: вами',
    },
  ],
  [
    'move: user, switch now',
    [moved('user', { waitedMs: 175_000 })],
    {
      en: 'switched to k•••: by you after waiting 2m 55s',
      'zh-TW': '切換到 k•••：你等了 2 分 55 秒後切換的',
      'zh-CN': '切换到 k•••：你等了 2 分 55 秒后切换的',
      ru: 'переключено на k•••: вами после 2 мин 55 с ожидания',
    },
  ],
  [
    'move: quota',
    [moved('quota', { reason: 'weekly quota used up' })],
    {
      en: 'switched to k•••: d••• weekly quota used up',
      'zh-TW': '切換到 k•••：d••• 每週額度已用完',
      'zh-CN': '切换到 k•••：d••• 每周额度已用完',
      ru: 'переключено на k•••: недельная квота d••• исчерпана',
    },
  ],
  [
    'move: idle',
    [moved('idle', { reason: '5-hour quota low' })],
    {
      en: 'switched to k•••: d••• 5-hour quota low; moved while idle',
      'zh-TW': '切換到 k•••：d••• 5 小時額度偏低，閒置時切換',
      'zh-CN': '切换到 k•••：d••• 5 小时额度偏低，闲置时切换',
      ru: 'переключено на k•••: 5-часовая квота d••• на исходе; во время простоя',
    },
  ],
  [
    'move: gone',
    [moved('gone', { reason: 'removed' })],
    {
      en: 'switched to k•••: d••• was removed',
      'zh-TW': '切換到 k•••：d••• 已移除',
      'zh-CN': '切换到 k•••：d••• 已移除',
      ru: 'переключено на k•••: d••• удалён',
    },
  ],
  [
    'move: disabled',
    [moved('gone', { reason: 'disabled' })],
    {
      en: 'switched to k•••: d••• is disabled',
      'zh-TW': '切換到 k•••：d••• 已停用',
      'zh-CN': '切换到 k•••：d••• 已停用',
      ru: 'переключено на k•••: d••• отключён',
    },
  ],
  [
    'move: sign-in',
    [moved('sign-in', { kind: 'sign-in', status: 401 })],
    {
      en: 'switched to k•••: d••• refused sign-in (HTTP 401)',
      'zh-TW': '切換到 k•••：d••• 拒絕登入（HTTP 401）',
      'zh-CN': '切换到 k•••：d••• 拒绝登录（HTTP 401）',
      ru: 'переключено на k•••: d••• отказ во входе (HTTP 401)',
    },
  ],
  [
    'move: model',
    [moved('model', { kind: 'model', status: 404, model: 'claude-opus-5-5' })],
    {
      en: 'switched to k•••: d••• cannot serve Opus 5.5',
      'zh-TW': '切換到 k•••：d••• 無法使用 Opus 5.5',
      'zh-CN': '切换到 k•••：d••• 无法使用 Opus 5.5',
      ru: 'переключено на k•••: d••• не обслуживает Opus 5.5',
    },
  ],
];

describe('event words', () => {
  test('every kind of event, in every language', async () => {
    for (const locale of LOCALES) {
      await i18n.changeLanguage(locale);
      for (const [name, events, words] of KINDS) {
        expect(eventText(i18n.t, events, events.length - 1).text, `${locale} ${name}`).toBe(
          words[locale]
        );
      }
    }
  });

  test('a failure reads in the warning colour, a retry that worked in the success colour, a move plainly', () => {
    expect(eventText(i18n.t, [event({ cause: 'hang', waitMs: 135_000 })], 0).tone).toBe('failure');
    expect(
      eventText(i18n.t, [event({ event: 'retry', cause: 'overloaded', status: 529 })], 0).tone
    ).toBe('failure');
    expect(eventText(i18n.t, [event({ event: 'retry', ok: true })], 0).tone).toBe('kept');
    expect(eventText(i18n.t, [moved('user', {})], 0).tone).toBe('plain');
  });
});

describe('a session whose every attempt failed', () => {
  test('its row says so in place of its share, after the sessions that ran, in every language', async () => {
    const usage = normalizeQuotaPilotUsage({
      mode: 'provider',
      scope: 'provider:claude',
      provider: 'claude',
      range: 'week',
      capacity: 1,
      used: 0.1,
      known: true,
      providers: [
        { provider: 'claude', accounts: [{ id: 'claude-d', label: 'd•••', email: 'd•••' }] },
      ],
      projects: [
        {
          name: 'jesse',
          path: '/x/jesse',
          used: 0.1,
          metered: true,
          requests: 1,
          sessions: [
            {
              id: 's1',
              title: 'Ran',
              used: 0.1,
              metered: true,
              requests: 1,
              accounts: ['claude-d'],
              providers: ['claude'],
            },
            {
              id: 's7',
              title: 'Outage',
              used: 0,
              requests: 0,
              accounts: [],
              providers: [],
              no_success: true,
            },
          ],
        },
      ],
    })!;
    const words = {
      en: 'no successful request',
      'zh-TW': '沒有成功的請求',
      'zh-CN': '没有成功的请求',
      ru: 'нет успешных запросов',
    };
    for (const locale of LOCALES) {
      await i18n.changeLanguage(locale);
      const markup = renderToStaticMarkup(
        createElement(UsageTable, { usage, search: '', now: 1_792_000_000_000 })
      );
      expect(markup, locale).toContain(
        `<span role="cell" class="noSuccess">${words[locale]}</span>`
      );
      expect(markup.indexOf('data-session="s1"'), locale).toBeLessThan(
        markup.indexOf('data-session="s7"')
      );
    }
  });
});
