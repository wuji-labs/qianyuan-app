import { describe, expect, it } from 'vitest';

import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './mapCodexRateLimitSnapshot';

describe('mapCodexRateLimitSnapshotToQuotaSnapshot', () => {
  it('maps Codex app-server rate-limit snapshots into connected-service quota meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        plan_type: 'plus',
        account: { email: 'alice@example.com' },
        primary: {
          used_percent: 87.5,
          resets_at: '2026-05-17T16:00:00.000Z',
        },
        secondary: {
          used_percent: 42,
          resets_at: 1_768_010_000_000,
        },
      },
    });

    expect(snapshot).toMatchObject({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      planLabel: 'plus',
      accountLabel: 'alice@example.com',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          utilizationPct: 87.5,
          resetsAt: Date.parse('2026-05-17T16:00:00.000Z'),
        },
        {
          meterId: 'secondary',
          label: 'Secondary',
          utilizationPct: 42,
          resetsAt: 1_768_010_000_000,
        },
      ],
    });
  });

  it('uses live app-server account identity embedded in the rate-limit snapshot', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        account: {
          id: 'acct_live_codex',
          email: 'live@example.test',
        },
        primary: { used_percent: 12 },
      },
    });

    expect(snapshot).toMatchObject({
      activeAccountId: 'acct_live_codex',
      accountLabel: 'live@example.test',
    });
  });

  it('unwraps official app-server rateLimits response and notification envelopes', () => {
    for (const rawSnapshot of [
      {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 100, resetsAt: 1_768_010_000 },
        },
        rateLimitsByLimitId: null,
      },
      {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 100, resetsAt: 1_768_010_000 },
        },
      },
    ]) {
      const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_768_000_000_000,
        rawSnapshot,
      });

      expect(snapshot).toMatchObject({
        planLabel: 'pro',
        meters: [{
          meterId: 'primary',
          utilizationPct: 100,
          resetsAt: 1_768_010_000_000,
        }],
      });
    }
  });

  it('converts relative resets_in_seconds to absolute reset timestamps at mapping time (RD-QUO-1)', () => {
    const fetchedAt = 1_768_000_000_000;
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      rawSnapshot: {
        plan_type: 'pro',
        primary: {
          used_percent: 100,
          window_minutes: 300,
          resets_in_seconds: 1_800,
        },
        secondary: {
          used_percent: 40,
          resetsInSeconds: 86_400,
        },
      },
    });

    expect(snapshot.meters).toMatchObject([
      {
        meterId: 'primary',
        utilizationPct: 100,
        resetAtMs: fetchedAt + 1_800_000,
        resetsAt: fetchedAt + 1_800_000,
      },
      {
        meterId: 'secondary',
        utilizationPct: 40,
        resetAtMs: fetchedAt + 86_400_000,
        resetsAt: fetchedAt + 86_400_000,
      },
    ]);
  });

  it('prefers absolute reset fields over relative resets_in_seconds when both are present', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        primary: {
          used_percent: 50,
          resets_at: '2026-05-17T16:00:00.000Z',
          resets_in_seconds: 60,
        },
      },
    });

    expect(snapshot.meters[0]).toMatchObject({
      resetsAt: Date.parse('2026-05-17T16:00:00.000Z'),
    });
  });

  it('maps app-server primary and secondary window snapshots as separate meters', () => {
    const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1_768_000_000_000,
      rawSnapshot: {
        rate_limits: {
          plan_type: 'team',
          primary_window: {
            used_percent: 99,
            resets_at: '2026-05-17T18:00:00.000Z',
          },
          secondary_window: {
            used_percent: 15,
            resets_at: '2026-05-18T18:00:00.000Z',
          },
        },
      },
    });

    expect(snapshot).toMatchObject({
      planLabel: 'team',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          remainingPct: 1,
          resetAtMs: Date.parse('2026-05-17T18:00:00.000Z'),
          providerLimitId: 'primary',
          scope: 'primary',
          utilizationPct: 99,
          resetsAt: Date.parse('2026-05-17T18:00:00.000Z'),
        },
        {
          meterId: 'secondary',
          label: 'Secondary',
          remainingPct: 85,
          resetAtMs: Date.parse('2026-05-18T18:00:00.000Z'),
          providerLimitId: 'secondary',
          scope: 'secondary',
          utilizationPct: 15,
          resetsAt: Date.parse('2026-05-18T18:00:00.000Z'),
        },
      ],
    });
  });
});
