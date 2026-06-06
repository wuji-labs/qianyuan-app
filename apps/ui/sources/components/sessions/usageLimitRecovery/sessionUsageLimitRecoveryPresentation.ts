import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
    SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import type { AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';

export type UsageLimitRecoveryRememberedMode = 'ask' | 'auto_wait';
export type UsageLimitRecoveryOperationStatus = 'checking' | 'ready' | 'waiting' | 'resumed' | 'exhausted' | 'inactive';

export type SessionUsageLimitRecoveryActionKind =
    | 'enable'
    | 'cancel'
    | 'check_now'
    | 'resume_now'
    | 'switch_fallback_now'
    | 'switch_account_now'
    | 'retry_temporary_throttle'
    | 'remember'
    | 'forget';

export type SessionUsageLimitRecoveryActionPresentation = Readonly<{
    kind: SessionUsageLimitRecoveryActionKind;
    label: string;
    accessibilityLabel: string;
    testID: string;
}>;

export type SessionUsageLimitRecoveryBannerPresentation = Readonly<{
    testID: string;
    title: string;
    body: string;
    primaryAction: SessionUsageLimitRecoveryActionPresentation;
    secondaryActions: ReadonlyArray<SessionUsageLimitRecoveryActionPresentation>;
}>;

export type SessionUsageLimitRecoveryPresentation = Readonly<{
    issueFingerprint: string;
    banner: SessionUsageLimitRecoveryBannerPresentation;
}>;

export type SessionUsageLimitStatusBadgePresentation = Readonly<{
    key: string;
    label: string;
    testID: string;
    accessibilityLabel: string;
    tone: AgentInputStatusBadgeTone;
}>;

export type SessionUsageLimitRecoveryTranslationKey =
    | 'session.usageLimitRecovery.title'
    | 'session.usageLimitRecovery.readyTitle'
    | 'session.usageLimitRecovery.resetBody'
    | 'session.usageLimitRecovery.genericBody'
    | 'session.usageLimitRecovery.readyBody'
    | 'session.usageLimitRecovery.enableAction'
    | 'session.usageLimitRecovery.cancelAction'
    | 'session.usageLimitRecovery.checkNowAction'
    | 'session.usageLimitRecovery.resumeNowAction'
    | 'session.usageLimitRecovery.switchFallbackNowAction'
    | 'session.usageLimitRecovery.switchAccountNowAction'
    | 'session.usageLimitRecovery.retryTemporaryThrottleAction'
    | 'session.usageLimitRecovery.rememberAction'
    | 'session.usageLimitRecovery.forgetAction'
    | 'session.usageLimitRecovery.statusLimitReached'
    | 'session.usageLimitRecovery.statusTemporaryThrottle'
    | 'session.usageLimitRecovery.statusReady'
    | 'session.usageLimitRecovery.statusWaiting'
    | 'session.usageLimitRecovery.statusWaitingUntil'
    | 'session.usageLimitRecovery.statusChecking'
    | 'session.usageLimitRecovery.statusPaused'
    | 'session.usageLimitRecovery.statusExhausted';

type SessionUsageLimitRecoveryTimeTranslationKey =
    | 'session.usageLimitRecovery.resetBody'
    | 'session.usageLimitRecovery.statusWaitingUntil';

type SessionUsageLimitRecoveryStaticTranslationKey = Exclude<
    SessionUsageLimitRecoveryTranslationKey,
    SessionUsageLimitRecoveryTimeTranslationKey
>;

export type SessionUsageLimitRecoveryTranslate = (
    key: SessionUsageLimitRecoveryTranslationKey,
    params?: Readonly<{ time: string }>,
) => string;

type PresentationParams = Readonly<{
    featureEnabled: boolean;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    issue: SessionRuntimeIssueV1 | null | undefined;
    recovery: SessionUsageLimitRecoveryV1 | null | undefined;
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
    rememberedMode: UsageLimitRecoveryRememberedMode;
    checkNowSupported?: boolean;
    nowMs?: number | null;
    translate: SessionUsageLimitRecoveryTranslate;
    formatTime: (timeMs: number) => string;
}>;

function isUsageLimitIssue(issue: SessionRuntimeIssueV1 | null | undefined): issue is SessionRuntimeIssueV1 {
    return issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && issue.source === 'usage_limit';
}

function isTemporaryThrottleIssue(issue: SessionRuntimeIssueV1 | null | undefined): issue is SessionRuntimeIssueV1 {
    return issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && issue.temporaryThrottle?.v === 1
        && issue.temporaryThrottle.recoverability === 'retry';
}

function shouldSurfaceRecoveryIssue(params: Readonly<{
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    issue: SessionRuntimeIssueV1 | null | undefined;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
}>): params is Readonly<{
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    issue: SessionRuntimeIssueV1;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
}> {
    const hasRecoveryIssue = isUsageLimitIssue(params.issue) || isTemporaryThrottleIssue(params.issue);
    if (!hasRecoveryIssue) return false;
    if (params.runtimeWorking === true) return false;
    if (params.hasActivityAfterRuntimeIssue === true && params.latestTurnStatus !== 'cancelled') return false;
    if (
        params.latestTurnStatus != null
        && params.latestTurnStatus !== 'failed'
        && params.latestTurnStatus !== 'cancelled'
        && params.latestTurnStatus !== 'in_progress'
    ) return false;
    return true;
}

function readResetAtMs(
    issue: SessionRuntimeIssueV1,
    recovery: SessionUsageLimitRecoveryV1 | null | undefined,
): number | null {
    if (typeof recovery?.resetAtMs === 'number') return recovery.resetAtMs;
    const resetAtMs = issue.usageLimit?.resetAtMs;
    return typeof resetAtMs === 'number' ? resetAtMs : null;
}

function buildIssueFingerprint(issue: SessionRuntimeIssueV1): string {
    return [
        'usage-limit',
        issue.provider ?? 'provider',
        issue.providerTurnId ?? 'unknown-turn',
        String(issue.occurredAt),
        issue.usageLimit?.resetAtMs === null || issue.usageLimit?.resetAtMs === undefined
            ? 'no-reset'
            : String(issue.usageLimit.resetAtMs),
    ].join(':');
}

function buildAction(
    kind: SessionUsageLimitRecoveryActionKind,
    labelKey: SessionUsageLimitRecoveryStaticTranslationKey,
    testID: string,
    translate: SessionUsageLimitRecoveryTranslate,
): SessionUsageLimitRecoveryActionPresentation {
    const label = translate(labelKey);
    return {
        kind,
        label,
        accessibilityLabel: label,
        testID,
    };
}

function isActiveRecovery(recovery: SessionUsageLimitRecoveryV1 | null | undefined): boolean {
    return recovery?.status === 'armed'
        || recovery?.status === 'waiting'
        || recovery?.status === 'checking'
        || recovery?.status === 'paused';
}

function isResetElapsed(resetAtMs: number | null, nowMs: number | null | undefined): boolean {
    return resetAtMs !== null
        && typeof nowMs === 'number'
        && Number.isFinite(nowMs)
        && nowMs >= resetAtMs;
}

function isReadyForResume(params: Readonly<{
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    resetAtMs: number | null;
    nowMs?: number | null;
}>): boolean {
    return params.operationStatus === 'ready'
        || params.operationStatus === 'resumed'
        || isResetElapsed(params.resetAtMs, params.nowMs);
}

function resolveVisibleRecoveryStatus(params: Readonly<{
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    recoveryStatus?: SessionUsageLimitRecoveryV1['status'] | null;
}>): SessionUsageLimitRecoveryV1['status'] | null {
    switch (params.operationStatus) {
        case 'checking':
            return 'checking';
        case 'waiting':
            return 'waiting';
        case 'exhausted':
            return 'exhausted';
        case 'inactive':
            return 'paused';
        case 'ready':
        case 'resumed':
        case null:
        case undefined:
            return params.recoveryStatus ?? null;
    }
}

function resolvePrimaryRecoveryAction(params: Readonly<{
    issue: SessionRuntimeIssueV1;
    ready: boolean;
    activeRecovery: boolean;
    checkNowSupported: boolean;
    translate: SessionUsageLimitRecoveryTranslate;
}>): SessionUsageLimitRecoveryActionPresentation {
    if (params.ready) {
        return buildAction('resume_now', 'session.usageLimitRecovery.resumeNowAction', 'session-usageLimit-recovery-resumeNow', params.translate);
    }
    if (params.activeRecovery) {
        return buildAction('cancel', 'session.usageLimitRecovery.cancelAction', 'session-usageLimit-recovery-cancel', params.translate);
    }
    if (isTemporaryThrottleIssue(params.issue) && params.checkNowSupported) {
        return buildAction(
            'retry_temporary_throttle',
            'session.usageLimitRecovery.retryTemporaryThrottleAction',
            'session-usageLimit-recovery-retryTemporaryThrottle',
            params.translate,
        );
    }
    if (params.issue.usageLimit?.recoverability === 'switch_account') {
        const connectedService = params.issue.usageLimit.connectedService;
        const groupId = typeof connectedService?.groupId === 'string' && connectedService.groupId.trim()
            ? connectedService.groupId
            : null;
        return groupId && connectedService?.groupExhausted === true
            ? buildAction(
                'switch_fallback_now',
                'session.usageLimitRecovery.switchFallbackNowAction',
                'session-usageLimit-recovery-switchFallbackNow',
                params.translate,
            )
            : buildAction(
                'switch_account_now',
                'session.usageLimitRecovery.switchAccountNowAction',
                'session-usageLimit-recovery-switchAccountNow',
                params.translate,
            );
    }
    return buildAction('enable', 'session.usageLimitRecovery.enableAction', 'session-usageLimit-recovery-enable', params.translate);
}

function shouldOfferCheckNowSecondary(params: Readonly<{
    ready: boolean;
    checkNowSupported: boolean;
    primaryAction: SessionUsageLimitRecoveryActionPresentation;
}>): boolean {
    return !params.ready
        && params.checkNowSupported
        && params.primaryAction.kind !== 'switch_fallback_now'
        && params.primaryAction.kind !== 'switch_account_now'
        && params.primaryAction.kind !== 'retry_temporary_throttle';
}

export function buildSessionUsageLimitRecoveryPresentation(
    params: PresentationParams,
): SessionUsageLimitRecoveryPresentation | null {
    if (!params.featureEnabled || !shouldSurfaceRecoveryIssue(params)) return null;

    const resetAtMs = readResetAtMs(params.issue, params.recovery);
    const ready = isReadyForResume({
        operationStatus: params.operationStatus,
        resetAtMs,
        nowMs: params.nowMs,
    });
    const activeRecovery = isActiveRecovery(params.recovery);
    const checkNowSupported = params.checkNowSupported === true;
    const primaryAction = resolvePrimaryRecoveryAction({
        issue: params.issue,
        ready,
        activeRecovery,
        checkNowSupported,
        translate: params.translate,
    });
    const body = ready
        ? params.translate('session.usageLimitRecovery.readyBody')
        : resetAtMs !== null
        ? params.translate('session.usageLimitRecovery.resetBody', {
            time: params.formatTime(resetAtMs),
        })
        : params.translate('session.usageLimitRecovery.genericBody');

    return {
        issueFingerprint: params.recovery?.issueFingerprint ?? buildIssueFingerprint(params.issue),
        banner: {
            testID: 'session-usageLimit-recovery',
            title: ready
                ? params.translate('session.usageLimitRecovery.readyTitle')
                : params.translate('session.usageLimitRecovery.title'),
            body,
            primaryAction,
            secondaryActions: [
                ...(shouldOfferCheckNowSecondary({ ready, checkNowSupported, primaryAction }) ? [
                    buildAction('check_now', 'session.usageLimitRecovery.checkNowAction', 'session-usageLimit-recovery-checkNow', params.translate),
                ] : []),
                params.rememberedMode === 'auto_wait'
                    ? buildAction('forget', 'session.usageLimitRecovery.forgetAction', 'session-usageLimit-recovery-forget', params.translate)
                    : buildAction('remember', 'session.usageLimitRecovery.rememberAction', 'session-usageLimit-recovery-remember', params.translate),
            ],
        },
    };
}

export function buildSessionUsageLimitStatusBadgePresentation(
    params: Omit<PresentationParams, 'rememberedMode'>,
): SessionUsageLimitStatusBadgePresentation | null {
    if (!params.featureEnabled || !shouldSurfaceRecoveryIssue(params)) return null;

    const resetAtMs = readResetAtMs(params.issue, params.recovery);
    const recoveryStatus = resolveVisibleRecoveryStatus({
        operationStatus: params.operationStatus,
        recoveryStatus: params.recovery?.status,
    });
    const label = isReadyForResume({
        operationStatus: params.operationStatus,
        resetAtMs,
        nowMs: params.nowMs,
    })
        ? params.translate('session.usageLimitRecovery.statusReady')
        : isTemporaryThrottleIssue(params.issue)
        ? params.translate('session.usageLimitRecovery.statusTemporaryThrottle')
        : recoveryStatus === 'checking'
        ? params.translate('session.usageLimitRecovery.statusChecking')
        : recoveryStatus === 'waiting' && resetAtMs !== null
            ? params.translate('session.usageLimitRecovery.statusWaitingUntil', { time: params.formatTime(resetAtMs) })
            : recoveryStatus === 'waiting'
                ? params.translate('session.usageLimitRecovery.statusWaiting')
                : recoveryStatus === 'paused'
                    ? params.translate('session.usageLimitRecovery.statusPaused')
                    : recoveryStatus === 'exhausted'
                        ? params.translate('session.usageLimitRecovery.statusExhausted')
                        : params.translate('session.usageLimitRecovery.statusLimitReached');

    return {
        key: 'session-usage-limit-recovery',
        label,
        testID: 'session-usageLimit-status-badge',
        accessibilityLabel: label,
        tone: 'warning',
    };
}
