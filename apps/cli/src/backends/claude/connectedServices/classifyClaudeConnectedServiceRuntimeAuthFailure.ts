import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import type { NormalizedProviderUsageLimitDetailsV1 } from './mapClaudeRateLimitEventToUsageDetails';

function readRecord(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value !== 'string') return null;
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

function collectEvidenceText(value: unknown, output: string[]): void {
    if (typeof value === 'string') {
        output.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectEvidenceText(item, output);
        return;
    }
    const record = readRecord(value);
    if (!record) return;
    for (const key of ['type', 'code', 'kind', 'error', 'errors', 'message', 'detail', 'details', 'description', 'subtype']) {
        collectEvidenceText(record[key], output);
    }
}

function collectStatuses(value: unknown, output: number[]): void {
    const record = readRecord(value);
    if (!record) return;
    for (const key of ['api_error_status', 'status', 'statusCode', 'status_code']) {
        const status = readStatus(record[key]);
        if (status !== null) output.push(status);
    }
    for (const key of ['error', 'message', 'result', 'response']) {
        collectStatuses(record[key], output);
    }
}

export function isClaudeRuntimeAuthFailureEvidence(error: unknown): boolean {
    const statuses: number[] = [];
    collectStatuses(error, statuses);
    const textParts: string[] = [];
    collectEvidenceText(error, textParts);
    const text = textParts.join(' ').toLowerCase();

    return statuses.includes(401)
        || /\bauthentication_failed\b/u.test(text)
        || /\bauthentication_error\b/u.test(text)
        || /\binvalid authentication credentials\b/u.test(text)
        || /\bnot logged in\b/u.test(text)
        || /\bplease run \/login\b/u.test(text)
        || /\boauth token has expired\b/u.test(text)
        || /\bfailed to authenticate\b/u.test(text);
}

function classifyClaudeAuthFailure(params: Readonly<{
    error: unknown;
    selection?: unknown;
}>): ConnectedServiceRuntimeFailureClassification | null {
    if (!isClaudeRuntimeAuthFailureEvidence(params.error)) return null;
    const selection = readRecord(params.selection);
    return {
        kind: 'auth_expired',
        limitCategory: 'auth',
        serviceId: readString(selection?.serviceId) ?? 'claude-subscription',
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId: readString(selection?.groupId),
        resetsAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        providerLimitId: null,
        action: null,
        planType: null,
        rateLimits: null,
        source: 'stable_provider_message',
    };
}

export function classifyClaudeConnectedServiceRuntimeAuthFailure(params: Readonly<{
    details?: NormalizedProviderUsageLimitDetailsV1 | null;
    error?: unknown;
    selection?: unknown;
}>): ConnectedServiceRuntimeFailureClassification | null {
    if (!params.details) {
        return classifyClaudeAuthFailure({ error: params.error, selection: params.selection });
    }
    const selection = readRecord(params.selection);
    const kind =
        params.details.limitCategory === 'capacity'
            ? 'capacity'
            : params.details.limitCategory === 'rate_limit' || (params.details.utilization !== null && params.details.utilization < 100)
                ? 'rate_limit'
                : 'usage_limit';
    const limitCategory =
        params.details.limitCategory === 'capacity'
            ? 'capacity'
            : params.details.limitCategory === 'rate_limit' || (params.details.utilization !== null && params.details.utilization < 100)
                ? 'rate_limit'
                : 'quota';
    return {
        kind,
        limitCategory,
        serviceId: readString(selection?.serviceId) ?? 'claude-subscription',
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId: readString(selection?.groupId),
        resetsAtMs: params.details.resetAtMs,
        retryAfterMs: params.details.retryAfterMs,
        quotaScope: params.details.quotaScope,
        providerLimitId: params.details.providerLimitId ?? null,
        action: params.details.action,
        planType: params.details.planType,
        rateLimits: params.details,
        source: 'structured_provider_error',
    };
}
