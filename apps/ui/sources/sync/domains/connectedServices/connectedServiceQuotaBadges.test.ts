import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { computeConnectedServiceQuotaSummaryBadges } from './connectedServiceQuotaBadges';

describe('computeConnectedServiceQuotaSummaryBadges', () => {
  it('selects the most constrained available quota meter by default when no meters are pinned', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'daily', label: 'Daily', used: 20, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'quota' } },
        { meterId: 'weekly', label: 'Weekly', used: 92, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'quota' } },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: [],
      strategy: 'min_remaining',
    });

    expect(badges).toEqual([{ meterId: 'weekly', text: '8%' }]);
  });

  it('keeps pinned multi-meter badges labeled in pinned order', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'session', label: 'Session', used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {} },
        { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: 25, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['weekly', 'session'],
    });

    expect(badges.map((b) => b.meterId)).toEqual(['weekly', 'session']);
    expect(badges[0]?.text).toBe('Weekly 75%');
    expect(badges[1]?.text).toBe('Session 90%');
  });

  it('keeps a placeholder badge when a pinned meter is missing', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['weekly'],
    });

    expect(badges).toEqual([{ meterId: 'weekly', text: '—' }]);
  });

  it('derives remaining percent from used/limit when utilizationPct is missing', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'extra', label: 'Extra', used: 20, limit: 100, unit: 'credits', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['extra'],
    });

    expect(badges[0]?.text).toBe('80%');
  });

  it('omits compact daily and weekly prefixes for automatic summary badges', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'daily', label: 'Daily', used: 9, limit: 10, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['daily'],
    });

    expect(badges[0]?.text).toBe('10%');
  });

  it('can order badges by least remaining when strategy=min_remaining', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'session', label: 'Session', used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {} },
        { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: 80, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['session', 'weekly'],
      strategy: 'min_remaining',
    });

    expect(badges.map((b) => b.meterId)).toEqual(['weekly', 'session']);
    expect(badges[0]?.text).toBe('Weekly 20%');
  });

  it('ignores unreliable and non-quota states when ordering by most constrained remaining quota', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'unknown', label: 'Unknown', used: null, limit: null, unit: 'unknown', utilizationPct: 99, resetsAt: null, status: 'ok', confidence: 'unknown', details: {} },
        { meterId: 'capacity', label: 'Capacity', used: null, limit: null, unit: 'unknown', utilizationPct: 98, resetsAt: null, status: 'ok', details: { limitCategory: 'capacity' } },
        { meterId: 'auth', label: 'Auth', used: null, limit: null, unit: 'unknown', utilizationPct: 97, resetsAt: null, status: 'ok', details: { limitCategory: 'auth' } },
        { meterId: 'plan', label: 'Plan', used: null, limit: null, unit: 'unknown', utilizationPct: 96, resetsAt: null, status: 'ok', details: { limitCategory: 'plan' } },
        { meterId: 'validation', label: 'Validation', used: null, limit: null, unit: 'unknown', utilizationPct: 95, resetsAt: null, status: 'ok', details: { limitCategory: 'validation' } },
        { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: 80, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'quota' } },
        { meterId: 'daily', label: 'Daily', used: null, limit: null, unit: 'unknown', utilizationPct: 70, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'quota' } },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['unknown', 'capacity', 'auth', 'plan', 'validation', 'daily', 'weekly'],
      strategy: 'min_remaining',
    });

    expect(badges.map((b) => b.meterId).slice(0, 2)).toEqual(['weekly', 'daily']);
  });

  it('does not rank capacity or rate-limit meters ahead of comparable quota window badges', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'quota' } },
        { meterId: 'daily', label: 'Daily', used: 50, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'quota' } },
        { meterId: 'requests', label: 'Requests', used: 99, limit: 100, unit: 'requests', utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'rate_limit' } },
        { meterId: 'server_capacity', label: 'Server capacity', used: 100, limit: 100, unit: 'requests', utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'capacity' } },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['requests', 'server_capacity', 'daily', 'weekly'],
      strategy: 'min_remaining',
    });

    expect(badges.map((b) => b.meterId).slice(0, 2)).toEqual(['weekly', 'daily']);
  });
});
