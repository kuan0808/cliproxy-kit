import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaUsageView, type QuotaUsageViewProps } from '@/features/quota/components/QuotaUsage';
import { SessionDetailView } from '@/features/quota/components/QuotaUsageTable';
import { refreshUsage, useUsageVersion } from '@/features/quota/usageRefresh';
import {
  formatDate,
  formatDayTime,
  formatRate,
  formatShare,
  formatTime,
  formatTokens,
  modelName,
  projectSources,
  sessionSource,
  splitAutomated,
} from '@/features/quota/usageFormat';
import {
  normalizeQuotaPilotUsage,
  normalizeQuotaPilotUsageSession,
  quotaPilotApi,
} from '@/services/api/quotaPilot';

const H = 3_600_000;
const NOW_MS = Date.UTC(2026, 9, 5, 4, 0);
const tokens = { input: 10, output: 2_000, cache_read: 4_000_000, cache_write: 30_000 };
const weights = { input: 50, output: 50_000, cache_read: 2_000_000, cache_write: 300_000 };

const account = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  plan: 'Max 20x',
  provider: 'claude',
  reset_at: new Date(NOW_MS + 48 * H).toISOString(),
  order: 1,
  sessions: 0,
  used: 0,
  known: true,
  before_log: 0,
  outside: 0,
  projects: {},
  ...extra,
});

const providers = [
  {
    provider: 'claude',
    accounts: [
      account('claude-k.json', 'k•••', {
        sessions: 6,
        used: 0.01,
        projects: { 'cliproxy-kit': 0.01 },
      }),
      account('claude-d.json', 'd•••', {
        order: 2,
        used: 1,
        before_log: 0.96,
        outside: 0.01,
        projects: { 'cliproxy-kit': 0.02, '~': 0.01 },
        covered_from: NOW_MS - 2 * H,
      }),
    ],
  },
  {
    provider: 'codex',
    accounts: [
      account('codex-k.json', 'k•••', {
        provider: 'codex',
        plan: 'Pro 200',
        used: 0.19,
        before_log: 0.19,
      }),
    ],
  },
];

// Seven days of one provider: the first two before readings began, the third quiet.
const week7 = (provider: string) =>
  Array.from({ length: 7 }, (_, i) => ({
    day: new Date(NOW_MS - (6 - i) * 24 * H).toISOString().slice(0, 10),
    metered: i >= 2,
    // Requests ran on the days before readings too: only their tokens are known.
    requests: i === 2 ? 0 : 12,
    tokens: { output: 3000, cache_read: 90_000 },
    ...(i >= 3 && {
      projects: { 'cliproxy-kit': 0.1, '~': provider === 'codex' ? 0 : 0.05 },
      outside: 0.01,
      sessions: [
        { id: 'aaaaaaaa-1', title: 'Band redesign', used: 0.1 },
        { id: '', title: '', used: null },
      ],
    }),
  }));

const projects = [
  {
    name: 'cliproxy-kit',
    path: '/Users/me/cliproxy-kit',
    used: 0.03,
    requests: 150,
    last: NOW_MS - 60_000,
    tokens,
    sessions: [
      {
        id: 'aaaaaaaa-1',
        title: 'Band redesign',
        used: 0.02,
        requests: 120,
        last: NOW_MS - 60_000,
        tokens,
        accounts: ['claude-d.json', 'claude-k.json'],
      },
      {
        id: 'bbbbbbbb-2',
        title: '',
        used: 0.01,
        requests: 30,
        last: NOW_MS - 2 * H,
        tokens,
        accounts: ['claude-gone.json'],
      },
    ],
  },
  {
    name: '~',
    path: '/Users/me',
    used: 0.01,
    requests: 4,
    last: NOW_MS - 3 * H,
    tokens,
    sessions: [
      {
        id: 'cccc',
        title: 'Home chat',
        used: 0.01,
        requests: 4,
        last: NOW_MS - 3 * H,
        tokens,
        accounts: ['claude-d.json'],
      },
    ],
  },
  {
    name: '',
    path: '',
    used: 0.0004,
    requests: 1,
    last: NOW_MS - 4 * H,
    tokens,
    sessions: [
      { id: '', title: '', used: 0.0004, requests: 1, last: NOW_MS - 4 * H, tokens, accounts: [] },
    ],
  },
];

const rawProvider = {
  mode: 'provider',
  scope: 'provider:claude',
  provider: 'claude',
  capacity: 2,
  range: 'week',
  from: NOW_MS - 6 * 24 * H,
  to: NOW_MS,
  used: 1.01,
  before_log: 0.96,
  outside: 0.01,
  log_start: NOW_MS - 2 * H,
  composition: { requests: 155, tokens, weights },
  projects,
  providers,
};

const report = (raw: Record<string, unknown>) =>
  normalizeQuotaPilotUsage({ ...rawProvider, ...raw })!;
const usage = report({});

const baseProps: QuotaUsageViewProps = {
  scope: 'provider:claude',
  onPick: () => {},
  range: 'week',
  onRange: () => {},
  state: { status: 'ready', usage, latest: usage },
  tab: 'all',
  search: '',
  resolvedTheme: 'dark',
  now: NOW_MS,
};

const render = (props: Partial<QuotaUsageViewProps> = {}) =>
  renderToStaticMarkup(createElement(QuotaUsageView, { ...baseProps, ...props }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('usage report', () => {
  test('normalizes every scope and rejects anything else', () => {
    expect(usage.mode).toBe('provider');
    expect(usage.capacity).toBe(2);
    expect(usage.providers.map((p) => p.provider)).toEqual(['claude', 'codex']);
    expect(usage.providers[0].accounts[0]).toMatchObject({
      label: 'k•••',
      sessions: 6,
      known: true,
    });
    expect(usage.providers[0].accounts[1].projects).toEqual({ 'cliproxy-kit': 0.02, '~': 0.01 });
    expect(usage.composition.weights.cacheWrite).toBe(300_000);
    expect(usage.projects[0].sessions[0].accounts).toEqual(['claude-d.json', 'claude-k.json']);
    expect(usage.range).toBe('week');
    expect(usage.daily).toEqual({});
    // Combined use runs past 100% across accounts.
    expect(usage.used).toBe(1.01);
    const ranged = report({
      mode: 'all',
      range: '7d',
      totals: { Claude: { capacity: 2, used: 2.4, known: true, before_log: 0, outside: 0.1 } },
      daily: { Claude: week7('claude') },
      projects: [{ ...projects[0], used_by: { claude: 1.3, codex: 0.4 }, metered: true }],
    });
    expect(ranged.range).toBe('7d');
    // Over a range a provider's total runs past 100% of one account.
    expect(ranged.totals.claude).toEqual({
      capacity: 2,
      used: 2.4,
      known: true,
      beforeLog: 0,
      unplaced: 0,
      undated: 0,
      outside: 0.1,
      unread: [],
    });
    expect(ranged.daily.claude).toHaveLength(7);
    expect(ranged.daily.claude[3]).toMatchObject({
      metered: true,
      projects: { 'cliproxy-kit': 0.1, '~': 0.05 },
      outside: 0.01,
    });
    expect(ranged.projects[0]).toMatchObject({
      usedBy: { claude: 1.3, codex: 0.4 },
      metered: true,
    });
    expect(report({ range: 'year' }).range).toBe('week');
    expect(normalizeQuotaPilotUsage({ mode: 'weekly' })).toBeNull();
    expect(normalizeQuotaPilotUsage(null)).toBeNull();
  });

  test('normalizes a session report', () => {
    const detail = normalizeQuotaPilotUsageSession({
      id: '',
      unit: 'decade',
      buckets: [
        { at: NOW_MS, weight: 3, requests: 2 },
        { at: 0, weight: 1 },
      ],
      accounts: [{ id: 'x', label: '', provider: 'Claude', weight: 1 }],
    })!;
    expect(detail.unit).toBe('day');
    expect(detail.buckets).toMatchObject([{ atMs: NOW_MS, weight: 3, requests: 2, quota: {} }]);
    expect(detail.accounts[0].provider).toBe('claude');
    expect(normalizeQuotaPilotUsageSession({})).toBeNull();
  });

  test('formats shares, rates, tokens and model names', () => {
    expect([0, 0.0004, 0.042, 0.52].map(formatShare)).toEqual(['0%', '<0.1%', '4.2%', '52%']);
    expect(formatRate(0.9942)).toBe('99.4%');
    expect(formatDayTime(Date.UTC(2026, 9, 9, 23, 59, 59, 800), 'en')).toBe(
      formatDayTime(Date.UTC(2026, 9, 10), 'en')
    );
    expect([387, 4_200, 38_000, 1_900_000, 35_100_000_000].map(formatTokens)).toEqual([
      '387',
      '4.2k',
      '38k',
      '1.9M',
      '35.1B',
    ]);
    expect(
      ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-6.1-sol'].map(
        modelName
      )
    ).toEqual(['Opus 5.5', 'Haiku 4.5', 'Sonnet 5', 'gpt-6.1-sol']);
  });
});

describe('usage view', () => {
  test('picker: provider groups hold their accounts, in use first, all providers apart', () => {
    const markup = render();
    expect(markup).toContain('2 accounts · weekly quota');
    expect(markup).toContain('>Total<');
    expect(markup).toContain('k••• + d•••');
    expect(markup).toContain('In use · 6 sessions');
    expect(markup.indexOf('In use · 6 sessions')).toBeLessThan(markup.indexOf('>d•••<'));
    expect(markup).toContain('1 account · weekly quota'); // Codex: one account, no total row
    expect(markup).toContain('All providers');
    // All providers sets each provider's week side by side, in its own unit.
    const card = markup.slice(markup.indexOf('class="allCard"'));
    expect(card).toContain('101%<small>/ 200%</small>');
    expect(card).toContain('19%<small>/ 100%</small>');
    expect(markup).toContain('aria-pressed="true"');
  });

  test('the range switch sits apart from the scope and shows which range is on', () => {
    const markup = render({ range: '30d' });
    const range = markup.slice(markup.indexOf('aria-label="Time range"'));
    expect(range).toContain('<button type="button" aria-pressed="false">This quota week</button>');
    expect(range).toContain('<button type="button" aria-pressed="true">Last 30 days</button>');
  });

  test('provider total: one slot per account, notes, and an account column', () => {
    const markup = render();
    expect(markup).toContain('101%');
    expect(markup).toContain('/ 200%');
    expect(markup).toContain('weekly quota of 2 accounts added up');
    expect(markup).toContain('This week · each account on its own week');
    expect(markup).toContain('Used before logging');
    expect(markup).toContain('It goes away once d•••');
    expect(markup).not.toContain('It goes away once k•••');
    expect(markup).toContain('Not matched to a request');
    expect(markup).toContain('Accounts');
    expect(markup).toContain('Account not on the proxy');
    expect(markup).toContain('Untitled session bbbbbbbb');
    expect(markup).toContain('Home folder (~)');
    expect(markup).toContain('Unsorted');
    expect(markup).toContain('Requests not in any session');
    expect(markup).toContain('Cache hit rate');
    expect(markup).toContain('How these numbers are made');
  });

  test('the rows no session holds name the accounts they come from', () => {
    const markup = render();
    // In the table (the legend above it holds the same hints), a row's title starts with its hint;
    // its cells run to the next row.
    const rowOf = (hint: string) => {
      const at = markup.indexOf(`title="${hint}`, markup.indexOf('role="table"'));
      expect(at).toBeGreaterThan(-1);
      const end = markup.indexOf('role="row"', at);
      return markup.slice(at, end < 0 ? undefined : end);
    };
    for (const hint of [
      'Used before logging began; it cannot be split by session',
      'The reading rose more than the requests through the proxy explain',
    ]) {
      const row = rowOf(hint);
      expect(row).toContain('>d•••</span>');
      expect(row).not.toContain('>k•••</span>');
    }
  });

  test('a provider total can pass 100% for one project', () => {
    const big = report({
      projects: [
        { ...projects[0], used: 1.5, sessions: [{ ...projects[0].sessions[0], used: 1.2 }] },
      ],
    });
    expect(big.projects[0].used).toBe(1.5);
    expect(big.projects[0].sessions[0].used).toBe(1.2);
  });

  test('Codex is counted from the proxy, as Claude is', () => {
    const codex = report({
      mode: 'account',
      scope: 'codex-k.json',
      provider: '',
      capacity: 1,
      used: 0.25,
      before_log: 0,
      outside: 0.04,
      projects: [],
    });
    const markup = render({
      scope: 'codex-k.json',
      state: { status: 'ready', usage: codex, latest: codex },
    });
    expect(markup).toContain('No request has gone through the proxy since logging began');
    // What the requests cannot explain claims no source, and its hint names the proxy.
    expect(markup).toContain('Not matched to a request');
    expect(markup).toContain('requests through the proxy explain: most likely use outside the proxy');
    expect(markup).not.toContain('this Mac');
  });

  test('one account with nothing logged yet: no projects, no token card, says why', () => {
    const covered = providers.map((p) => ({
      ...p,
      accounts: p.accounts.map((a) => ({ ...a, covered_from: NOW_MS - H })),
    }));
    const codex = report({
      mode: 'account',
      scope: 'codex-k.json',
      provider: '',
      capacity: 1,
      used: 0.19,
      before_log: 0.19,
      outside: 0,
      projects: [],
      providers: covered,
      composition: { requests: 0 },
    });
    const markup = render({
      scope: 'codex-k.json',
      state: { status: 'ready', usage: codex, latest: codex },
    });
    expect(markup).toContain('Pro 200');
    expect(markup).toContain('19%');
    expect(markup).toContain('/ 100%');
    // All of it came before logging, so that is the one thing to say.
    expect(markup).toContain('Hatched: the 19% used before logging began');
    expect(markup).not.toContain('This Mac has no Codex use recorded');
    expect(markup).toContain('No projects to list yet.');
    expect(markup).not.toContain('Cache hit rate');
  });

  test('a Codex view names where each session came from', () => {
    const codexProjects = [
      {
        name: 'voice-notes',
        path: '/x/voice-notes',
        used: 0.08,
        requests: 10,
        last: NOW_MS,
        tokens,
        sessions: [
          {
            id: 'c1',
            title: 'Code review, round 3',
            used: 0.05,
            requests: 6,
            last: NOW_MS,
            tokens,
            accounts: ['codex-k.json'],
            origin: 'Claude Code',
          },
          {
            id: 'c2',
            title: 'Plan',
            used: 0.02,
            requests: 3,
            last: NOW_MS,
            tokens,
            accounts: ['codex-k.json'],
            origin: 'codex-tui',
          },
          {
            id: 'claude-s',
            title: 'Routed session',
            used: 0.01,
            requests: 1,
            last: NOW_MS,
            tokens,
            accounts: ['codex-k.json'],
          },
        ],
      },
    ];
    const codex = report({
      mode: 'account',
      scope: 'codex-k.json',
      provider: '',
      capacity: 1,
      used: 0.19,
      before_log: 0,
      outside: 0,
      projects: codexProjects,
    });
    const markup = render({
      scope: 'codex-k.json',
      state: { status: 'ready', usage: codex, latest: codex },
    });
    // Codex started by Claude Code is a program's run; the others name their app.
    expect(markup).toContain('Automated</span>');
    expect(markup).toContain('Codex CLI</span>');
    expect(markup).toContain('Claude Code via proxy</span>');
    // A project whose sessions share one source says it once, on the project.
    const one = report({
      mode: 'account',
      scope: 'codex-k.json',
      provider: '',
      capacity: 1,
      used: 0.1,
      before_log: 0,
      outside: 0,
      projects: [{ ...codexProjects[0], sessions: codexProjects[0].sessions.slice(0, 1) }],
    });
    const single = render({
      scope: 'codex-k.json',
      state: { status: 'ready', usage: one, latest: one },
    });
    expect(single).toContain('Automated</span>1 session');
    expect(single.split('Automated</span>').length - 1).toBe(1);
    // In a Claude view a Claude Code session needs no tag.
    expect(render()).not.toContain('Claude Code via proxy');
    // A program's run says so; which program waits for the session's detail.
    const sdk = report({
      projects: [
        {
          ...projects[0],
          sessions: [
            { ...projects[0].sessions[0], origin: 'sdk-py' },
            { ...projects[0].sessions[1], origin: 'sdk-cli' },
          ],
        },
      ],
    });
    const runs = render({ state: { status: 'ready', usage: sdk, latest: sdk } });
    expect(runs).toContain('Automated</span>2 sessions');
    expect(runs).not.toContain('Agent SDK');
    expect(runs).not.toContain('claude -p');
  });

  test("programs' runs gather under one row beside the sessions a person ran", () => {
    const reviews = Array.from({ length: 3 }, (_, i) => ({
      ...projects[0].sessions[1],
      id: `review-${i}`,
      title: `Security review ${i}`,
      origin: 'sdk-py',
    }));
    const gathered = report({
      projects: [{ ...projects[0], sessions: [projects[0].sessions[0], ...reviews] }],
    });
    const state = { status: 'ready' as const, usage: gathered, latest: gathered };
    const closed = render({ state });
    expect(closed).toContain('4 sessions</span> · ');
    expect(closed).toContain('Automated</span>3');
    // One row for the three, closed, with their figures added up; the person's session is listed.
    expect(closed).toContain('Band redesign');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('3 sessions</span>');
    expect(closed).not.toContain('Security review 0');
    // A search that finds one of them opens the row.
    expect(render({ state, search: 'security review 2' })).toContain('Security review 2');
    // Rows open with a real button, not a row that pretends to be one.
    expect(closed).not.toContain('<button type="button" role="row"');
    expect(closed).toContain('role="row"');
  });

  test("over 5 hours: the running windows, the last day's windows, and accounts without one", () => {
    const fiveProviders = [
      {
        provider: 'claude',
        accounts: [
          account('claude-k.json', 'k•••', {
            used: 0.07,
            reset_at: new Date(NOW_MS + 4 * H).toISOString(),
            restarted_at: NOW_MS - H,
            projects: { 'cliproxy-kit': 0.07 },
          }),
          // No window running: the next request starts one.
          account('claude-d.json', 'd•••', { order: 2, used: 0, reset_at: null }),
        ],
      },
      {
        provider: 'codex',
        accounts: [
          account('codex-k.json', 'k•••', {
            provider: 'codex',
            known: false,
            used: 0,
            no_window: true,
          }),
        ],
      },
    ];
    const window = (
      from: number,
      to: number,
      used: number,
      extra: Record<string, unknown> = {}
    ) => ({
      account: 'claude-k.json',
      from,
      to,
      used,
      requests: 9,
      tokens: { output: 900 },
      projects: { 'cliproxy-kit': used },
      sessions: [{ id: 'aaaaaaaa-1', title: 'Band redesign', used }],
      ...extra,
    });
    const five = report({
      range: '5h',
      capacity: 2,
      used: 0.07,
      before_log: 0,
      outside: 0,
      providers: fiveProviders,
      windows: {
        claude: [
          window(NOW_MS - 10 * H, NOW_MS - 5 * H, 0.6),
          window(NOW_MS - H, NOW_MS + 4 * H, 0.07, { running: true }),
        ],
      },
      windows_from: NOW_MS - 12 * H,
    });
    expect(five.range).toBe('5h');
    expect(five.providers[0].accounts[0].restartedAtMs).toBe(NOW_MS - H);
    expect(five.providers[1].accounts[0].noWindow).toBe(true);
    expect(five.windows.claude).toHaveLength(2);
    const markup = render({ range: '5h', state: { status: 'ready', usage: five, latest: five } });
    expect(markup).toContain('<button type="button" aria-pressed="true">5-hour window</button>');
    // The picker speaks of 5-hour quota; Codex has none.
    expect(markup).toContain('2 accounts · 5-hour quota');
    expect(markup).toContain('No window running: the next request starts one');
    expect(markup).toContain('No 5-hour window');
    // The summary: the running windows, the window that started over, and the last day's windows.
    expect(markup).toContain('5-hour quota of 2 accounts added up');
    expect(markup).toContain('k••• started over on');
    expect(markup).toContain('this window counts from then. The window before shows in the bars above.');
    expect(markup).toContain('aria-label="5-hour windows of the last day, coloured by project"');
    expect(markup).toContain('60% of the window');
    expect(markup).toContain('running: 7.0% of the window');
    expect(markup).toContain('Some earlier 5-hour windows are not listed: readings before');
    // The table counts in parts of a 5-hour window.
    expect(markup).toContain('5-hour quota<span class="optional"> (of 200%)</span>');
    expect(markup).toContain('5-hour window: each account');
    expect(markup).not.toContain('Usage per day');
    // The window before is not a bar when its readings did not name their reset.
    const alone = { ...five, windows: { claude: five.windows.claude.filter((w) => w.running) } };
    const aloneMarkup = render({ range: '5h', state: { status: 'ready', usage: alone, latest: alone } });
    expect(aloneMarkup).toContain('this window counts from then.');
    expect(aloneMarkup).not.toContain('The window before shows in the bars above.');
  });

  test('a week that started over in place counts from then', () => {
    const restarted = report({
      providers: providers.map((p) => ({
        ...p,
        accounts: p.accounts.map((a) =>
          a.id === 'claude-k.json' ? { ...a, restarted_at: NOW_MS - 3 * H } : a
        ),
      })),
    });
    const markup = render({ state: { status: 'ready', usage: restarted, latest: restarted } });
    expect(markup).toContain('k••• started over on');
    expect(markup).toContain(
      'this week counts from then. What it used before shows in the last 7 days.'
    );
  });

  test('an account without a reading shows no figure', () => {
    const unread = providers.map((p) => ({
      ...p,
      accounts: p.accounts.map((a) => ({ ...a, known: false, used: 0, before_log: 0 })),
    }));
    const blank = report({
      mode: 'account',
      scope: 'claude-k.json',
      capacity: 1,
      used: 0,
      before_log: 0,
      outside: 0,
      projects: [],
      providers: unread,
      composition: {},
    });
    const markup = render({
      scope: 'claude-k.json',
      state: { status: 'ready', usage: blank, latest: blank },
    });
    expect(markup).toContain('Not read this week');
    expect(markup).toContain('No quota reading this week yet');
    expect(markup).not.toContain('>0%<');
  });

  test('all providers over the week: each provider in its own unit, never added', () => {
    const all = report({
      mode: 'all',
      scope: 'all',
      provider: '',
      capacity: 0,
      used: 1,
      before_log: 0,
      outside: 0,
      totals: {
        claude: { capacity: 2, used: 1.01, before_log: 0.96, outside: 0.01 },
        codex: { capacity: 1, used: 0.19, before_log: 0.19, outside: 0 },
      },
      projects: [
        {
          ...projects[0],
          used_by: { claude: 0.03, codex: 0.05 },
          metered: true,
          sessions: [
            {
              ...projects[0].sessions[0],
              used_by: { claude: 0.02 },
              metered: true,
              providers: ['claude'],
            },
            // Used Codex where no reading covers it: a dash, not a blank.
            {
              ...projects[0].sessions[1],
              used_by: { claude: 0.01 },
              metered: true,
              providers: ['claude', 'codex'],
            },
          ],
        },
      ],
    });
    const markup = render({ scope: 'all', state: { status: 'ready', usage: all, latest: all } });
    expect(markup).toContain('Each provider in its own quota, never added together');
    expect(markup).toContain('Claude quota');
    expect(markup).toContain('Codex quota');
    expect(markup).toContain('data-layout="quotaAll"');
    const summary = markup.slice(
      markup.indexOf('class="summary"'),
      markup.indexOf('class="tableBlock"')
    );
    expect(summary).toContain('101%');
    expect(summary).toContain('/ 200%');
    expect(summary).toContain('/ 100%');
    // 101% and 19% are never shown as one figure.
    expect(summary).not.toContain('120%');
    expect(markup).toContain(
      'title="Used, but not in the quota: its account is not known or not on the proxy, or no reading covers that time"'
    );
    // Before-logging and outside rows hold one provider's unit, so all providers lists neither.
    expect(markup).not.toContain('specialRow');
  });

  test('a range: what it used across weeks, each day, and days before readings', () => {
    const covered = providers.map((p) => ({
      ...p,
      accounts: p.accounts.map((a) => ({
        ...a,
        covered_from: p.provider === 'claude' ? NOW_MS - 4 * 24 * H : NOW_MS - 40 * 24 * H,
      })),
    }));
    const ranged = report({
      mode: 'all',
      scope: 'all',
      range: '7d',
      from: NOW_MS - 6 * 24 * H,
      provider: '',
      capacity: 0,
      providers: covered,
      totals: {
        claude: { capacity: 2, used: 1.45, known: true, before_log: 0, outside: 0.04 },
        codex: {
          capacity: 1,
          used: 0.4,
          known: true,
          before_log: 0,
          unplaced: 0.03,
          outside: 0.04,
        },
      },
      daily: { claude: week7('claude'), codex: week7('codex') },
    });
    const markup = render({
      scope: 'all',
      range: '7d',
      state: { status: 'ready', usage: ranged, latest: ranged },
    });
    expect(markup).toContain('Last 7 days');
    expect(markup).toContain('145%');
    expect(markup).toContain('of one account&#x27;s weekly quota, added up across weeks');
    expect(markup).toContain('Claude quota');
    // Claude's first days come before its readings began; Codex's own records cover them all.
    const claude = markup.slice(
      markup.indexOf('var(--usage-claude)'),
      markup.indexOf('var(--usage-codex)')
    );
    const codex = markup.slice(markup.indexOf('var(--usage-codex)'));
    expect(claude.split('chartUnread').length - 1).toBe(2);
    expect(claude).toContain('Before logging began: tokens only');
    // The headline says when its readings begin when that is inside the range.
    expect(claude).toContain('logged since');
    expect(codex).not.toContain('logged since');
    expect(codex).not.toContain('chartUnread');
    expect(claude).toContain('Logging began on');
    // Use found at the first reading of a week begun before the range is said apart, not counted.
    expect(codex).toContain('3.0% more may lie on either side of the range start');
    expect(claude).not.toContain('may lie on either side');
    expect(markup).toContain('7 and 30 days: each account&#x27;s readings are followed');
    // Each day says what it used, in a weekly quota.
    expect(claude).toContain(': 16% of a weekly quota · ');
    // Its projects largest first, what no request explains last.
    expect(claude).toContain(
      '16% of a weekly quota · cliproxy-kit 10%, Home folder (~) 5.0%, Not matched to a request 1.0%'
    );
    expect(codex).toContain(': 11% of a weekly quota · ');
  });

  test('a project keeps one colour everywhere, and grey only means the other projects', () => {
    // Seven projects: the sixth overall is the largest on one account.
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'home', 'p7'];
    const many = names.map((name, i) => ({
      ...projects[0],
      name,
      path: `/x/${name}`,
      used: 0.1 - i * 0.01,
    }));
    const parts = Object.fromEntries(names.map((name) => [name, name === 'home' ? 0.3 : 0.01]));
    const accounts = providers.map((p) => ({
      ...p,
      accounts: p.accounts.map((a, i) =>
        p.provider === 'claude' && i === 0 ? { ...a, used: 0.37, projects: parts } : a
      ),
    }));
    const one = report({
      mode: 'account',
      scope: 'claude-k.json',
      capacity: 1,
      used: 0.37,
      before_log: 0,
      outside: 0,
      projects: many,
      providers: accounts,
    });
    const markup = render({
      scope: 'claude-k.json',
      state: { status: 'ready', usage: one, latest: one },
    });
    const start = markup.indexOf('class="legend"');
    const legend = markup.slice(start, markup.indexOf('</ul>', start));
    expect(legend).toContain(
      'background:var(--usage-6)" aria-hidden="true"></span><span class="legendName">home'
    );
    // Five named, the other two in one grey line.
    expect(legend.split('class="dot"').length - 1).toBe(6);
    expect(legend).toContain('Other projects<span class="legendValue">2.0%');
  });

  test('times are told against the report when the clock has not ticked since', () => {
    const fresh = report({
      to: NOW_MS + 50_000,
      projects: [{ ...projects[0], last: NOW_MS + 40_000 }],
    });
    const markup = render({ state: { status: 'ready', usage: fresh, latest: fresh } });
    expect(markup).not.toContain('in 1 minute');
    expect(markup).not.toContain(' from now');
  });

  test('a range without any reading says its use is not known, not 0%', () => {
    const blank = report({
      range: '30d',
      known: false,
      used: 0,
      before_log: 0,
      outside: 0,
      daily: { claude: week7('claude').map((d) => ({ day: d.day, metered: false })) },
    });
    const markup = render({
      range: '30d',
      state: { status: 'ready', usage: blank, latest: blank },
    });
    const summary = markup.slice(
      markup.indexOf('class="summary"'),
      markup.indexOf('class="tableBlock"')
    );
    expect(summary).toContain('class="bigValue">—<');
    expect(summary).toContain('No quota reading fell in this range');
    expect(summary).not.toContain('Nothing used in this range');
  });

  test('each day can be read without a pointer, and accounts read from different times say so', () => {
    const staggered = providers.map((p) => ({
      ...p,
      accounts: p.accounts.map((a, i) => ({ ...a, covered_from: NOW_MS - (i + 1) * 24 * H })),
    }));
    const ranged = report({
      mode: 'provider',
      range: '7d',
      from: NOW_MS - 6 * 24 * H,
      known: true,
      used: 0.4,
      providers: staggered,
      daily: { claude: week7('claude') },
    });
    const markup = render({
      range: '7d',
      state: { status: 'ready', usage: ranged, latest: ranged },
    });
    expect(markup).toContain('logged since k•••');
    expect(markup).toContain(', d•••');
    // A day is a button named with its figures; one of them takes the tab stop.
    expect(markup).toMatch(
      /<button type="button" class="chartDay" aria-label="[^"]+: 16% of a weekly quota · /
    );
    expect(markup.split('tabindex="0"').length - 1).toBeGreaterThanOrEqual(1);
    // The card shows the latest day with use from the start, the same rows for every day.
    const card = markup.slice(markup.indexOf('class="barCard"'));
    expect(card).toContain('16% of a weekly quota');
    for (const row of ['Projects', 'Sessions', 'Use']) expect(card).toContain(`<dt>${row}</dt>`);
    // Each of the day's largest sessions opens in the table; one no reading settled has no figure.
    expect(card).toContain('title="Band redesign">Band redesign</button> 10%');
    expect(card).toContain('>Requests not in any session</button></dd>');
    expect(card).toContain('12 requests · output 3.0k · cache read 90k');
  });

  test('a known 0% stays 0%, an account off the proxy says so, and Codex via the proxy is named in all providers', () => {
    const off = providers.map((p) =>
      p.provider === 'codex'
        ? {
            ...p,
            accounts: [
              ...p.accounts,
              account('chatgpt:abcd-1', 'abcd•••', { provider: 'codex', off_proxy: true }),
            ],
          }
        : p
    );
    const all = report({
      mode: 'all',
      scope: 'all',
      provider: '',
      providers: off,
      totals: {
        claude: { capacity: 2, used: 0.1, known: true },
        codex: { capacity: 2, used: 0.2, known: true },
      },
      projects: [
        {
          ...projects[0],
          used_by: { claude: 0, codex: 0.05 },
          metered: true,
          sessions: [
            {
              ...projects[0].sessions[0],
              used_by: { claude: 0, codex: 0.05 },
              metered: true,
              providers: ['claude', 'codex'],
            },
          ],
        },
      ],
    });
    expect(all.projects[0].usedBy).toEqual({ claude: 0, codex: 0.05 });
    const markup = render({ scope: 'all', state: { status: 'ready', usage: all, latest: all } });
    const table = markup.slice(markup.indexOf('role="table"'));
    expect(table).toContain('<span class="value">0%</span>');
    expect(table).toContain('Claude Code via proxy');
    expect(markup).toContain('Account not on the proxy');
  });

  test('a range with no reading hatches every day; accounts unread and use read across midnight are said', () => {
    const blank = report({
      range: '7d',
      known: false,
      used: 0,
      before_log: 0,
      outside: 0,
      daily: { claude: week7('claude') },
    });
    const none = render({ range: '7d', state: { status: 'ready', usage: blank, latest: blank } });
    expect(none.split('chartDay chartUnread').length - 1).toBe(7);
    // No reading at all is not the same as before logging began.
    expect(none).toContain('No quota reading: tokens only');
    expect(none).not.toContain('Before logging began');
    const partial = report({
      range: '7d',
      known: true,
      used: 0.3,
      before_log: 0,
      outside: 0.05,
      undated: 0.02,
      unread: ['claude-d.json'],
      daily: { claude: week7('claude') },
    });
    const markup = render({
      range: '7d',
      state: { status: 'ready', usage: partial, latest: partial },
    });
    expect(markup).toContain('d••• had no quota reading in this range');
    expect(markup).toContain('2.0% of the use not matched to a request was read across midnight');
    expect(markup).not.toContain('Nothing used in this range');
  });

  test('a provider with no account on the proxy shows in the report, not in the picker', () => {
    const tokensOnly = [...providers, { provider: 'gemini', accounts: [] }];
    const all = report({
      mode: 'all',
      scope: 'all',
      range: '30d',
      provider: '',
      providers: tokensOnly,
      totals: { gemini: { capacity: 0, used: 0, known: false } },
      daily: { gemini: week7('gemini').map((d) => ({ day: d.day, metered: false })) },
    });
    const markup = render({
      scope: 'all',
      range: '30d',
      state: { status: 'ready', usage: all, latest: all },
    });
    const picker = markup.slice(0, markup.indexOf('class="summary"'));
    expect(picker).not.toContain('Gemini');
    expect(markup).toContain('No account on the proxy');
    expect(markup).toContain('Gemini quota');
  });

  test('nothing used is said only when every account was read', () => {
    const zero = report({
      range: '7d',
      known: true,
      used: 0,
      before_log: 0,
      outside: 0,
      unread: ['claude-d.json'],
      daily: { claude: week7('claude') },
    });
    const ranged = render({ range: '7d', state: { status: 'ready', usage: zero, latest: zero } });
    expect(ranged).toContain('d••• had no quota reading in this range');
    expect(ranged).not.toContain('Nothing used in this range');
    const half = providers.map((p) => ({
      ...p,
      accounts: p.accounts.map((a, i) => ({ ...a, used: 0, before_log: 0, known: i === 0 })),
    }));
    const week = report({ used: 0, before_log: 0, outside: 0, providers: half, projects: [] });
    expect(render({ state: { status: 'ready', usage: week, latest: week } })).not.toContain(
      'Nothing used this week yet.'
    );
  });

  test('a provider tab shows that provider only', () => {
    const markup = render({ tab: 'claude' });
    expect(markup).not.toContain('All providers');
    expect(markup).not.toContain('Pro 200');
  });

  test('search narrows the table, not the summary', () => {
    const markup = render({ search: 'home' });
    expect(markup).toContain('Home chat');
    expect(markup).not.toContain('Band redesign');
    expect(markup).toContain('101%');
  });

  test('while another scope loads, the picker stays', () => {
    const markup = render({ state: { status: 'loading', latest: usage } });
    expect(markup).toContain('All providers');
    expect(markup).not.toContain('Cache hit rate');
  });

  test('without the plugin it says what is missing', () => {
    expect(render({ state: { status: 'unavailable', latest: null } })).toContain(
      'The quota-pilot plugin needs to be running.'
    );
  });
});

describe('session sources', () => {
  const run = (id: string, origin = '') => ({ id, origin });
  const sourceOf = (x: { origin: string }) => sessionSource(x.origin, false);

  test('a project says where its sessions came from, once when they all share it', () => {
    // A tool ran 38 reviews beside one session: 39 sessions, 38 of them automated.
    const tool = Array.from({ length: 38 }, (_, i) => run(`r${i}`, 'sdk-py'));
    expect(projectSources([run('a'), ...tool], sourceOf)).toMatchObject({
      sessions: 39,
      shared: false,
      sources: [{ source: { kind: 'auto' }, count: 38 }],
    });
    // Every program's run reads the same tag.
    expect(projectSources([run('p', 'sdk-py'), run('q', 'sdk-cli')], sourceOf)).toMatchObject({
      sessions: 2,
      shared: true,
      sources: [{ count: 2 }],
    });
    expect(projectSources([run('a'), run('b')], sourceOf)).toMatchObject({ sessions: 2, sources: [] });
    // Requests that came without a session are named so, never counted as one.
    expect(projectSources([run('')], sourceOf)).toMatchObject({ sessions: 0, none: true });
    expect(projectSources([run('r', 'remote')], sourceOf)).toMatchObject({
      shared: true,
      sources: [{ source: { kind: 'device' } }],
    });
    // In a Codex view Claude Code run by a person came through the proxy; a program's run stays
    // automated and an app keeps its name. An unknown origin shows as given.
    expect(sessionSource('', true)).toEqual({ kind: 'app', key: 'origin_proxy' });
    expect(sessionSource('sdk-py', true)).toMatchObject({ kind: 'auto' });
    expect(sessionSource('claude-desktop', true)).toMatchObject({ kind: 'app', key: 'origin_claude_desktop' });
    expect(sessionSource('something-new', false)).toEqual({ kind: 'app', key: '', raw: 'something-new' });
  });

  test("programs' runs gather only beside sessions a person ran, and only two or more", () => {
    const tool = Array.from({ length: 3 }, (_, i) => run(`r${i}`, 'sdk-py'));
    expect(splitAutomated([run('a'), ...tool], sourceOf)).toEqual({ listed: [run('a')], automated: tool });
    expect(splitAutomated(tool, sourceOf).automated).toEqual([]);
    expect(splitAutomated([run('a'), tool[0]], sourceOf).automated).toEqual([]);
    expect(splitAutomated([run(''), ...tool], sourceOf).automated).toEqual([]);
  });
});

describe('session detail', () => {
  test('tokens, time, models, accounts and subagents', () => {
    const detail = normalizeQuotaPilotUsageSession({
      id: 'aaaaaaaa-1',
      title: 'Band redesign',
      project: 'cliproxy-kit',
      first: NOW_MS - 2 * H,
      last: NOW_MS,
      composition: { requests: 120, tokens, weights },
      unit: 'hour',
      buckets: [
        {
          at: NOW_MS - 2 * H,
          weight: 5,
          requests: 3,
          tokens: { output: 1200, cache_read: 40_000 },
          agent: 1,
          models: [{ name: 'claude-opus-5-5', weight: 5 }],
          accounts: [{ name: 'claude-d.json', weight: 5 }],
          providers: [{ name: 'claude', weight: 5 }],
          quota: { claude: 0.004 },
        },
        { at: NOW_MS - H, weight: 0 },
        { at: NOW_MS, weight: 15, requests: 1, providers: [{ name: 'Codex', weight: 15 }] },
      ],
      models: [
        { name: 'claude-opus-5-5', weight: 90 },
        { name: 'claude-sonnet-5', weight: 10 },
      ],
      agent: 40,
      accounts: [
        { id: 'claude-d.json', label: 'd•••', provider: 'claude', weight: 60 },
        { id: 'codex-k.json', label: 'k•••', provider: 'codex', weight: 40 },
      ],
      history: false,
    })!;
    const markup = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail,
        title: 'Band redesign',
        project: 'cliproxy-kit',
        source: { kind: 'auto', key: 'why_claude_code' },
        range: 'week',
        locale: 'en',
      })
    );
    // The detail says in plain words where the session came from.
    expect(markup).toContain('Automated</span>Codex started by Claude Code, such as by its Codex plugin.');
    expect(markup).toContain('120 requests');
    expect(markup).toContain('d••• 60%');
    expect(markup).toContain('k••• (Codex) 40%');
    expect(markup).toContain('Opus 5.5');
    expect(markup).toContain('per hour');
    // Each hour can be picked and says what it was: its quota by provider, what its requests ran,
    // its models and subagents, and its accounts when the session had more than one.
    const hour = (ms: number) => formatTime(ms, 'en');
    const stretch = (ms: number) => `${formatDate(ms, 'en')} ${hour(ms)}–${hour(ms + H)}`;
    expect(markup).toContain(
      `${stretch(NOW_MS - 2 * H)}: Claude 0.4% · 3 requests · output 1.2k · cache read 40k · hit rate 100.0% · Opus 5.5 100% · Subagents 20% · d••• 100%"`
    );
    expect(markup).toContain(`${stretch(NOW_MS - H)}: No request"`);
    expect(markup).toContain(`${stretch(NOW_MS)}: Not settled by a reading yet`);
    // A stretch coloured by its provider; the latest with use is described to begin with.
    expect(markup).toContain('background:var(--usage-codex)');
    const card = markup.slice(markup.indexOf('class="barCard"'));
    expect(card).toContain(stretch(NOW_MS));
    expect(card).toContain('<dt>Accounts</dt>');
    expect(markup).toContain('Main 60%');
    expect(markup).toContain('Subagents 40%');
  });
});

describe('refreshing usage', () => {
  test('a refresh has the view read again, even when the plugin could not read', async () => {
    const Version = () => createElement('i', null, useUsageVersion());
    const read = () => renderToStaticMarkup(createElement(Version));
    const saved = quotaPilotApi.refresh;
    const before = Number(read().replace(/\D/g, ''));
    try {
      quotaPilotApi.refresh = async () => {
        throw new Error('offline');
      };
      await expect(refreshUsage()).rejects.toThrow('offline');
    } finally {
      quotaPilotApi.refresh = saved;
    }
    expect(Number(read().replace(/\D/g, ''))).toBe(before + 1);
  });
});
