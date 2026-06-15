import {
  ConnectedServiceQuotaSnapshotV1Schema,
  type ConnectedServiceId,
  type ConnectedServiceProfileId,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { unwrapCodexRateLimitSnapshot } from '../appServer/rateLimitSnapshot';
import { parseProviderTimestampMs } from '@/daemon/connectedServices/quotas/normalization';

export const CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCodexSnapshotAccount(rawSnapshot: unknown, unwrappedSnapshot: unknown): Record<string, unknown> {
  const rawRecord = isRecord(rawSnapshot) ? rawSnapshot : {};
  const unwrappedRecord = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : {};
  const account =
    (isRecord(unwrappedRecord.account) ? unwrappedRecord.account : null)
    ?? (isRecord(rawRecord.account) ? rawRecord.account : null)
    ?? {};
  return account;
}

function readCodexSnapshotActiveAccountId(account: Record<string, unknown>): string | null {
  return readString(
    account.id
      ?? account.accountId
      ?? account.account_id
      ?? account.chatgptAccountId
      ?? account.chatgpt_account_id,
  );
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function readUtilizationPct(value: unknown): number | null {
  const numeric = readFiniteNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, numeric));
}

function readRelativeResetAtMs(record: Record<string, unknown>, nowMs: number): number | null {
  const seconds = readFiniteNumber(record.resetsInSeconds ?? record.resets_in_seconds);
  if (seconds === null || seconds < 0) return null;
  return Math.trunc(nowMs + seconds * 1000);
}

function buildMeter(meterId: 'primary' | 'secondary', raw: unknown, nowMs: number): ConnectedServiceQuotaMeterV1 | null {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  const utilizationPct = readUtilizationPct(record.usedPercent ?? record.used_percent ?? record.utilizationPct ?? record.utilization_pct);
  const used = readFiniteNumber(record.used ?? record.usedTokens ?? record.used_tokens);
  const limit = readFiniteNumber(record.limit ?? record.tokenLimit ?? record.token_limit);
  // Absolute reset fields win; legacy relative `resets_in_seconds` shapes are converted
  // to an absolute timestamp at mapping time (RD-QUO-1) so F0 durable-wait timing and
  // member providerResetsAtMs carry true reset evidence instead of null.
  const resetsAt = parseProviderTimestampMs(record.resetsAt ?? record.resets_at ?? record.resetAt ?? record.reset_at)
    ?? readRelativeResetAtMs(record, nowMs);
  if (utilizationPct === null && used === null && limit === null && resetsAt === null) return null;
  const derivedRemainingPct = utilizationPct !== null
    ? Math.max(0, Math.min(100, 100 - utilizationPct))
    : used !== null && limit !== null && limit > 0
    ? Math.max(0, Math.min(100, ((limit - used) / limit) * 100))
    : null;
  const providerLimitId =
    readString(record.providerLimitId ?? record.provider_limit_id ?? record.limitId ?? record.limit_id)
    ?? meterId;
  return {
    meterId,
    label: meterId === 'primary' ? 'Primary' : 'Secondary',
    used,
    limit,
    remainingPct: derivedRemainingPct,
    resetAtMs: resetsAt,
    providerLimitId,
    unit: 'unknown',
    utilizationPct,
    resetsAt,
    status: 'ok',
    source: 'in_band_provider_snapshot',
    scope: meterId,
    limitScope: 'account',
    confidence: utilizationPct !== null || (used !== null && limit !== null) ? 'exact' : 'unknown',
    details: {},
  };
}

export function mapCodexRateLimitSnapshotToQuotaSnapshot(params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId;
  activeAccountId?: string | null;
  accountLabel?: string | null;
  fetchedAt: number;
  staleAfterMs?: number;
  rawSnapshot: unknown;
}>): ConnectedServiceQuotaSnapshotV1 {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(params.rawSnapshot);
  const raw = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : {};
  const account = readCodexSnapshotAccount(params.rawSnapshot, unwrappedSnapshot);
  const relativeResetReferenceMs = Math.max(0, Math.trunc(params.fetchedAt));
  const meters = [
    buildMeter('primary', raw.primary ?? raw.primary_window ?? raw.primaryWindow, relativeResetReferenceMs),
    buildMeter('secondary', raw.secondary ?? raw.secondary_window ?? raw.secondaryWindow, relativeResetReferenceMs),
  ].filter((meter): meter is ConnectedServiceQuotaMeterV1 => meter !== null);
  const activeAccountId = readCodexSnapshotActiveAccountId(account) ?? readString(params.activeAccountId);

  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    fetchedAt: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAfterMs: params.staleAfterMs ?? CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS,
    providerId: 'codex',
    ...(activeAccountId ? { activeAccountId } : {}),
    fetchedAtMs: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAtMs: Math.max(0, Math.trunc(params.fetchedAt)) + (params.staleAfterMs ?? CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS),
    source: 'in_band_provider_snapshot',
    confidence: meters.length > 0 ? 'exact' : 'unknown',
    planLabel: readString(raw.planType ?? raw.plan_type),
    accountLabel: readString(account.email ?? raw.email ?? raw.accountLabel ?? raw.account_label ?? params.accountLabel),
    meters,
  });
}
