import { describe, expect, it, vi } from 'vitest';

import type { SessionRuntimeIssueV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import {
    buildSessionUsageLimitRecoveryPresentation,
    buildSessionUsageLimitStatusBadgePresentation,
} from './sessionUsageLimitRecoveryPresentation';

function usageIssue(
    provider: string,
    resetAtMs: number | null,
    overrides: Partial<NonNullable<SessionRuntimeIssueV1['usageLimit']>> = {},
): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider,
        usageLimit: {
            v: 1,
            resetAtMs,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
            ...overrides,
        },
    };
}

function temporaryThrottleIssue(provider: string): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_temporary_throttle',
        source: 'provider_status_error',
        occurredAt: 1,
        provider,
        temporaryThrottle: {
            v: 1,
            retryAfterMs: 30_000,
            recoverability: 'retry',
        },
    };
}

describe('sessionUsageLimitRecoveryPresentation', () => {
    it('builds the same generic recovery actions for normalized usage-limit issues from different providers', () => {
        const translate = vi.fn((key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ));
        const resetAtMs = Date.UTC(2026, 4, 17, 15, 0, 0);

        for (const provider of ['codex', 'claude', 'opencode']) {
            const presentation = buildSessionUsageLimitRecoveryPresentation({
                featureEnabled: true,
                latestTurnStatus: 'failed',
                issue: usageIssue(provider, resetAtMs),
                recovery: null,
                rememberedMode: 'ask',
                checkNowSupported: true,
                translate,
                formatTime: (value) => `time:${value}`,
            });

            expect(presentation?.issueFingerprint).toBe(`usage-limit:${provider}:unknown-turn:1:${resetAtMs}`);
            expect(presentation?.banner.testID).toBe('session-usageLimit-recovery');
            expect(presentation?.banner.body).toContain('session.usageLimitRecovery.resetBody');
            expect(presentation?.banner.primaryAction.kind).toBe('enable');
            expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'remember']);
        }
    });

    it('omits manual check-now when the provider does not expose a safe quota probe', () => {
        const params = {
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('opencode', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key: string) => key,
            formatTime: (value: number) => String(value),
            checkNowSupported: false,
        } satisfies Parameters<typeof buildSessionUsageLimitRecoveryPresentation>[0] & {
            checkNowSupported: boolean;
        };

        const presentation = buildSessionUsageLimitRecoveryPresentation(params);

        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
    });

    it('uses a fallback-switch action for switchable exhausted connected-service groups', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    groupExhausted: true,
                },
            }),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_fallback_now');
        expect(presentation?.banner.primaryAction.label).toBe('session.usageLimitRecovery.switchFallbackNowAction');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
    });

    it('keeps fallback switching actionable after automatic group recovery is exhausted', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'exhausted',
            issueFingerprint: 'usage:group-exhausted',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 3,
            maxAttempts: 3,
            lastProbeError: 'all_group_members_exhausted',
            selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'codex-main', profileId: 'primary' },
        };
        const issue = usageIssue('codex', null, {
            recoverability: 'switch_account',
            connectedService: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                groupExhausted: true,
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.issueFingerprint).toBe('usage:group-exhausted');
        expect(presentation?.banner.primaryAction.kind).toBe('switch_fallback_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
        expect(badge?.label).toBe('session.usageLimitRecovery.statusExhausted');
    });

    it('uses a switch-account action for switchable connected-service profile limits', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'claude-subscription',
                    profileId: 'claude-primary',
                    groupId: null,
                },
            }),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_account_now');
        expect(presentation?.banner.primaryAction.label).toBe('session.usageLimitRecovery.switchAccountNowAction');
    });

    it('keeps switch-account recovery available when manual check-now is unsupported', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    groupExhausted: false,
                },
            }),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: false,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_account_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
    });

    it('uses a retry action for temporary provider throttles', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: temporaryThrottleIssue('codex'),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: temporaryThrottleIssue('codex'),
            recovery: null,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('retry_temporary_throttle');
        expect(presentation?.banner.primaryAction.label).toBe('session.usageLimitRecovery.retryTemporaryThrottleAction');
        expect(badge?.label).toBe('session.usageLimitRecovery.statusTemporaryThrottle');
    });

    it('shows cancel and checking state when a wait-resume intent is active', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'checking',
            issueFingerprint: 'usage:s1',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native' },
        };

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            rememberedMode: 'auto_wait',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.issueFingerprint).toBe('usage:s1');
        expect(presentation?.banner.primaryAction.kind).toBe('cancel');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'forget']);
        expect(badge).toEqual(expect.objectContaining({
            key: 'session-usage-limit-recovery',
            label: 'session.usageLimitRecovery.statusChecking',
            tone: 'warning',
        }));
    });

    it('presents a resume action after a manual check reports that the limit is ready', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'ready',
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'ready',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.title).toBe('session.usageLimitRecovery.readyTitle');
        expect(presentation?.banner.body).toBe('session.usageLimitRecovery.readyBody');
        expect(presentation?.banner.primaryAction.kind).toBe('resume_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
        expect(badge?.label).toBe('session.usageLimitRecovery.statusReady');
    });

    it('surfaces manual recovery check statuses when no durable recovery intent exists yet', () => {
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'waiting',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(badge?.label).toBe('session.usageLimitRecovery.statusWaiting');
    });

    it('surfaces waiting recovery state with a reset time', () => {
        const resetAtMs = 1_700_000_000_000;
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage:waiting-reset',
            armedAtMs: 1,
            resetAtMs,
            nextCheckAtMs: resetAtMs,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native' },
        };

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            rememberedMode: 'auto_wait',
            checkNowSupported: true,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => `time:${value}`,
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => `time:${value}`,
        });

        expect(presentation?.banner.body).toBe(`session.usageLimitRecovery.resetBody:time:${resetAtMs}`);
        expect(presentation?.banner.primaryAction.kind).toBe('cancel');
        expect(badge?.label).toBe(`session.usageLimitRecovery.statusWaitingUntil:time:${resetAtMs}`);
    });

    it('presents a resume action when the provider reset time has already elapsed', () => {
        const resetAtMs = 1_700_000_000_000;
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', resetAtMs),
            recovery: null,
            operationStatus: null,
            rememberedMode: 'auto_wait',
            checkNowSupported: false,
            nowMs: resetAtMs,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', resetAtMs),
            recovery: null,
            operationStatus: null,
            nowMs: resetAtMs,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.title).toBe('session.usageLimitRecovery.readyTitle');
        expect(presentation?.banner.body).toBe('session.usageLimitRecovery.readyBody');
        expect(presentation?.banner.primaryAction.kind).toBe('resume_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['forget']);
        expect(badge?.label).toBe('session.usageLimitRecovery.statusReady');
    });

    it('does not render when the feature is disabled or the runtime issue is not a usage limit', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: false,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: { ...usageIssue('codex', null), source: 'stream_error' },
            recovery: null,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('does not render a stale usage-limit issue after a later turn completed', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'completed',
            issue: usageIssue('codex', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('keeps an inactive stale in-progress usage-limit issue visible when the runtime is not actively working', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue: usageIssue('codex', null),
            recovery: null,
            runtimeWorking: false,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue: usageIssue('codex', null),
            recovery: null,
            runtimeWorking: false,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.testID).toBe('session-usageLimit-recovery');
        expect(badge?.key).toBe('session-usage-limit-recovery');
    });

    it('keeps a usage-limit issue visible after abort cleanup marks the turn cancelled', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'cancelled',
            issue: usageIssue('codex', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'cancelled',
            issue: usageIssue('codex', null),
            recovery: null,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('enable');
        expect(badge?.key).toBe('session-usage-limit-recovery');
    });

    it('keeps a usage-limit issue visible when cancelled cleanup is the only later activity', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'cancelled',
            issue: usageIssue('codex', null),
            recovery: null,
            hasActivityAfterRuntimeIssue: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.issueFingerprint).toBe('usage-limit:codex:unknown-turn:1:no-reset');
    });

    it('does not render a stale usage-limit issue while the provider is actively working again', () => {
        const issue = usageIssue('claude', null);

        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            runtimeWorking: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            runtimeWorking: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('does not render a stale usage-limit issue after later meaningful session activity', () => {
        const issue = usageIssue('claude', null);

        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            hasActivityAfterRuntimeIssue: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            hasActivityAfterRuntimeIssue: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });
});
