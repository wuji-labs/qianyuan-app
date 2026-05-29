import { readHttpStatus } from '../../api/client/httpStatusError';
import type { DaemonServerWorkErrorClassification } from './types';

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readHeader(headers: unknown, name: string): string | null {
  const record = asRecord(headers);
  if (!record) return null;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) {
      const first = value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      return first?.trim() ?? null;
    }
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readRetryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);
  if (typeof record?.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)) {
    return Math.max(0, Math.trunc(record.retryAfterMs));
  }
  const response = asRecord(record?.response);
  const header = readHeader(response?.headers, 'retry-after');
  if (!header) return undefined;

  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const dateMs = Date.parse(header);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function readErrorCode(error: unknown): string {
  const record = asRecord(error);
  const code = record?.code;
  return typeof code === 'string' ? code : '';
}

function readPreservedStatus(error: unknown): number | null {
  const status = readHttpStatus(error);
  if (status !== null) return status;
  const record = asRecord(error);
  const topLevelStatus = record?.status;
  return typeof topLevelStatus === 'number' && Number.isFinite(topLevelStatus)
    ? Math.trunc(topLevelStatus)
    : null;
}

export function classifyDaemonServerWorkError(
  error: unknown,
  options: Readonly<{ featureAbsentStatusCodes?: readonly number[] }> = {},
): DaemonServerWorkErrorClassification {
  const statusCode = readPreservedStatus(error) ?? undefined;
  if (statusCode === 401 || statusCode === 403) {
    return { kind: 'auth_failed', retryable: false, statusCode };
  }

  if (typeof statusCode === 'number') {
    if (options.featureAbsentStatusCodes?.includes(statusCode)) {
      return { kind: 'unsupported', retryable: false, statusCode };
    }
    if (statusCode === 409) {
      return { kind: 'generation_conflict', retryable: true, statusCode };
    }
    if (statusCode === 429) {
      return {
        kind: 'rate_limited',
        retryable: true,
        statusCode,
        retryAfterMs: readRetryAfterMs(error),
      };
    }
    if (statusCode === 408 || statusCode === 425 || statusCode >= 500) {
      return { kind: 'server_error', retryable: true, statusCode };
    }
    if (statusCode >= 400) {
      return { kind: 'client_error', retryable: false, statusCode };
    }
  }

  const code = readErrorCode(error);
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return { kind: 'timeout', retryable: true };
  }
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return { kind: 'network', retryable: true };
  }

  return { kind: 'protocol_error', retryable: false };
}
