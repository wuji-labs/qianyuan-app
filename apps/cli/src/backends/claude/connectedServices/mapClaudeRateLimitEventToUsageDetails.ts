import { parseProviderResetAt, parseProviderTimestampMs } from '@/daemon/connectedServices/quotas/normalization';

export type NormalizedProviderUsageLimitDetailsV1 = Readonly<{
  v: 1;
  resetAtMs: number | null;
  retryAfterMs: number | null;
  limitCategory?: 'quota' | 'rate_limit' | 'capacity' | 'unknown';
  quotaScope: 'account' | 'workspace' | 'organization' | 'model' | 'provider' | 'unknown';
  recoverability: 'wait' | 'switch_account' | 'manual' | 'unknown';
  providerLimitId?: string;
  planType: string | null;
  utilization: number | null;
  overage: Readonly<{
    status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
    resetAtMs: number | null;
    disabledReason?: string | null;
  }> | null;
  action: null;
  connectedService: null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readNonNegativeIntegerLike(value: unknown): number | null {
  if (typeof value === 'number') return readNonNegativeInteger(value);
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value.trim());
  return readNonNegativeInteger(parsed);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestampMs(value: unknown): number | null {
  const integer = readNonNegativeInteger(value);
  if (integer !== null) return integer < 10_000_000_000 ? integer * 1000 : integer;
  return parseProviderTimestampMs(value);
}

function readUtilization(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function readHttpStatus(value: unknown): number | null {
  const status = readNonNegativeIntegerLike(value);
  return status === null || status < 100 || status > 599 ? null : status;
}

function normalizeOverageStatus(value: unknown): 'allowed' | 'allowed_warning' | 'rejected' | 'unknown' {
  return value === 'allowed' || value === 'allowed_warning' || value === 'rejected' ? value : 'unknown';
}

function readHeaders(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value.response : null;
  const headers = isRecord(response) ? response.headers : isRecord(value) ? value.headers : null;
  if (!isRecord(headers)) return null;
  const normalized: Record<string, unknown> = {};
  for (const [key, headerValue] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = headerValue;
  }
  return normalized;
}

function readFirstField(records: readonly Record<string, unknown>[], names: readonly string[]): unknown {
  for (const record of records) {
    for (const name of names) {
      if (record[name] !== undefined) return record[name];
    }
  }
  return undefined;
}

function collectSyntheticApiErrorRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const records = [record];
  const error = isRecord(record.error) ? record.error : null;
  if (error) records.push(error);
  const message = isRecord(record.message) ? record.message : null;
  if (message) {
    records.push(message);
    if (isRecord(message.error)) records.push(message.error);
  }
  const result = isRecord(record.result) ? record.result : null;
  if (result) {
    records.push(result);
    if (isRecord(result.error)) records.push(result.error);
  }
  return records;
}

function containsRateLimitEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /rate[ _-]?limit(?:ed)?/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsRateLimitEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
  ].some(containsRateLimitEvidence);
}

function containsTransientThrottleEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /temporarily\s+limiting\s+requests/iu.test(value)
      || /not\s+your\s+usage\s+limit/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsTransientThrottleEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
    value.text,
    value.content,
  ].some(containsTransientThrottleEvidence);
}

function containsProviderCapacityEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\b529\b/u.test(value)
      || /\boverloaded(?:_error)?\b/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsProviderCapacityEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
    value.text,
    value.content,
  ].some(containsProviderCapacityEvidence);
}

function readSyntheticProviderLimitId(records: readonly Record<string, unknown>[]): string | undefined {
  if (records.some(containsProviderCapacityEvidence)) return 'server_overloaded';
  if (records.some(containsTransientThrottleEvidence)) return 'transient';
  for (const names of [
    ['providerLimitId', 'provider_limit_id', 'limit', 'limitType', 'limit_type'],
    ['code', 'error', 'type', 'kind'],
  ] as const) {
    for (const record of records) {
      for (const name of names) {
        const text = readString(record[name]);
        if (!text) continue;
        if (containsRateLimitEvidence(text)) return 'rate_limit';
        if (
          name === 'providerLimitId' ||
          name === 'provider_limit_id' ||
          name === 'limit' ||
          name === 'limitType' ||
          name === 'limit_type'
        ) {
          return text;
        }
      }
    }
  }
  return undefined;
}

function readSyntheticResetAtMs(records: readonly Record<string, unknown>[]): number | null {
  return readTimestampMs(readFirstField(records, [
    'resetAtMs',
    'reset_at_ms',
    'resetsAt',
    'resets_at',
    'resetAt',
    'reset_at',
    'quotaResetTimeStamp',
    'quotaResetTimestamp',
    'quota_reset_timestamp',
  ]));
}

function readSyntheticRetryAfterMs(records: readonly Record<string, unknown>[]): number | null {
  return readNonNegativeIntegerLike(readFirstField(records, [
    'retryAfterMs',
    'retry_after_ms',
    'retry-after-ms',
  ]));
}

function mapSyntheticClaudeApiErrorToUsageDetails(record: Record<string, unknown>): NormalizedProviderUsageLimitDetailsV1 | null {
  const records = collectSyntheticApiErrorRecords(record);
  const status = readHttpStatus(readFirstField(records, ['apiErrorStatus', 'api_error_status', 'status', 'statusCode', 'status_code']));
  const hasRateLimitEvidence = containsRateLimitEvidence(record);
  const hasProviderCapacityEvidence = status === 529 || containsProviderCapacityEvidence(record);
  const hasCompatibleStatus = status === null || status === 429 || status === 529;
  const isAssistantApiError =
    record.type === 'assistant' &&
    record.isApiErrorMessage === true &&
    (hasRateLimitEvidence || hasProviderCapacityEvidence || status === 429) &&
    hasCompatibleStatus;
  const isResultApiError =
    record.type === 'result' &&
    hasCompatibleStatus &&
    (status === 429 || hasRateLimitEvidence || hasProviderCapacityEvidence) &&
    (
      status === 429 ||
      status === 529 ||
      record.is_error === true ||
      readString(record.subtype)?.includes('error') === true
    );
  if (!isAssistantApiError && !isResultApiError) return null;

  const timing = parseProviderResetAt({ body: record, nowMs: Date.now() });
  const resetAtMs = readSyntheticResetAtMs(records) ?? timing.resetAtMs;
  const retryAfterMs = readSyntheticRetryAfterMs(records) ?? timing.retryAfterMs;
  const providerLimitId = readSyntheticProviderLimitId(records);

  return {
    v: 1,
    resetAtMs,
    retryAfterMs,
    ...(hasProviderCapacityEvidence ? { limitCategory: 'capacity' as const } : {}),
    quotaScope: 'account',
    recoverability: 'wait',
    ...(providerLimitId ? { providerLimitId } : {}),
    planType: null,
    utilization: readUtilization(readFirstField(records, ['utilization', 'usedPercent', 'used_percent'])),
    overage: null,
    action: null,
    connectedService: null,
  };
}

function mapClaudeHeadersToUsageDetails(value: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  const headers = readHeaders(value);
  if (!headers) return null;
  const timing = parseProviderResetAt({ headers, body: value, nowMs: Date.now() });
  const resetAtMs =
    readTimestampMs(headers['anthropic-ratelimit-tokens-reset'])
    ?? readTimestampMs(headers['anthropic-ratelimit-requests-reset'])
    ?? readTimestampMs(headers['anthropic-ratelimit-input-tokens-reset'])
    ?? readTimestampMs(headers['anthropic-ratelimit-output-tokens-reset'])
    ?? timing.resetAtMs;
  if (timing.retryAfterMs === null && resetAtMs === null) return null;
  return {
    v: 1,
    resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    quotaScope: 'account',
    recoverability: 'wait',
    planType: null,
    utilization: null,
    overage: null,
    action: null,
    connectedService: null,
  };
}

export function mapClaudeStopFailureErrorToUsageDetails(
  errorType: string | null | undefined,
): NormalizedProviderUsageLimitDetailsV1 | null {
  if (readString(errorType) !== 'rate_limit') return null;
  return {
    v: 1,
    resetAtMs: null,
    retryAfterMs: null,
    quotaScope: 'account',
    recoverability: 'wait',
    providerLimitId: 'rate_limit',
    planType: null,
    utilization: null,
    overage: null,
    action: null,
    connectedService: null,
  };
}

export function mapClaudeStopFailureHookToUsageDetails(hook: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  const record = isRecord(hook) ? hook : null;
  if (!record) return null;
  const hookEventName = readString(record.hook_event_name ?? record.hookEventName);
  if (hookEventName !== 'StopFailure') return null;
  const direct = mapClaudeStopFailureErrorToUsageDetails(readString(record.error) ?? readString(record.error_type));
  if (direct) return direct;
  const lastAssistantMessage = readString(record.last_assistant_message ?? record.lastAssistantMessage);
  if (!lastAssistantMessage) return null;
  return mapSyntheticClaudeApiErrorToUsageDetails({
    type: 'assistant',
    isApiErrorMessage: true,
    text: lastAssistantMessage,
    content: lastAssistantMessage,
    error: record.error,
    error_type: record.error_type,
    apiErrorStatus: record.apiErrorStatus ?? record.api_error_status ?? record.status,
  });
}

export function mapClaudeRateLimitEventToUsageDetails(event: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  const record = isRecord(event) ? event : null;
  if (record?.type !== 'rate_limit_event') {
    return record
      ? mapSyntheticClaudeApiErrorToUsageDetails(record) ?? mapClaudeHeadersToUsageDetails(event)
      : mapClaudeHeadersToUsageDetails(event);
  }
  const info = isRecord(record.rate_limit_info) ? record.rate_limit_info : null;
  if (!info) return null;
  const status = readString(info.status);
  if (status !== 'rejected') return null;
  const rateLimitType = readString(info.rateLimitType ?? info.rate_limit_type);
  const overageStatusRaw = info.overageStatus ?? info.overage_status;
  const overageStatus = normalizeOverageStatus(overageStatusRaw);
  const overageResetAtMs = readTimestampMs(info.overageResetsAt ?? info.overage_resets_at);
  const overageDisabledReason = readString(info.overageDisabledReason ?? info.overage_disabled_reason);

  return {
    v: 1,
    resetAtMs: readTimestampMs(info.resetsAt ?? info.resets_at),
    retryAfterMs: null,
    quotaScope: 'account',
    recoverability: 'wait',
    ...(rateLimitType ? { providerLimitId: rateLimitType } : {}),
    planType: null,
    utilization: readUtilization(info.utilization),
    overage: overageStatusRaw === undefined && overageResetAtMs === null && overageDisabledReason === null
      ? null
      : {
          status: overageStatus,
          resetAtMs: overageResetAtMs,
          ...(overageDisabledReason ? { disabledReason: overageDisabledReason } : {}),
        },
    action: null,
    connectedService: null,
  };
}
