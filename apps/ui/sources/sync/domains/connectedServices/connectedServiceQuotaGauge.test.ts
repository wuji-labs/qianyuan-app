import { describe, expect, it } from 'vitest';
import type { ConnectedServiceQuotaMeterV1, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import {
    type ConnectedServiceQuotaGaugeLabelFormatter,
    computeConnectedServiceQuotaGaugeViewModel,
    deriveConnectedServiceQuotaSnapshotFromRuntimeIssue,
    resolveConnectedServiceQuotaGaugeSource,
    selectConnectedServiceSessionProviderUsageSnapshot,
} from './connectedServiceQuotaGauge';

function meter(
    patch: Partial<ConnectedServiceQuotaMeterV1> & Pick<ConnectedServiceQuotaMeterV1, 'meterId' | 'label'>,
): ConnectedServiceQuotaMeterV1 {
    return {
        used: null,
        limit: null,
        unit: 'count',
        utilizationPct: null,
        resetsAt: null,
        status: 'ok',
        details: {},
        ...patch,
    };
}

function snapshot(meters: readonly ConnectedServiceQuotaMeterV1[]): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [...meters],
    };
}

const formatter: ConnectedServiceQuotaGaugeLabelFormatter = {
    remaining: ({ percent }) => `${percent} left`,
    remainingWithReset: ({ percent, reset }) => `${percent} left · resets in ${reset}`,
    used: ({ used, limit }) => `${used}/${limit} used`,
    durationNow: () => 'now',
    durationDaysHours: ({ days, hours }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }) => `${hours}h ${minutes}m`,
    durationHours: ({ hours }) => `${hours}h`,
    durationMinutes: ({ minutes }) => `${minutes}m`,
};

describe('computeConnectedServiceQuotaGaugeViewModel', () => {
    it('selects the reliable meter with the least remaining quota for most_constrained mode', () => {
        const capacityDetails: ConnectedServiceQuotaMeterV1['details'] & { limitCategory: 'capacity' } = {
            limitCategory: 'capacity',
        };

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'daily', label: 'Daily', used: 70, limit: 100 }),
                meter({ meterId: 'weekly', label: 'Weekly', used: 88, limit: 100 }),
                meter({ meterId: 'capacity', label: 'Capacity', used: 99, limit: 100, details: capacityDetails }),
                meter({ meterId: 'auth', label: 'Auth', used: 99, limit: 100, status: 'unavailable' }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.remainingPct).toBe(12);
        expect(viewModel?.badgeLabel).toBe('12% left');
        expect(viewModel?.tone).toBe('warning');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['daily', 'weekly']);
    });

    it('does not compare quota windows against rate or capacity families in most-constrained mode', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', details: { limitCategory: 'quota' } }),
                meter({ meterId: 'daily', label: 'Daily', used: 50, limit: 100, unit: 'count', details: { limitCategory: 'quota' } }),
                meter({ meterId: 'requests', label: 'Requests', used: 99, limit: 100, unit: 'requests', details: { limitCategory: 'rate_limit' } }),
                meter({ meterId: 'server_capacity', label: 'Server capacity', used: 100, limit: 100, unit: 'requests', details: { limitCategory: 'capacity' } }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['weekly', 'daily']);
    });

    it('keeps daily and weekly windows separate when explicitly selected', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'daily', label: 'Daily', used: 85, limit: 100 }),
            meter({ meterId: 'weekly', label: 'Weekly', used: 5, limit: 100 }),
        ]);

        const daily = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'daily',
            nowMs: 2_000,
            formatter,
        });
        const weekly = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
            providerDisplayName: 'OpenAI',
            activeAccountDisplayLabel: 'Work account',
        });

        expect(daily?.effectiveMeter.meterId).toBe('daily');
        expect(daily?.badgeLabel).toBe('d. 15% left');
        expect(weekly?.effectiveMeter.meterId).toBe('weekly');
        expect(weekly?.badgeLabel).toBe('w. 95% left');
    });

    it('uses compact selected-window prefixes for daily and weekly meters', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'daily', label: 'Daily window', used: 85, limit: 100 }),
                meter({ meterId: 'weekly', label: 'Weekly window', used: 20, limit: 100 }),
            ]),
            windowMode: 'daily',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('daily');
        expect(viewModel?.scopePrefix).toBe('d.');
        expect(viewModel?.badgeLabel).toBe('d. 15% left');
    });

    it('formats remaining-first detail rows with reset and usage labels', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    resetsAt: 2_000 + 2 * 60 * 60 * 1000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
            providerDisplayName: 'OpenAI',
            activeAccountDisplayLabel: 'Work account',
        });

        expect(viewModel?.serviceId).toBe('openai-codex');
        expect(viewModel?.providerDisplayName).toBe('OpenAI');
        expect(viewModel?.activeAccountDisplayLabel).toBe('Work account');
        expect(viewModel?.primaryValueSemantics).toBe('remaining');
        expect(viewModel?.badgeLabel).toBe('w. 18% left');
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.usedLimitLabel).toBe('82/100 used');
        expect(viewModel?.allMeterRows[0]?.detailRightSemantics).toBe('remaining');
        expect(viewModel?.allMeterRows[0]?.usedLimitSemantics).toBe('used');
        expect(viewModel?.allMeterRows[0]?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.allMeterRows[0]?.usedLimitLabel).toBe('82/100 used');
    });

    it('uses first-class remaining and used percentages from provider quota meters', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    usedPct: 82,
                    remainingPct: 18,
                    resetAtMs: 2_000 + 2 * 60 * 60 * 1000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.remainingPct).toBe(18);
        expect(viewModel?.usedPct).toBe(82);
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.allMeterRows[0]?.remainingPct).toBe(18);
        expect(viewModel?.allMeterRows[0]?.usedPct).toBe(82);
    });

    it('returns null when no reliable quota meter exists', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'capacity', label: 'Capacity', used: 99, limit: 100, status: 'unavailable' }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel).toBeNull();
    });

    it('hides unsupported native and non-app-server sessions without reliable evidence', () => {
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'codex',
            sourceKind: 'unsupported',
            reason: 'codex_non_app_server',
            snapshot: null,
        })).toBeNull();

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'native_auth',
            snapshot: null,
        })).toBeNull();
    });

    it('accepts connected groups, single profiles, and Codex native app-server snapshots', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
        ]);

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'codex',
            sourceKind: 'connected_service_group',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'connected_service_profile',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'codex',
            sourceKind: 'codex_app_server_native',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
    });

    it('allows Claude native only after runtime quota evidence exists', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'five_hour', label: '5 hour', used: 60, limit: 100 }),
        ]);

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'native_runtime_evidence',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
    });

    it('marks Gemini check-now support only for connected-service sources', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'daily', label: 'Daily', used: 40, limit: 100 }),
        ]);

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'gemini',
            sourceKind: 'connected_service_profile',
            snapshot: quotaSnapshot,
        })?.checkNowSupported).toBe(true);
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'gemini',
            sourceKind: 'native_runtime_evidence',
            snapshot: quotaSnapshot,
        })?.checkNowSupported).toBe(false);
    });

    it('derives a reliable provider usage projection from runtime quota windows', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'quota',
                quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'work', groupId: 'codex-main', fetchedAtMs: 2_000 },
                effectiveMeterId: 'weekly',
                effectiveRemainingPct: 7,
                allWindows: [
                    { meterId: 'daily', scope: 'daily', remainingPct: 42, resetAtMs: 3_000, status: 'ok' },
                    { meterId: 'weekly', scope: 'weekly', remainingPct: 7, resetAtMs: 4_000, status: 'ok' },
                ],
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('openai-codex');
        expect(quotaSnapshot?.profileId).toBe('work');
        expect(quotaSnapshot?.meters.map((quotaMeter) => quotaMeter.meterId)).toEqual(['daily', 'weekly']);

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });
        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.badgeLabel).toBe('7% left');
    });

    it('prefers session runtime quota evidence over launch-time connected profile polling', () => {
        const launchTimeProfileSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 10, limit: 100 }),
        ]);
        const selected = selectConnectedServiceSessionProviderUsageSnapshot({
            connectedServiceSnapshot: launchTimeProfileSnapshot,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 2_000,
                provider: 'codex',
                usageLimit: {
                    v: 1,
                    resetAtMs: 3_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'wait',
                    limitCategory: 'quota',
                    quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'backup', groupId: 'main', fetchedAtMs: 2_000 },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 18,
                },
            },
        });

        expect(selected?.profileId).toBe('backup');
        expect(selected?.meters[0]?.remainingPct).toBe(18);
    });

    it('does not derive a provider usage projection for auth, plan, capacity, or validation runtime issues', () => {
        for (const limitCategory of ['auth', 'plan', 'capacity', 'validation'] as const) {
            expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                usageLimit: {
                    v: 1,
                    resetAtMs: null,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'manual',
                    limitCategory,
                    quotaSnapshotRef: { serviceId: 'openai-codex' },
                    allWindows: [
                        { meterId: 'weekly', scope: 'weekly', remainingPct: 7, resetAtMs: 4_000, status: 'ok' },
                    ],
                },
            })).toBeNull();
        }
    });
});
