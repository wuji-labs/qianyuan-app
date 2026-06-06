import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import type { NormalizedProviderUsageLimitDetailsV1 } from './mapClaudeRateLimitEventToUsageDetails';

type RuntimeIssueSession = Readonly<{
    client: {
        sessionId: string;
        sendSessionEvent?: (event: SessionEventMessage) => void;
        sessionTurnLifecycle?: {
            failTurn?: (params: { provider: 'claude'; issue: SessionRuntimeIssueV1 }) => Promise<void> | void;
        };
    };
}>;

export async function surfaceClaudeRateLimitRuntimeIssue(
    session: RuntimeIssueSession,
    details: NormalizedProviderUsageLimitDetailsV1,
    logPrefix: string,
): Promise<void> {
    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        selection:
            findConnectedServiceChildSelection(process.env, 'claude-subscription')
            ?? findConnectedServiceChildSelection(process.env, 'anthropic')
            ?? undefined,
    });
    if (!classification) return;
    const connectedServiceId = classification.serviceId === 'anthropic' ? 'anthropic' : 'claude-subscription';
    const isProviderCapacity = classification.kind === 'capacity' || classification.limitCategory === 'capacity';
    const issue: SessionRuntimeIssueV1 = {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: isProviderCapacity ? 'provider_status_error' : 'usage_limit',
        source: isProviderCapacity ? 'provider_status_error' : 'usage_limit',
        occurredAt: Date.now(),
        provider: 'claude',
        sanitizedPreview: isProviderCapacity ? 'Provider reported an error' : 'Usage limit reached',
        usageLimit: {
            ...details,
            connectedService: {
                serviceId: connectedServiceId,
                profileId: classification.profileId,
                groupId: classification.groupId,
            },
        },
    };
    await session.client.sessionTurnLifecycle?.failTurn?.({
        provider: 'claude',
        issue,
    });
    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: session.client.sessionId,
        switchesThisTurn: 0,
        classification,
        logPrefix,
    });
    projectConnectedServiceRuntimeAuthRecoveryReport({
        report: recoveryReport,
        sendGenericStatusMessage: (message) => {
            if (!session.client.sendSessionEvent) return false;
            session.client.sendSessionEvent({ type: 'message', message });
            return true;
        },
        commitTypedProjection: (projection) => {
            if (!projection.transcriptEvent) return false;
            session.client.sendSessionEvent?.(projection.transcriptEvent);
            return Boolean(session.client.sendSessionEvent);
        },
    });
}

export async function surfaceClaudeConnectedServiceRuntimeAuthFailure(
    session: RuntimeIssueSession,
    error: unknown,
    logPrefix: string,
): Promise<void> {
    const selection =
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic')
        ?? null;
    if (!selection) return;

    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        error,
        selection,
    });
    if (!classification) return;

    const issue: SessionRuntimeIssueV1 = {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'auth_error',
        source: 'auth_error',
        occurredAt: Date.now(),
        provider: 'claude',
        sanitizedPreview: 'Authentication failed',
    };
    await session.client.sessionTurnLifecycle?.failTurn?.({
        provider: 'claude',
        issue,
    });

    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: session.client.sessionId,
        switchesThisTurn: 0,
        classification,
        logPrefix,
    });
    projectConnectedServiceRuntimeAuthRecoveryReport({
        report: recoveryReport,
        sendGenericStatusMessage: (message) => {
            if (!session.client.sendSessionEvent) return false;
            session.client.sendSessionEvent({ type: 'message', message });
            return true;
        },
        commitTypedProjection: (projection) => {
            if (!projection.transcriptEvent) return false;
            session.client.sendSessionEvent?.(projection.transcriptEvent);
            return Boolean(session.client.sendSessionEvent);
        },
    });
}
