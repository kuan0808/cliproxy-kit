import { describe, expect, test } from 'bun:test';
import {
  buildLedger,
  maskEmail,
  snapshotAgeParts,
  reasonKey,
  maskFileName,
} from '@/features/quota/ledgerModel';
import { normalizeQuotaPilotSnapshot } from '@/services/api/quotaPilot';
import { NOW_MS, rawSnapshot } from './fixtures/quotaPilotSnapshot';

const snapshot = normalizeQuotaPilotSnapshot(rawSnapshot)!;

describe('ledger', () => {
  const ledger = buildLedger(snapshot, 'all', '', NOW_MS);
  const [claude, codex] = ledger.groups;

  test('orders providers like the page tabs and keeps routing order inside each', () => {
    expect(ledger.groups.map((group) => group.provider)).toEqual(['claude', 'codex']);
    expect(claude.rows.map((row) => [row.order, row.label])).toEqual([
      [1, 'a•••'],
      [2, 'b•••'],
    ]);
  });

  test('marks serving accounts and only the first ready account as next', () => {
    expect(claude.rows.map((row) => [row.serving, row.sessions, row.next])).toEqual([
      [true, 2, false],
      [false, 0, true],
    ]);
    expect(codex.rows[0].next).toBe(true);
  });

  test('sums weekly use as shown and finds the soonest weekly reset', () => {
    expect(claude.pool).toEqual({ used: 137, capacity: 200, known: 2, unread: [] });
    expect(claude.fiveHour).toEqual({ used: 32, capacity: 200, known: 2, unread: [] });
    expect(codex.pool).toEqual({ used: 7, capacity: 100, known: 1, unread: [] });
    expect(codex.fiveHour).toBeNull();
    expect(claude.nextReset?.row.label).toBe('a•••');
    expect(claude.nextReset?.atMs).toBe(Date.parse('2026-10-04T11:59:59Z'));
  });

  test('a pool holds every account with the window, and names those not read yet', () => {
    const window = (kind: string, remaining: number) => ({ kind, remaining, reset_at: '2026-10-10T00:00:00Z' });
    const pools = normalizeQuotaPilotSnapshot({
      providers: {
        codex: {
          credentials: [
            { id: 'codex-a.json', label: 'a•••', windows: [window('5h', 0.8), window('7d', 0.7)] },
            { id: 'codex-b.json', label: 'b•••', windows: [] },
            { id: 'codex-c.json', label: 'c•••', windows: [window('7d', 0.9)], absent: ['5h'] },
          ],
        },
      },
    })!;
    const [group] = buildLedger(pools, 'all', '', NOW_MS).groups;
    // b's week is not known: not taken as unused, and named.
    expect(group.pool).toMatchObject({ used: 40, capacity: 300, known: 2 });
    expect(group.pool?.unread.map((row) => row.label)).toEqual(['b•••']);
    // c has no 5-hour window at all, so it is not in that pool; b may have one.
    expect(group.fiveHour).toMatchObject({ used: 20, capacity: 200, known: 1 });
    expect(group.fiveHour?.unread.map((row) => row.label)).toEqual(['b•••']);
    expect(group.rows[2].absent).toEqual(['5h']);
    // A second credential of a's account adds no quota of its own.
    const twins = normalizeQuotaPilotSnapshot({
      providers: {
        codex: {
          credentials: [
            { id: 'codex-a.json', label: 'a•••', windows: [window('7d', 0.7)] },
            { id: 'codex-a-pro.json', label: 'a•••2', windows: [window('7d', 0.7)], same_as: 'codex-a.json' },
          ],
        },
      },
    })!;
    const [one] = buildLedger(twins, 'all', '', NOW_MS).groups;
    expect(one.pool).toMatchObject({ used: 30, capacity: 100, known: 1 });
    expect(one.rows[1].sameAs).toBe('codex-a.json');
    // A search that shows only the second credential still counts the account, and names its twin.
    const [found] = buildLedger(twins, 'all', 'a-pro', NOW_MS).groups;
    expect(found.rows.map((row) => row.key)).toEqual(['codex-a-pro.json']);
    expect(found.pool).toMatchObject({ used: 30, capacity: 100, known: 1 });
    expect(found.rows[0].twin?.fileName).toBe('codex-a.json');
  });

  test('lines window kinds up as 5-hour, weekly, then model windows', () => {
    expect(ledger.kinds).toEqual(['5h', '7d', '7d_fable']);
    const fable = claude.rows[0].windows.find((window) => window.kind === '7d_fable');
    expect(fable).toMatchObject({ remaining: 100, stale: true });
    const fiveHour = claude.rows[0].windows.find((window) => window.kind === '5h');
    expect(fiveHour?.resetAtMs).toBeNull();
  });

  test('ignores a weekly reset that already passed', () => {
    const later = buildLedger(snapshot, 'all', '', Date.parse('2026-10-05T00:00:00Z'));
    expect(later.groups[0].nextReset?.row.label).toBe('b•••');
  });

  test('follows the provider tab and the card search fields', () => {
    expect(buildLedger(snapshot, 'codex', '', NOW_MS).groups.map((g) => g.provider)).toEqual([
      'codex',
    ]);
    expect(buildLedger(snapshot, 'antigravity', '', NOW_MS).groups).toEqual([]);

    const byEmail = buildLedger(snapshot, 'all', 'BOB@', NOW_MS);
    expect(byEmail.groups.map((group) => group.rows.map((row) => row.label))).toEqual([['b•••']]);
    expect(byEmail.groups[0].rows[0].next).toBe(true);

    // "Next" is decided on the full routing order, not on the filtered rows.
    const byFile = buildLedger(snapshot, 'all', 'claude-alice', NOW_MS);
    expect(byFile.groups[0].rows.map((row) => [row.label, row.next])).toEqual([['a•••', false]]);
  });
});

describe('ledger helpers', () => {
  test('masks emails the way the plugin does', () => {
    expect(maskEmail('dana@example.com')).toBe('d•••');
    expect(maskFileName('claude-0f-dana@example.com.json', 'dana@example.com')).toBe('claude-0f-d•••@e•••.com.json');
    expect(maskFileName('claude-alice.json', '')).toBe('claude-alice.json');
    expect(maskEmail('')).toBe('•••');
  });

  test('reports snapshot age in seconds, then minutes, never negative', () => {
    expect(snapshotAgeParts(NOW_MS - 12_400, NOW_MS)).toEqual({ value: 12, unit: 'second' });
    expect(snapshotAgeParts(NOW_MS - 125_000, NOW_MS)).toEqual({ value: 2, unit: 'minute' });
    expect(snapshotAgeParts(NOW_MS + 3_000, NOW_MS)).toEqual({ value: 0, unit: 'second' });
    expect(snapshotAgeParts(null, NOW_MS)).toBeNull();
  });
});

describe('routing reasons', () => {
  test('known reasons become translation keys; others pass through', () => {
    expect(reasonKey('weekly quota resets soonest')).toEqual({ key: 'reason_resets_soonest' });
    expect(reasonKey('Weekly Opus quota used up')).toEqual({ key: 'reason_bucket_used', family: 'Opus' });
    expect(reasonKey('5-hour quota low')).toEqual({ key: 'reason_five_low' });
    expect(reasonKey('Weekly Fable quota resets soonest')).toEqual({
      key: 'reason_bucket_resets_soonest',
      family: 'Fable',
    });
    expect(reasonKey('something new')).toBeNull();
  });
});
