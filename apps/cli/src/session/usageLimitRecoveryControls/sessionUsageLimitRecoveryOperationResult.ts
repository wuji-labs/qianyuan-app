import {
  SessionUsageLimitRecoveryOperationResultV1Schema,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

type NormalizeCliSessionUsageLimitRecoveryOperationResultParams = Readonly<{
  sessionId: string;
  result: unknown;
}>;

export function normalizeCliSessionUsageLimitRecoveryOperationResult(
  params: NormalizeCliSessionUsageLimitRecoveryOperationResultParams,
): SessionUsageLimitRecoveryOperationResultV1 {
  const normalized = normalizeSessionUsageLimitRecoveryOperationResultV1(params.result, {
    sessionId: params.sessionId,
  });

  if (normalized.ok) {
    return SessionUsageLimitRecoveryOperationResultV1Schema.parse(normalized);
  }

  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ...normalized,
    sessionId: normalized.sessionId ?? params.sessionId,
  });
}

export function attachCliSessionUsageLimitRecoveryOperationMetadata<T extends SessionUsageLimitRecoveryOperationResultV1>(
  result: T,
  metadata: Record<string, unknown> | null | undefined,
): T {
  if (!metadata) return result;
  Object.defineProperty(result, 'metadata', {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
  return result;
}
