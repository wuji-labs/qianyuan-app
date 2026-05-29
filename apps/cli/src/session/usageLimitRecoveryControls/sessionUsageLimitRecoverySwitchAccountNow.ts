import {
  SessionRuntimeIssueV1Schema,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

type SwitchAccountNowRequest = Readonly<{
  sessionId: string;
  /**
   * Backend provider id from SessionRuntimeIssueV1.provider, for example
   * "codex"; this is not the connected-service id such as "openai-codex".
   */
  provider?: string;
}>;

type NotifyRuntimeAuthFailure = (body: Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  classification: unknown;
}>) => Promise<unknown>;

type RouteSessionUsageLimitRecoverySwitchAccountNowParams = Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  request?: SwitchAccountNowRequest;
  notifyRuntimeAuthFailure?: NotifyRuntimeAuthFailure;
}>;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readLatestUsageLimitIssue(rawSession: RawSessionRecord): SessionRuntimeIssueV1 | null {
  const parsed = SessionRuntimeIssueV1Schema.safeParse(
    (rawSession as Readonly<{ lastRuntimeIssue?: unknown }>).lastRuntimeIssue,
  );
  if (!parsed.success || parsed.data.source !== 'usage_limit' || !parsed.data.usageLimit) {
    return null;
  }
  return parsed.data;
}

function buildRuntimeAuthClassificationFromUsageLimitIssue(
  issue: SessionRuntimeIssueV1,
): ConnectedServiceRuntimeFailureClassification | null {
  const usageLimit = issue.usageLimit;
  const connectedService = usageLimit?.connectedService;
  if (
    !usageLimit
    || usageLimit.recoverability !== 'switch_account'
    || !connectedService?.serviceId
    || !connectedService.groupId
  ) {
    return null;
  }

  const action = usageLimit.action?.kind === 'open_url'
    ? { kind: 'open_url' as const, url: usageLimit.action.url }
    : null;

  return {
    kind: 'usage_limit',
    serviceId: connectedService.serviceId,
    profileId: connectedService.profileId ?? null,
    groupId: connectedService.groupId,
    resetsAtMs: usageLimit.resetAtMs,
    retryAfterMs: usageLimit.retryAfterMs,
    quotaScope: usageLimit.quotaScope,
    providerLimitId: usageLimit.providerLimitId ?? null,
    action,
    planType: usageLimit.planType ?? null,
    limitCategory: usageLimit.limitCategory ?? 'quota',
    rateLimits: null,
    source: 'provider_runtime_marker',
  };
}

function mapRuntimeAuthSwitchResult(response: unknown): Readonly<{
  ok: true;
  status: 'waiting' | 'exhausted' | 'inactive';
}> | Readonly<{ ok: false; errorCode: string; error: string }> {
  const responseRecord = readRecord(response);
  if (!responseRecord) {
    return stableError('session_usage_limit_recovery_control_switch_failed');
  }
  if (responseRecord.ok === false) {
    const errorCode = readString(responseRecord.errorCode)
      ?? readString(responseRecord.error)
      ?? 'session_usage_limit_recovery_control_switch_failed';
    return stableError(errorCode);
  }

  const result = responseRecord.ok === true && Object.prototype.hasOwnProperty.call(responseRecord, 'result')
    ? responseRecord.result
    : response;
  const resultRecord = readRecord(result);
  const status = readString(resultRecord?.status);
  if (status === 'session_not_found') {
    return { ok: true, status: 'inactive' };
  }
  if (status === 'selection_mismatch') {
    return stableError('session_usage_limit_recovery_control_issue_mismatch');
  }
  if (status === 'not_classified') {
    return stableError('session_usage_limit_recovery_control_inactive');
  }
  if (status === 'recovery_action_required' || status === 'switch_coordinator_unavailable') {
    return stableError('session_usage_limit_recovery_control_switch_unavailable');
  }
  if (status === 'switch_attempted') {
    const switchResult = readRecord(resultRecord?.result);
    const switchStatus = readString(switchResult?.status);
    if (switchStatus === 'no_eligible_member') {
      return { ok: true, status: 'exhausted' };
    }
    if (switchStatus === 'switched') {
      return { ok: true, status: 'waiting' };
    }
  }

  return { ok: true, status: 'waiting' };
}

export async function routeSessionUsageLimitRecoverySwitchAccountNow(
  params: RouteSessionUsageLimitRecoverySwitchAccountNowParams,
): Promise<unknown> {
  const issue = readLatestUsageLimitIssue(params.rawSession);
  if (!issue) {
    return stableError('session_usage_limit_recovery_control_inactive');
  }

  const requestedProvider = readString(params.request?.provider);
  if (requestedProvider && issue.provider && issue.provider !== requestedProvider) {
    return stableError('session_usage_limit_recovery_control_issue_mismatch');
  }

  const classification = buildRuntimeAuthClassificationFromUsageLimitIssue(issue);
  if (!classification) {
    return stableError('session_usage_limit_recovery_control_switch_unavailable');
  }

  try {
    const notify = params.notifyRuntimeAuthFailure ?? notifyDaemonConnectedServiceRuntimeAuthFailure;
    return mapRuntimeAuthSwitchResult(await notify({
      sessionId: params.sessionId,
      switchesThisTurn: 0,
      classification,
    }));
  } catch (error) {
    return {
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      error: error instanceof Error ? error.message : 'session_usage_limit_recovery_control_switch_failed',
    };
  }
}
