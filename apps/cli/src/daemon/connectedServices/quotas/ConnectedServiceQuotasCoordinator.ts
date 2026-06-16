import {
  ConnectedServiceIdSchema,
  type ConnectedServiceAuthGroupRuntimeStatePatchRequestV1,
  type ConnectedServiceAuthGroupV1,
  openConnectedServiceCredentialCiphertext,
  openConnectedServiceQuotaSnapshotCiphertext,
  sealConnectedServiceQuotaSnapshotCiphertext,
  type ConnectedServiceCredentialHealthV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  invalidateConnectedServiceAccountMode,
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  createKeyedBackoffTracker,
} from '@/api/connection/scheduling';
import {
  classifyDaemonServerWorkError,
  type DaemonServerWorkGate,
  type DaemonServerWorkGateResult,
  type DaemonServerWorkOutcome,
  type DaemonServerWorkScheduler,
} from '@/daemon/serverWork';

import {
  readConnectedServiceChildSelectionsFromEnv,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  buildConnectedServiceAuthGroupSwitchState,
  normalizeConnectedServiceAuthGroupPolicy,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceQuotaFetcher } from './types';
import {
  buildQuotaPersistenceKey,
  resolveQuotaPersistenceAccountScope,
  type QuotaPersistenceAccountScope,
} from './quotaPersistenceKey';
import {
  computeQuotaSnapshotFingerprint,
  deriveQuotaSnapshotFingerprintHmacKey,
} from './quotaSnapshotFingerprint';
import { shouldPersistQuotaSnapshot, type ShouldPersistQuotaSnapshotStatus } from './shouldPersistQuotaSnapshot';
import {
  createConnectedServiceQuotaPersistenceScheduler,
  type ConnectedServiceQuotaPersistenceFlushResult as InProcessQuotaPersistenceFlushResult,
  type ConnectedServiceQuotaPersistenceScheduler,
} from './createConnectedServiceQuotaPersistenceScheduler';
import { RuntimeAccountIdentityIndex } from './identity/RuntimeAccountIdentityIndex';
import { resolveSessionsSharingProviderAccount } from './identity/resolveSessionsSharingProviderAccount';
import {
  requiresExactProviderAccountFanout,
  type ConnectedServiceSameAccountFanoutStrategy,
} from './identity/providerFanoutStrategy';
import type {
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
} from './identity/runtimeAccountIdentityTypes';
import {
  resolveQuotaProbeFreshProof,
  type QuotaProbeFreshProofResult,
} from './proof/quotaProbeFreshProof';

const DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_REFRESH_MS = 60_000;
const ACCOUNT_MODE_UNKNOWN_RETRY_AFTER_MS = 30_000;
const SAME_ACCOUNT_FANOUT_RESET_BUCKET_MS = 60_000;

type ConnectedServicesBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

type QuotaApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountMode>;
  getConnectedServiceQuotaSnapshotSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          refreshRequestedAt?: number;
          materialFingerprint?: string;
        }>;
      }>
  >;
  getConnectedServiceQuotaSnapshotPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    | null
    | Readonly<{
        content: Readonly<{ t: 'plain'; v: ConnectedServiceQuotaSnapshotV1 }>;
        metadata: Readonly<{
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          refreshRequestedAt?: number;
          materialFingerprint?: string;
        }>;
      }>
  >;
  getConnectedServiceCredentialSealed: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    | null
    | Readonly<{
        sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
        metadata: Readonly<{ kind: string }>;
      }>
  >;
  getConnectedServiceCredentialPlain?: (args: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<
    | null
    | Readonly<{
        content: Readonly<{ t: 'plain'; v: ConnectedServiceCredentialRecordV1 }>;
      }>
  >;
  listConnectedServiceProfiles?: (args: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<
    Readonly<{
      serviceId: ConnectedServiceId;
      profiles: ReadonlyArray<
        Readonly<{
          profileId: string;
          status: ConnectedServiceCredentialHealthStatusV1;
        }>
      >;
    }>
  >;
  registerConnectedServiceQuotaSnapshotSealed: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; materialFingerprint?: string }>;
  }>) => Promise<void>;
  registerConnectedServiceQuotaSnapshotPlain?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    content: Readonly<{ t: 'plain'; v: ConnectedServiceQuotaSnapshotV1 }>;
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; materialFingerprint?: string }>;
  }>) => Promise<void>;
  acquireConnectedServiceRefreshLease?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    ownerId?: string;
    leaseMs: number;
  }>) => Promise<Readonly<{ acquired: boolean; leaseUntil: number }>>;
  updateConnectedServiceCredentialHealth?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
  }>) => Promise<void>;
  getConnectedServiceAuthGroup?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupRuntimeState?: (args: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration: number;
    memberStates: ReadonlyArray<Readonly<ConnectedServiceAuthGroupRuntimeStatePatchRequestV1['memberStates'][number]>>;
  }>) => Promise<ConnectedServiceAuthGroupV1>;
}>;

type ExistingQuotaSnapshotResponse =
  | Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>
  | Awaited<ReturnType<NonNullable<QuotaApi['getConnectedServiceQuotaSnapshotPlain']>>>;

type ResolvedQuotaStorageMode = 'e2ee' | 'plain';
type ResolvedExistingQuotaSnapshot = Readonly<{
  storageMode: ResolvedQuotaStorageMode;
  existing: ExistingQuotaSnapshotResponse;
}>;
export type ConnectedServiceInBandQuotaSnapshotRecordResult =
  | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
  | Readonly<{ status: 'suppressed'; reason: string }>
  | Readonly<{ status: 'persisted' }>
  | Readonly<{ status: 'deferred_unknown_mode' }>;

export type ConnectedServiceQuotaPersistenceFlushResult = Readonly<{
  timedOut: boolean;
  inProcess: InProcessQuotaPersistenceFlushResult;
  serverWork: Readonly<{ timedOut: boolean }> | null;
}>;

type InBandQuotaPersistencePayload = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  snapshot: ConnectedServiceQuotaSnapshotV1;
  materialFingerprint: string;
  status: ShouldPersistQuotaSnapshotStatus;
}>;

type PersistedInBandQuotaState = Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  fingerprint: string | null;
  status: ShouldPersistQuotaSnapshotStatus;
  fetchedAt: number;
  refreshRequestedAt?: number;
}>;

type SpawnTarget = Readonly<{
  pid: number;
  sessionId?: string;
  bindings: ConnectedServicesBindingsV1Like;
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>;
}>;

type ProfileHealthByServiceId = Map<ConnectedServiceId, Map<string, ConnectedServiceCredentialHealthStatusV1>>;
type ActiveConnectedServiceBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string;
}>;
type ActiveGroupQuotaSwitchTarget = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
}>;
type QuotaWorkPhase = 'tick' | 'hydrate_group' | 'probe_group' | 'soft_switch' | 'same_account_fanout';
export type ConnectedServiceQuotaCoordinatorDiagnostic = Readonly<{
  event: 'quota_work_deferred' | 'quota_work_suppressed';
  phase: QuotaWorkPhase;
  reason: string;
  retryAfterMs?: number;
}>;
type AuthGroupSwitchCoordinator = Readonly<{
  switchBeforeTurn(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<unknown>;
}>;
type SoftSwitchRecoveryGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress' | 'fold'; reason: string }>;
export type ConnectedServiceQuotaSoftSwitchRecoveryGuard = (
  input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    reason: 'soft_threshold';
  }>,
) => SoftSwitchRecoveryGuardResult | Promise<SoftSwitchRecoveryGuardResult>;
type ConnectedServiceSameAccountFanoutStrategyResolver = (input: Readonly<{
  sourceSessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => ConnectedServiceSameAccountFanoutStrategy | Promise<ConnectedServiceSameAccountFanoutStrategy>;

/**
 * RD-QUO-13: edge-triggered quota lifecycle transition emitted by the coordinator.
 *
 * `blocked` fires once when fresh evidence shows a group has NO immediately eligible
 * member (every member limited/disabled) while group-bound sessions exist; `recovered`
 * fires once when a later eligibility pass frees a member (F7 fresh-quota clearing).
 * Producers built on this hook stay host-side and provider-agnostic.
 */
export type ConnectedServiceQuotaLifecycleTransition = Readonly<{
  phase: 'blocked' | 'recovered';
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string | null;
  sessionIds: ReadonlyArray<string>;
  issueFingerprint: string;
  resetAtMs: number | null;
  reason: string;
}>;
export type ConnectedServiceQuotaLifecycleListener = (
  transition: ConnectedServiceQuotaLifecycleTransition,
) => void | Promise<void>;

type SoftSwitchPolicyGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress'; reason: string }>;
export type ConnectedServiceQuotaSoftSwitchPolicyGuard = (
  input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    reason: 'soft_threshold';
  }>,
) => SoftSwitchPolicyGuardResult | Promise<SoftSwitchPolicyGuardResult>;

function buildResolvedSelectionProfilesByServiceId(
  env: Pick<NodeJS.ProcessEnv, string> | undefined,
): ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection> {
  const selections = env ? readConnectedServiceChildSelectionsFromEnv(env) : [];
  return new Map(selections.map((selection) => [selection.serviceId, selection]));
}

function resolveProfileIdFromSelection(input: Readonly<{
  binding: Record<string, unknown>;
  serviceId: ConnectedServiceId;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection>;
}>): string {
  const selection = input.selectionsByServiceId.get(input.serviceId);
  const explicitProfileId = typeof input.binding.profileId === 'string' ? String(input.binding.profileId).trim() : '';
  const groupId = typeof input.binding.groupId === 'string' ? String(input.binding.groupId).trim() : '';
  if (groupId) {
    if (!selection || selection.kind !== 'group') return explicitProfileId;
    if (selection.groupId !== groupId) return explicitProfileId;
    return selection.activeProfileId;
  }

  if (explicitProfileId) return explicitProfileId;
  if (!selection || selection.kind !== 'profile') return '';
  return selection.profileId;
}

function extractActiveBindings(
  raw: ConnectedServicesBindingsV1Like,
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>,
): ActiveConnectedServiceBinding[] {
  const out: ActiveConnectedServiceBinding[] = [];
  const selectionsByServiceId = buildResolvedSelectionProfilesByServiceId(connectedServiceSelectionsEnv);
  const bindings = raw?.bindingsByServiceId ?? {};
  for (const [serviceId, binding] of Object.entries(bindings)) {
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceId);
    if (!parsedServiceId.success) continue;
    const bindingObj = binding && typeof binding === 'object' ? (binding as Record<string, unknown>) : null;
    const source = typeof bindingObj?.source === 'string' ? String(bindingObj.source) : '';
    if (source !== 'connected') continue;
    if (!bindingObj) continue;
    const profileId = resolveProfileIdFromSelection({
      binding: bindingObj,
      serviceId: parsedServiceId.data,
      selectionsByServiceId,
    });
    if (!profileId.trim()) continue;
    const selection = selectionsByServiceId.get(parsedServiceId.data);
    const groupId = selection?.kind === 'group' && selection.activeProfileId === profileId
      ? selection.groupId.trim()
      : '';
    out.push({
      serviceId: parsedServiceId.data,
      profileId,
      ...(groupId ? { groupId } : {}),
    });
  }
  return out;
}

function deriveQuotaSnapshotStatus(snapshot: ConnectedServiceQuotaSnapshotV1): 'ok' | 'unavailable' | 'estimated' {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  if (meters.length === 0) return 'ok';
  const statuses = meters.map((m: any) => (typeof m?.status === 'string' ? m.status : ''));
  if (statuses.every((s) => s === 'unavailable')) return 'unavailable';
  if (statuses.some((s) => s === 'estimated')) return 'estimated';
  return 'ok';
}

type FailureState = Readonly<{
  consecutiveFailures: number;
  nextAllowedAt: number;
}>;

type CredentialRefreshReason = 'near_expiry' | 'auth_failure';
type RefreshConnectedServiceCredentialForQuota = (input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  force: boolean;
  reason: CredentialRefreshReason;
}>) => Promise<ConnectedServiceCredentialRecordV1 | null>;

function readFiniteNonNegativeMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isQuotaAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Readonly<{ quotaFetchErrorCode?: unknown; status?: unknown }>;
  return record.quotaFetchErrorCode === 'auth_failure' || record.status === 401;
}

function providerHttpStatusForHealth(status: unknown): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

function quotaAuthFailureKindForHealth(error: unknown): ConnectedServiceCredentialHealthV1['lastRefreshFailureKind'] {
  if (!error || typeof error !== 'object') return 'unknown';
  const status = (error as Readonly<{ status?: unknown }>).status;
  if (status === 401) return 'provider_401';
  if (status === 403) return 'provider_403';
  return 'unknown';
}

function providerErrorCodeForHealth(code: unknown): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function buildQuotaAuthFailureCredentialHealth(
  error: unknown,
  now: number,
): ConnectedServiceCredentialHealthV1 {
  const status = providerHttpStatusForHealth((error as Readonly<{ status?: unknown }> | null)?.status);
  const providerCode = providerErrorCodeForHealth((error as Readonly<{ providerCode?: unknown }> | null)?.providerCode);
  return {
    v: 1,
    status: 'needs_reauth',
    reconnectRequired: true,
    lastRefreshAttemptAt: now,
    lastRefreshFailureAt: now,
    lastRefreshFailureKind: quotaAuthFailureKindForHealth(error),
    ...(status !== undefined ? { providerHttpStatus: status } : {}),
    ...(providerCode !== undefined ? { providerErrorCode: providerCode } : {}),
  };
}

function readQuotaRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  return readFiniteNonNegativeMs((error as Readonly<{ retryAfterMs?: unknown }>).retryAfterMs);
}

function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, Math.max(0, Math.trunc(ms)));
    (handle as unknown as { unref?: () => void })?.unref?.();
  });
}

/**
 * X8 — Stale-but-usable quota.
 *
 * Returns a copy of the snapshot with all meters annotated as stale_quota so
 * the UI can show "last known data (refresh failed)" rather than a blank.
 * The meter data (utilizationPct, resetsAt, etc.) is preserved.
 */
function annotateSnapshotAsStale(snapshot: ConnectedServiceQuotaSnapshotV1): ConnectedServiceQuotaSnapshotV1 {
  return {
    ...snapshot,
    meters: snapshot.meters.map((meter) => ({
      ...meter,
      details: {
        ...meter.details,
        code: 'stale_quota',
      },
    })),
  };
}

function isQuotaUnknownFallbackSnapshot(snapshot: ConnectedServiceQuotaSnapshotV1): boolean {
  const meters = Array.isArray(snapshot.meters) ? snapshot.meters : [];
  return meters.length > 0 && meters.every((meter) => (
    meter.status === 'unavailable'
    && isRecord(meter.details)
    && meter.details.code === 'quota_unknown'
  ));
}

class UnknownAccountModeQuotaPersistenceError extends Error {
  public readonly code = 'HAPPIER_ACCOUNT_MODE_UNKNOWN';
  public readonly retryAfterMs = ACCOUNT_MODE_UNKNOWN_RETRY_AFTER_MS;

  public constructor() {
    super('Connected-service quota persistence deferred because account encryption mode is unknown');
    this.name = 'UnknownAccountModeQuotaPersistenceError';
  }
}

class DaemonServerWorkQuotaPersistenceError extends Error {
  public readonly outcome: DaemonServerWorkOutcome;
  public readonly retryAfterMs?: number;

  public constructor(outcome: DaemonServerWorkOutcome) {
    super(`Connected-service quota persistence did not write: ${outcome.status}`);
    this.name = 'DaemonServerWorkQuotaPersistenceError';
    this.outcome = outcome;
    if (outcome.status === 'failed' && typeof outcome.classification.retryAfterMs === 'number') {
      this.retryAfterMs = outcome.classification.retryAfterMs;
    } else if (outcome.status === 'deferred' && typeof outcome.retryAfterMs === 'number') {
      this.retryAfterMs = outcome.retryAfterMs;
    }
  }
}

export class ConnectedServiceQuotasCoordinator {
  private readonly api: QuotaApi;
  private readonly credentials: Credentials;
  private readonly quotaFetchersByServiceId: Map<ConnectedServiceId, ConnectedServiceQuotaFetcher>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly fetchTimeoutMs: number;
  private readonly failureBackoffMinMs: number;
  private readonly failureBackoffMaxMs: number;
  private readonly failureBackoffJitterPct: number;
  private readonly discoveryEnabled: boolean;
  private readonly discoveryIntervalMs: number;
  private readonly runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  private readonly refreshConnectedServiceCredentialForQuota: RefreshConnectedServiceCredentialForQuota | null;
  private readonly credentialRefreshWindowMs: number;
  private readonly machineIdProvider: (() => string | null | undefined) | null;
  private readonly ownerIdProvider: (() => string | null | undefined) | null;
  private readonly quotaFetchLeaseMs: number;
  private readonly quotaFetchLeaseContentionWaitMaxMs: number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly quotaPersistenceScheduler: ConnectedServiceQuotaPersistenceScheduler<string, InBandQuotaPersistencePayload>;
  private readonly quotaPersistenceServerWorkScheduler: DaemonServerWorkScheduler | null;
  private readonly quotaPersistenceServerScope: string;
  private quotaPersistenceAccountScope: QuotaPersistenceAccountScope;
  private readonly quotaPersistenceAccountScopeCanRefresh: boolean;
  private readonly quotaPersistenceMinFreshnessRefreshMs: number;
  private readonly quotaFingerprintKeyMaterial: Uint8Array;
  private quotaFingerprintHmacKey: Uint8Array;
  private readonly authGroupSwitchCoordinator: AuthGroupSwitchCoordinator | null;
  private readonly softSwitchPolicyGuard: ConnectedServiceQuotaSoftSwitchPolicyGuard | null;
  private readonly softSwitchRecoveryGuard: ConnectedServiceQuotaSoftSwitchRecoveryGuard | null;
  private readonly sameAccountFanoutStrategyResolver: ConnectedServiceSameAccountFanoutStrategyResolver | null;
  private readonly groupSwitchCheckMinIntervalMs: number;
  private readonly groupSwitchCheckJitterMs: number;
  private readonly quotaWorkGate: DaemonServerWorkGate | null;
  private readonly recordDiagnostic: ((event: ConnectedServiceQuotaCoordinatorDiagnostic) => void) | null;
  private readonly onQuotaLifecycleTransition: ConnectedServiceQuotaLifecycleListener | null;
  private readonly quotaLifecycleFreshnessMs: number;
  private readonly sameAccountFanoutMinIntervalMs: number;
  private readonly spawnTargetsByPid = new Map<number, SpawnTarget>();
  private readonly failureStateByBindingKey = new Map<string, FailureState>();
  private readonly groupSwitchCheckAtByKey = new Map<string, number>();
  private readonly sameAccountFanoutAtByKey = new Map<string, number>();
  private readonly persistedInBandQuotaStateByKey = new Map<string, PersistedInBandQuotaState>();
  private readonly notifiedQuotaBlockedGroupKeys = new Set<string>();
  private readonly runtimeAccountIdentities: RuntimeAccountIdentityIndex;
  private lastDiscoveryAt = 0;

  public constructor(params: Readonly<{
    api: QuotaApi;
    credentials: Credentials;
    quotaFetchers: ReadonlyArray<ConnectedServiceQuotaFetcher>;
    now: () => number;
    randomBytes: (length: number) => Uint8Array;
    fetchTimeoutMs?: number;
    failureBackoffMinMs?: number;
    failureBackoffMaxMs?: number;
    failureBackoffJitterPct?: number;
    discoveryEnabled?: boolean;
    discoveryIntervalMs?: number;
    runtimeQuotaSnapshots?: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
    refreshConnectedServiceCredentialForQuota?: RefreshConnectedServiceCredentialForQuota;
    credentialRefreshWindowMs?: number;
    machineIdProvider?: () => string | null | undefined;
    ownerIdProvider?: () => string | null | undefined;
    quotaFetchLeaseMs?: number;
    quotaFetchLeaseContentionWaitMaxMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    quotaPersistenceServerWorkScheduler?: DaemonServerWorkScheduler | null;
    quotaPersistenceServerScope?: string;
    quotaPersistenceAccountScope?: QuotaPersistenceAccountScope;
    quotaPersistenceIsConnected?: () => boolean;
    quotaPersistenceMaxConcurrent?: number;
    quotaPersistenceMinIntervalMs?: number;
    quotaPersistenceMaxKeys?: number;
    quotaPersistenceMaxKeyAgeMs?: number;
    quotaPersistenceMaxPendingPayloadAgeMs?: number;
    quotaPersistenceBackoffBaseMs?: number;
    quotaPersistenceBackoffMaxMs?: number;
    quotaPersistenceBackoffJitterRatio?: number;
    quotaPersistenceMinFreshnessRefreshMs?: number;
    quotaPersistenceMaxConsecutiveFailures?: number;
    authGroupSwitchCoordinator?: AuthGroupSwitchCoordinator | null;
    softSwitchPolicyGuard?: ConnectedServiceQuotaSoftSwitchPolicyGuard | null;
    softSwitchRecoveryGuard?: ConnectedServiceQuotaSoftSwitchRecoveryGuard | null;
    sameAccountFanoutStrategyResolver?: ConnectedServiceSameAccountFanoutStrategyResolver | null;
    groupSwitchCheckMinIntervalMs?: number;
    groupSwitchCheckJitterMs?: number;
    quotaWorkGate?: DaemonServerWorkGate | null;
    recordDiagnostic?: (event: ConnectedServiceQuotaCoordinatorDiagnostic) => void;
    onQuotaLifecycleTransition?: ConnectedServiceQuotaLifecycleListener | null;
    quotaLifecycleFreshnessMs?: number;
    runtimeAccountIdentityTtlMs?: number;
    sameAccountFanoutMinIntervalMs?: number;
  }>) {
    this.api = params.api;
    this.credentials = params.credentials;
    this.now = params.now;
    this.randomBytes = params.randomBytes;
    this.quotaFetchersByServiceId = new Map(params.quotaFetchers.map((f) => [f.serviceId, f]));
    this.fetchTimeoutMs =
      typeof params.fetchTimeoutMs === 'number' && Number.isFinite(params.fetchTimeoutMs)
        ? Math.max(1, Math.trunc(params.fetchTimeoutMs))
        : 15_000;
    this.failureBackoffMinMs =
      typeof params.failureBackoffMinMs === 'number' && Number.isFinite(params.failureBackoffMinMs)
        ? Math.max(1, Math.trunc(params.failureBackoffMinMs))
        : 30_000;
    this.failureBackoffMaxMs =
      typeof params.failureBackoffMaxMs === 'number' && Number.isFinite(params.failureBackoffMaxMs)
        ? Math.max(this.failureBackoffMinMs, Math.trunc(params.failureBackoffMaxMs))
        : 10 * 60_000;
    this.failureBackoffJitterPct =
      typeof params.failureBackoffJitterPct === 'number' && Number.isFinite(params.failureBackoffJitterPct)
        ? Math.min(1, Math.max(0, params.failureBackoffJitterPct))
        : 0.2;
    this.discoveryEnabled = typeof params.discoveryEnabled === 'boolean' ? params.discoveryEnabled : true;
    this.discoveryIntervalMs =
      typeof params.discoveryIntervalMs === 'number' && Number.isFinite(params.discoveryIntervalMs)
        ? Math.max(1, Math.trunc(params.discoveryIntervalMs))
        : 60_000;
    this.runtimeQuotaSnapshots = params.runtimeQuotaSnapshots ?? null;
    this.refreshConnectedServiceCredentialForQuota = params.refreshConnectedServiceCredentialForQuota ?? null;
    this.credentialRefreshWindowMs =
      typeof params.credentialRefreshWindowMs === 'number' && Number.isFinite(params.credentialRefreshWindowMs)
        ? Math.max(0, Math.trunc(params.credentialRefreshWindowMs))
        : 60_000;
    this.machineIdProvider = typeof params.machineIdProvider === 'function' ? params.machineIdProvider : null;
    this.ownerIdProvider = typeof params.ownerIdProvider === 'function' ? params.ownerIdProvider : null;
    this.quotaFetchLeaseMs =
      typeof params.quotaFetchLeaseMs === 'number' && Number.isFinite(params.quotaFetchLeaseMs)
        ? Math.max(1, Math.trunc(params.quotaFetchLeaseMs))
        : 30_000;
    this.quotaFetchLeaseContentionWaitMaxMs =
      typeof params.quotaFetchLeaseContentionWaitMaxMs === 'number' && Number.isFinite(params.quotaFetchLeaseContentionWaitMaxMs)
        ? Math.max(0, Math.trunc(params.quotaFetchLeaseContentionWaitMaxMs))
        : 5_000;
    this.sleepMs = params.sleepMs ?? defaultSleepMs;
    this.authGroupSwitchCoordinator = params.authGroupSwitchCoordinator ?? null;
    this.softSwitchPolicyGuard = params.softSwitchPolicyGuard ?? null;
    this.softSwitchRecoveryGuard = params.softSwitchRecoveryGuard ?? null;
    this.sameAccountFanoutStrategyResolver = params.sameAccountFanoutStrategyResolver ?? null;
    this.groupSwitchCheckMinIntervalMs =
      typeof params.groupSwitchCheckMinIntervalMs === 'number' && Number.isFinite(params.groupSwitchCheckMinIntervalMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckMinIntervalMs))
        : 60_000;
    this.groupSwitchCheckJitterMs =
      typeof params.groupSwitchCheckJitterMs === 'number' && Number.isFinite(params.groupSwitchCheckJitterMs)
        ? Math.max(0, Math.trunc(params.groupSwitchCheckJitterMs))
        : 0;
    this.quotaWorkGate = params.quotaWorkGate ?? null;
    this.recordDiagnostic = params.recordDiagnostic ?? null;
    this.onQuotaLifecycleTransition = params.onQuotaLifecycleTransition ?? null;
    this.quotaLifecycleFreshnessMs =
      typeof params.quotaLifecycleFreshnessMs === 'number' && Number.isFinite(params.quotaLifecycleFreshnessMs)
        ? Math.max(0, Math.trunc(params.quotaLifecycleFreshnessMs))
        : 5 * 60_000;
    this.sameAccountFanoutMinIntervalMs =
      typeof params.sameAccountFanoutMinIntervalMs === 'number' && Number.isFinite(params.sameAccountFanoutMinIntervalMs)
        ? Math.max(0, Math.trunc(params.sameAccountFanoutMinIntervalMs))
        : 60_000;
    this.runtimeAccountIdentities = new RuntimeAccountIdentityIndex({
      nowMs: params.now,
      ttlMs: params.runtimeAccountIdentityTtlMs,
    });
    this.quotaPersistenceServerWorkScheduler = params.quotaPersistenceServerWorkScheduler ?? null;
    this.quotaPersistenceServerScope = params.quotaPersistenceServerScope?.trim() || 'current-server';
    this.quotaPersistenceAccountScopeCanRefresh = params.quotaPersistenceAccountScope === undefined;
    this.quotaPersistenceAccountScope =
      params.quotaPersistenceAccountScope ?? resolveQuotaPersistenceAccountScope(params.credentials);
    this.quotaPersistenceMinFreshnessRefreshMs =
      typeof params.quotaPersistenceMinFreshnessRefreshMs === 'number' && Number.isFinite(params.quotaPersistenceMinFreshnessRefreshMs)
        ? Math.max(0, Math.trunc(params.quotaPersistenceMinFreshnessRefreshMs))
        : DEFAULT_QUOTA_PERSISTENCE_MIN_FRESHNESS_REFRESH_MS;
    const quotaPersistenceMinIntervalMs =
      typeof params.quotaPersistenceMinIntervalMs === 'number' && Number.isFinite(params.quotaPersistenceMinIntervalMs)
        ? Math.max(0, Math.trunc(params.quotaPersistenceMinIntervalMs))
        : 5_000;
    const quotaPersistenceBackoff = createKeyedBackoffTracker({
      baseDelayMs:
        typeof params.quotaPersistenceBackoffBaseMs === 'number' && Number.isFinite(params.quotaPersistenceBackoffBaseMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceBackoffBaseMs))
          : 1_000,
      maxDelayMs:
        typeof params.quotaPersistenceBackoffMaxMs === 'number' && Number.isFinite(params.quotaPersistenceBackoffMaxMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceBackoffMaxMs))
          : 60_000,
      jitterRatio:
        typeof params.quotaPersistenceBackoffJitterRatio === 'number' && Number.isFinite(params.quotaPersistenceBackoffJitterRatio)
          ? Math.min(1, Math.max(0, params.quotaPersistenceBackoffJitterRatio))
          : 0.2,
      now: params.now,
    });
    const fingerprintKeyMaterial = params.credentials.encryption.type === 'legacy'
      ? params.credentials.encryption.secret
      : params.credentials.encryption.machineKey;
    this.quotaFingerprintKeyMaterial = fingerprintKeyMaterial;
    this.quotaFingerprintHmacKey = this.deriveQuotaFingerprintHmacKey();
    this.quotaPersistenceScheduler = createConnectedServiceQuotaPersistenceScheduler({
      run: async (_key, payload) => {
        await this.flushInBandQuotaPersistencePayload(payload);
      },
      maxConcurrent:
        typeof params.quotaPersistenceMaxConcurrent === 'number' && Number.isFinite(params.quotaPersistenceMaxConcurrent)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxConcurrent))
          : 1,
      minKeyIntervalMs: quotaPersistenceMinIntervalMs,
      maxKeys:
        typeof params.quotaPersistenceMaxKeys === 'number' && Number.isFinite(params.quotaPersistenceMaxKeys)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxKeys))
          : 256,
      maxKeyAgeMs:
        typeof params.quotaPersistenceMaxKeyAgeMs === 'number' && Number.isFinite(params.quotaPersistenceMaxKeyAgeMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxKeyAgeMs))
          : 60 * 60_000,
      maxPendingPayloadAgeMs:
        typeof params.quotaPersistenceMaxPendingPayloadAgeMs === 'number' && Number.isFinite(params.quotaPersistenceMaxPendingPayloadAgeMs)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxPendingPayloadAgeMs))
          : 5 * 60_000,
      maxConsecutiveFailures:
        typeof params.quotaPersistenceMaxConsecutiveFailures === 'number' && Number.isFinite(params.quotaPersistenceMaxConsecutiveFailures)
          ? Math.max(1, Math.trunc(params.quotaPersistenceMaxConsecutiveFailures))
          : 5,
      now: params.now,
      isConnected: params.quotaPersistenceIsConnected,
      backoff: quotaPersistenceBackoff,
      shouldRetry: (error) => this.shouldRetryQuotaPersistence(error),
      shouldPauseAfterFailure: (error) => {
        if (error instanceof UnknownAccountModeQuotaPersistenceError) return false;
        if (error instanceof DaemonServerWorkQuotaPersistenceError && error.outcome.status === 'deferred') return false;
        if (
          error instanceof DaemonServerWorkQuotaPersistenceError
          && error.outcome.status === 'failed'
          && error.outcome.classification.kind === 'dependency_unavailable'
        ) {
          return false;
        }
        return true;
      },
      onEvent: (event) => {
        if (event.type !== 'coalesced' && event.type !== 'suppressed' && event.type !== 'deferred') return;
        this.quotaPersistenceServerWorkScheduler?.recordEvent({
          purpose: 'connectedServiceQuotaPersistence',
          key: event.key,
          type: event.type,
        });
      },
    });
  }

  public registerSpawnTarget(params: Readonly<{
    pid: number;
    sessionId?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsV1Like;
    connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    if (sessionId) {
      this.runtimeAccountIdentities.invalidateSession(sessionId);
    }
    this.spawnTargetsByPid.set(pid, {
      pid,
      ...(sessionId ? { sessionId } : {}),
      bindings: params.connectedServicesBindingsRaw ?? {},
      ...(params.connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv: { ...params.connectedServiceSelectionsEnv } } : {}),
    });
  }

  public updateSpawnTargetSessionId(params: Readonly<{
    pid: number;
    sessionId?: string;
  }>): void {
    const pid = Math.trunc(Number(params.pid));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const target = this.spawnTargetsByPid.get(pid);
    if (!target) return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    if (!sessionId) return;
    if (target.sessionId === sessionId) return;
    if (target.sessionId) {
      this.runtimeAccountIdentities.invalidateSession(target.sessionId);
    }
    this.runtimeAccountIdentities.invalidateSession(sessionId);
    this.spawnTargetsByPid.set(pid, {
      ...target,
      sessionId,
    });
  }

  public unregisterPid(pidRaw: number): void {
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 0) return;
    const target = this.spawnTargetsByPid.get(pid);
    if (target?.sessionId) {
      this.runtimeAccountIdentities.invalidateSession(target.sessionId);
    }
    this.spawnTargetsByPid.delete(pid);
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): void {
    const fromPid = Math.trunc(Number(fromPidRaw));
    const toPid = Math.trunc(Number(toPidRaw));
    if (!Number.isFinite(fromPid) || fromPid <= 0 || !Number.isFinite(toPid) || toPid <= 0) return;
    const target = this.spawnTargetsByPid.get(fromPid);
    if (!target) return;
    if (target.sessionId) {
      this.runtimeAccountIdentities.invalidateSession(target.sessionId);
    }
    this.spawnTargetsByPid.delete(fromPid);
    this.spawnTargetsByPid.set(toPid, {
      ...target,
      pid: toPid,
    });
  }

  private makeBindingKey(params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>): string {
    return `${params.serviceId}\u0000${params.profileId}`;
  }

  private computeJitteredBackoffMs(baseMs: number): number {
    const jitterPct = this.failureBackoffJitterPct;
    if (jitterPct <= 0) return Math.max(1, Math.trunc(baseMs));
    const bytes = this.randomBytes(4);
    const u32 =
      ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0);
    const normalized = (u32 >>> 0) / 0xffffffff;
    const factor = (1 - jitterPct) + normalized * (2 * jitterPct);
    return Math.max(1, Math.trunc(baseMs * factor));
  }

  private applyFailureBackoff(params: Readonly<{
    now: number;
    key: string;
    retryAfterMs?: number | null;
    retryAfterBackoffMinMs?: number | null;
  }>): void {
    const existing = this.failureStateByBindingKey.get(params.key);
    const consecutiveFailures = Math.min((existing?.consecutiveFailures ?? 0) + 1, 30);
    const retryAfterMs = readFiniteNonNegativeMs(params.retryAfterMs);
    if (retryAfterMs !== null) {
      const floorMs = readFiniteNonNegativeMs(params.retryAfterBackoffMinMs) ?? 0;
      this.failureStateByBindingKey.set(params.key, {
        consecutiveFailures,
        nextAllowedAt: params.now + Math.max(retryAfterMs, floorMs, 1),
      });
      return;
    }
    const expMs = this.failureBackoffMinMs * Math.pow(2, consecutiveFailures - 1);
    const cappedMs = Math.min(expMs, this.failureBackoffMaxMs);
    const jitteredMs = this.computeJitteredBackoffMs(cappedMs);
    this.failureStateByBindingKey.set(params.key, {
      consecutiveFailures,
      nextAllowedAt: params.now + jitteredMs,
    });
  }

  public async recordInBandQuotaSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): Promise<ConnectedServiceInBandQuotaSnapshotRecordResult> {
    if (input.snapshot.serviceId !== input.serviceId) {
      return { status: 'suppressed', reason: 'service_id_mismatch' };
    }

    const key = this.buildQuotaPersistenceKey(input).key;
    const status = deriveQuotaSnapshotStatus(input.snapshot);
    const materialFingerprint = this.computeQuotaMaterialFingerprint(input.snapshot);
    const previous = this.persistedInBandQuotaStateByKey.get(key) ?? null;
    const materiality = shouldPersistQuotaSnapshot({
      previous,
      incoming: { snapshot: input.snapshot, fingerprint: materialFingerprint, status },
      minFreshnessRefreshMs: this.quotaPersistenceMinFreshnessRefreshMs,
    });
    if (!materiality.persist) return { status: 'suppressed', reason: materiality.reason };

    const enqueue = this.quotaPersistenceScheduler.enqueue(key, {
      serviceId: input.serviceId,
      profileId: input.profileId,
      snapshot: input.snapshot,
      materialFingerprint,
      status,
    });
    if (enqueue.type === 'suppressed') return { status: 'suppressed', reason: enqueue.reason };
    return { status: 'enqueued', enqueue: enqueue.type };
  }

  public async flushInBandQuotaPersistence(timeoutMs: number): Promise<ConnectedServiceQuotaPersistenceFlushResult> {
    const inProcess = await this.quotaPersistenceScheduler.flushAll(timeoutMs);
    const serverWork = this.quotaPersistenceServerWorkScheduler
      ? await this.quotaPersistenceServerWorkScheduler.flushAll(timeoutMs)
      : null;
    return {
      timedOut: inProcess.timedOut || serverWork?.timedOut === true,
      inProcess,
      serverWork,
    };
  }

  public notifyQuotaPersistenceConnectivityChanged(): void {
    this.quotaPersistenceScheduler.notifyConnectivityChanged();
  }

  public dispose(): void {
    this.quotaPersistenceScheduler.dispose();
    this.runtimeAccountIdentities.clear();
    this.sameAccountFanoutAtByKey.clear();
  }

  public recordRuntimeAccountIdentityFromSnapshot(
    input: RuntimeAccountIdentityRecordInput,
  ): RuntimeAccountIdentityRecordResult {
    return this.runtimeAccountIdentities.record(input);
  }

  public async recordAccountExhaustionAndFanout(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    exhaustedProfileId: string;
    providerAccountId: string;
    resetAtMs: number | null;
    reason: 'usage_limit';
  }>): Promise<Readonly<{
    status: 'recorded';
    fanoutCandidates: number;
    fanoutRequests: number;
  }>> {
    void input.reason;
    const authGroupSwitchCoordinator = this.authGroupSwitchCoordinator;
    if (!authGroupSwitchCoordinator) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const fanoutStrategy = await this.resolveSameAccountFanoutStrategy({
      sourceSessionId: input.sourceSessionId,
      serviceId: input.serviceId,
      groupId: input.groupId,
    });
    if (!requiresExactProviderAccountFanout(fanoutStrategy)) {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'same_account_fanout_strategy_not_exact_provider_account',
      });
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    const currentGroupGenerationBySessionId = this.buildCurrentGroupGenerationBySessionId({
      serviceId: input.serviceId,
      groupId: input.groupId,
    });
    const candidates = resolveSessionsSharingProviderAccount(this.runtimeAccountIdentities, {
      serviceId: input.serviceId,
      groupId: input.groupId,
      providerAccountId: input.providerAccountId,
      excludeSessionId: input.sourceSessionId,
      currentGroupGenerationBySessionId,
    }).filter((entry) => this.hasActiveSpawnTargetForIdentity(entry));
    if (candidates.length === 0) {
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }
    if (this.isSameAccountFanoutCoalesced(input)) {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'same_account_fanout',
        reason: 'same_provider_account_exhaustion_coalesced',
      });
      return { status: 'recorded', fanoutCandidates: 0, fanoutRequests: 0 };
    }

    let fanoutRequests = 0;
    for (const candidate of candidates) {
      this.runtimeAccountIdentities.invalidateSession(candidate.sessionId);
      await authGroupSwitchCoordinator.switchBeforeTurn({
        sessionId: candidate.sessionId,
        serviceId: candidate.serviceId,
        groupId: candidate.groupId ?? input.groupId,
        reason: 'same_provider_account_exhausted',
        observedProfileId: candidate.profileId,
      }).then(() => {
        fanoutRequests += 1;
      }).catch(() => {
        // Best-effort sibling protection. The sibling's own runtime failure remains authoritative.
      });
    }
    return {
      status: 'recorded',
      fanoutCandidates: candidates.length,
      fanoutRequests,
    };
  }

  public resolveQuotaProbeFreshProof(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string | null;
    expectedGroupGeneration: number | null;
    currentGroupGeneration: number | null;
    expectedMaterialFingerprint: string | null;
    snapshotMaterialFingerprint: string | null;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    maxAgeMs?: number;
  }>): QuotaProbeFreshProofResult {
    return resolveQuotaProbeFreshProof({
      nowMs: this.now(),
      maxAgeMs: input.maxAgeMs ?? this.quotaLifecycleFreshnessMs,
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      expectedGroupGeneration: input.expectedGroupGeneration,
      currentGroupGeneration: input.currentGroupGeneration,
      expectedMaterialFingerprint: input.expectedMaterialFingerprint,
      snapshotMaterialFingerprint: input.snapshotMaterialFingerprint,
      snapshot: input.snapshot,
    });
  }

  public computeQuotaSnapshotMaterialFingerprint(snapshot: ConnectedServiceQuotaSnapshotV1): string {
    return this.computeQuotaMaterialFingerprint(snapshot);
  }

  private async resolveSameAccountFanoutStrategy(input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceSameAccountFanoutStrategy> {
    if (!this.sameAccountFanoutStrategyResolver) return 'none';
    try {
      return await this.sameAccountFanoutStrategyResolver(input);
    } catch {
      return 'none';
    }
  }

  private isSameAccountFanoutCoalesced(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
    resetAtMs: number | null;
  }>): boolean {
    const minIntervalMs = this.sameAccountFanoutMinIntervalMs;
    if (minIntervalMs <= 0) return false;
    const key = this.buildSameAccountFanoutCoalescingKey(input);
    const now = this.now();
    const lastAt = this.sameAccountFanoutAtByKey.get(key);
    if (lastAt !== undefined && now - lastAt < minIntervalMs) {
      return true;
    }
    this.sameAccountFanoutAtByKey.set(key, now);
    return false;
  }

  private buildSameAccountFanoutCoalescingKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
    resetAtMs: number | null;
  }>): string {
    const groupId = input.groupId.trim();
    const providerAccountId = input.providerAccountId.trim();
    const resetBucket = typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)
      ? Math.floor(Math.max(0, input.resetAtMs) / SAME_ACCOUNT_FANOUT_RESET_BUCKET_MS)
      : 'unknown';
    return `${input.serviceId}\u0000${groupId}\u0000${providerAccountId}\u0000${resetBucket}`;
  }

  private buildCurrentGroupGenerationBySessionId(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Map<string, number | null> {
    const generations = new Map<string, number | null>();
    for (const target of this.spawnTargetsByPid.values()) {
      if (!target.sessionId) continue;
      const selection = readConnectedServiceChildSelectionsFromEnv(target.connectedServiceSelectionsEnv ?? {})
        .find((candidate) => (
          candidate.kind === 'group'
          && candidate.serviceId === input.serviceId
          && candidate.groupId === input.groupId
        )) ?? null;
      generations.set(target.sessionId, selection?.kind === 'group' ? selection.generation : null);
    }
    return generations;
  }

  private hasActiveSpawnTargetForIdentity(entry: RuntimeAccountIdentityEntry): boolean {
    for (const target of this.spawnTargetsByPid.values()) {
      if (target.sessionId !== entry.sessionId) continue;
      const bindings = extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv);
      return bindings.some((binding) => (
        binding.serviceId === entry.serviceId
        && binding.profileId === entry.profileId
        && (entry.groupId === null || binding.groupId === entry.groupId)
      ));
    }
    return false;
  }

  private buildQuotaPersistenceKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Readonly<{ key: string; diagnostics: Record<string, string> }> {
    this.refreshQuotaPersistenceAccountScope();
    return buildQuotaPersistenceKey({
      serverScope: this.quotaPersistenceServerScope,
      accountScope: this.quotaPersistenceAccountScope,
      serviceId: input.serviceId,
      profileId: input.profileId,
    });
  }

  private deriveQuotaFingerprintHmacKey(): Uint8Array {
    return deriveQuotaSnapshotFingerprintHmacKey({
      keyMaterial: this.quotaFingerprintKeyMaterial,
      serverScope: this.quotaPersistenceServerScope,
      accountScope: this.quotaPersistenceAccountScope.kind === 'known'
        ? this.quotaPersistenceAccountScope.value
        : 'unknown-account',
    });
  }

  private refreshQuotaPersistenceAccountScope(): void {
    if (!this.quotaPersistenceAccountScopeCanRefresh) return;
    const nextScope = resolveQuotaPersistenceAccountScope(this.credentials);
    if (nextScope.kind !== 'known') return;
    if (
      this.quotaPersistenceAccountScope.kind === 'known'
      && this.quotaPersistenceAccountScope.value === nextScope.value
    ) {
      return;
    }
    this.quotaPersistenceAccountScope = nextScope;
    this.quotaFingerprintHmacKey = this.deriveQuotaFingerprintHmacKey();
  }

  private computeQuotaMaterialFingerprint(snapshot: ConnectedServiceQuotaSnapshotV1): string {
    this.refreshQuotaPersistenceAccountScope();
    return computeQuotaSnapshotFingerprint(snapshot, this.quotaFingerprintHmacKey);
  }

  private shouldRetryQuotaPersistence(error: unknown): boolean {
    if (error instanceof UnknownAccountModeQuotaPersistenceError) return false;
    if (error instanceof DaemonServerWorkQuotaPersistenceError) {
      if (error.outcome.status === 'deferred') return true;
      if (error.outcome.status !== 'failed') return false;
      return error.outcome.classification.retryable;
    }
    return classifyDaemonServerWorkError(error).retryable;
  }

  private async flushInBandQuotaPersistencePayload(payload: InBandQuotaPersistencePayload): Promise<void> {
    await this.persistQuotaSnapshotWithServerWork({
      serviceId: payload.serviceId,
      profileId: payload.profileId,
      snapshot: payload.snapshot,
      materialFingerprint: payload.materialFingerprint,
    });

    this.persistedInBandQuotaStateByKey.set(this.buildQuotaPersistenceKey(payload).key, {
      snapshot: payload.snapshot,
      fingerprint: payload.materialFingerprint,
      status: payload.status,
      fetchedAt: payload.snapshot.fetchedAt,
    });
  }

  private async persistQuotaSnapshotWithServerWork(input: Readonly<{
    accountMode?: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    materialFingerprint?: string;
  }>): Promise<void> {
    const run = async (payload: typeof input): Promise<void> => {
      const accountMode = payload.accountMode ?? await resolveConnectedServiceAccountMode(this.api, { refresh: true });
      if (accountMode === 'unknown') {
        invalidateConnectedServiceAccountMode(this.api);
        throw new UnknownAccountModeQuotaPersistenceError();
      }
      await this.persistQuotaSnapshot({
        ...payload,
        accountMode,
      });
    };

    if (this.quotaPersistenceServerWorkScheduler) {
      const outcome = await this.quotaPersistenceServerWorkScheduler.enqueue({
        purpose: 'connectedServiceQuotaPersistence',
        kind: 'latestStateWrite',
        key: this.buildQuotaPersistenceKey(input).key,
        payload: input,
        payloadBytes: JSON.stringify(input.snapshot).length,
        run,
      });
      if (outcome.status !== 'written') throw new DaemonServerWorkQuotaPersistenceError(outcome);
      return;
    }

    await run(input);
  }

  private async persistQuotaSnapshot(input: Readonly<{
    accountMode: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    materialFingerprint?: string;
  }>): Promise<void> {
    const status = deriveQuotaSnapshotStatus(input.snapshot);
    if (input.accountMode === 'plain' && typeof this.api.registerConnectedServiceQuotaSnapshotPlain === 'function') {
      await this.api.registerConnectedServiceQuotaSnapshotPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
        content: { t: 'plain', v: input.snapshot },
        metadata: {
          fetchedAt: input.snapshot.fetchedAt,
          staleAfterMs: input.snapshot.staleAfterMs,
          status,
          ...(input.materialFingerprint ? { materialFingerprint: input.materialFingerprint } : {}),
        },
      });
      return;
    }

    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
    const sealed = sealConnectedServiceQuotaSnapshotCiphertext({
      material,
      payload: input.snapshot,
      randomBytes: this.randomBytes,
    });
    await this.api.registerConnectedServiceQuotaSnapshotSealed({
      serviceId: input.serviceId,
      profileId: input.profileId,
      sealed: { format: 'account_scoped_v1', ciphertext: sealed },
      metadata: {
        fetchedAt: input.snapshot.fetchedAt,
        staleAfterMs: input.snapshot.staleAfterMs,
        status,
        ...(input.materialFingerprint ? { materialFingerprint: input.materialFingerprint } : {}),
      },
    });
  }

  private recordPersistedInBandQuotaStateFromExisting(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    existing: ExistingQuotaSnapshotResponse;
  }>): void {
    const metadata = input.existing?.metadata;
    const status = metadata?.status ?? deriveQuotaSnapshotStatus(input.snapshot);
    const fetchedAt = readFiniteNonNegativeMs(metadata?.fetchedAt) ?? input.snapshot.fetchedAt;
    const materialFingerprint = typeof metadata?.materialFingerprint === 'string' && metadata.materialFingerprint.trim()
      ? metadata.materialFingerprint
      : this.computeQuotaMaterialFingerprint(input.snapshot);
    const refreshRequestedAt = readFiniteNonNegativeMs(metadata?.refreshRequestedAt);
    this.persistedInBandQuotaStateByKey.set(this.buildQuotaPersistenceKey(input).key, {
      snapshot: input.snapshot,
      fingerprint: materialFingerprint,
      status,
      fetchedAt,
      ...(refreshRequestedAt === null ? {} : { refreshRequestedAt }),
    });
  }

  private recordRuntimeProfileSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>): void {
    this.runtimeQuotaSnapshots?.recordProfileSnapshot(input);
  }

  private async maybeClearStaleMemberLimitersForGroupQuotaSnapshot(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    now: number;
  }>): Promise<void> {
    if (!this.runtimeQuotaSnapshots) return;
    if (typeof this.api.getConnectedServiceAuthGroup !== 'function') return;

    const group = await this.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(() => null);
    if (!group) return;

    const reconciledGroup = await this.clearStaleMemberLimitersWithFreshEvidence({ group, ...input });
    await this.evaluateGroupQuotaLifecycle({
      group: reconciledGroup ?? group,
      now: input.now,
    });
  }

  private async clearStaleMemberLimitersWithFreshEvidence(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    now: number;
  }>): Promise<ConnectedServiceAuthGroupV1 | null> {
    if (!this.runtimeQuotaSnapshots) return null;
    if (typeof this.api.updateConnectedServiceAuthGroupRuntimeState !== 'function') return null;

    const member = input.group.members.find((candidate) => candidate.profileId === input.profileId) ?? null;
    if (!member) return null;
    const runtimeState = this.runtimeQuotaSnapshots.buildMemberStates({
      serviceId: input.serviceId,
      groupId: input.groupId,
      capturedAtMs: input.now,
    }).get(input.profileId) ?? null;
    const quotaSnapshot = runtimeState?.quotaSnapshot ?? null;
    if (!quotaSnapshot) return null;

    const reconciledState = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      state: member.state as ConnectedServiceAuthGroupMemberRuntimeState,
      quotaSnapshot,
      policy: normalizeConnectedServiceAuthGroupPolicy(input.group.policy),
      nowMs: input.now,
    });
    if (!reconciledState || reconciledState === member.state) return null;

    return await this.api.updateConnectedServiceAuthGroupRuntimeState({
      serviceId: input.serviceId,
      groupId: input.groupId,
      expectedGeneration: input.group.generation,
      memberStates: [{
        profileId: input.profileId,
        state: reconciledState,
      }],
    }).catch(() => null);
  }

  private resolveActiveSessionIdsForGroup(serviceId: ConnectedServiceId, groupId: string): string[] {
    const sessionIds: string[] = [];
    for (const target of this.spawnTargetsByPid.values()) {
      const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
      if (!sessionId || sessionIds.includes(sessionId)) continue;
      for (const entry of extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv)) {
        if (entry.serviceId !== serviceId) continue;
        if ((entry.groupId ?? '') !== groupId) continue;
        sessionIds.push(sessionId);
        break;
      }
    }
    return sessionIds;
  }

  /**
   * RD-QUO-13: edge-triggered group quota lifecycle (blocked/recovered) producer hook.
   *
   * Runs the same eligibility pass the switch coordinator uses (`allowCurrentProfileRetry`
   * so the active member counts when eligible). `no_eligible_members` with live group-bound
   * sessions emits `blocked` once; a later pass that frees any member emits `recovered`
   * once. Manual-strategy groups are user-driven and never emit.
   */
  private async evaluateGroupQuotaLifecycle(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    now: number;
  }>): Promise<void> {
    const listener = this.onQuotaLifecycleTransition;
    if (!listener || !this.runtimeQuotaSnapshots) return;
    const switchState = buildConnectedServiceAuthGroupSwitchState({
      group: input.group,
      runtimeQuotaSnapshots: this.runtimeQuotaSnapshots,
      nowMs: input.now,
    });
    const selection = selectConnectedServiceAuthGroupCandidate({
      nowMs: input.now,
      quotaFreshnessMs: this.quotaLifecycleFreshnessMs,
      activeProfileId: switchState.activeProfileId,
      policy: switchState.policy,
      members: switchState.members,
      memberStatesByProfileId: switchState.memberStatesByProfileId,
      allowCurrentProfileRetry: true,
    });
    if (selection.reason === 'manual_strategy') return;

    const serviceId = input.group.serviceId;
    const groupId = input.group.groupId;
    const groupKey = `${serviceId}\u0000${groupId}`;
    const blocked = selection.reason === 'no_eligible_members';
    const previouslyNotified = this.notifiedQuotaBlockedGroupKeys.has(groupKey);
    if (blocked === previouslyNotified) return;

    const sessionIds = this.resolveActiveSessionIdsForGroup(serviceId, groupId);
    const issueFingerprint = `quota-blocked:${serviceId}:${groupId}`;
    if (blocked) {
      // No group-bound sessions: nothing to notify yet. Stay unmarked so a session
      // observing the still-blocked group later still gets the blocked edge.
      if (sessionIds.length === 0) return;
      const resetAtMs = selection.excluded
        .map((exclusion) => exclusion.retryAtMs)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > input.now)
        .sort((left, right) => left - right)[0] ?? null;
      this.notifiedQuotaBlockedGroupKeys.add(groupKey);
      try {
        await listener({
          phase: 'blocked',
          serviceId,
          groupId,
          activeProfileId: switchState.activeProfileId,
          sessionIds,
          issueFingerprint,
          resetAtMs,
          reason: 'connected_service_group_quota_exhausted',
        });
      } catch {
        // Notifications are best-effort; never fail the quota path.
      }
      return;
    }

    this.notifiedQuotaBlockedGroupKeys.delete(groupKey);
    try {
      await listener({
        phase: 'recovered',
        serviceId,
        groupId,
        activeProfileId: switchState.activeProfileId,
        sessionIds,
        issueFingerprint,
        resetAtMs: null,
        reason: 'fresh_quota_evidence',
      });
    } catch {
      // Notifications are best-effort; never fail the quota path.
    }
  }

  private makeGroupSwitchCheckKey(input: ActiveGroupQuotaSwitchTarget): string {
    return `${input.serviceId}\u0000${input.groupId}\u0000${input.activeProfileId}`;
  }

  private computeBoundedJitterMs(maxMs: number): number {
    const capped = Math.max(0, Math.trunc(maxMs));
    if (capped <= 0) return 0;
    const bytes = this.randomBytes(4);
    const u32 =
      ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0);
    const normalized = (u32 >>> 0) / 0xffffffff;
    return Math.trunc(normalized * capped);
  }

  private checkQuotaWorkGate(phase: QuotaWorkPhase): DaemonServerWorkGateResult {
    const result = this.quotaWorkGate?.() ?? { status: 'open' as const };
    if (result.status === 'open') return result;
    const reason = result.reason.trim() || result.status;
    this.recordDiagnostic?.({
      event: result.status === 'suppressed' ? 'quota_work_suppressed' : 'quota_work_deferred',
      phase,
      reason,
      ...('retryAfterMs' in result && typeof result.retryAfterMs === 'number'
        ? { retryAfterMs: Math.max(0, Math.trunc(result.retryAfterMs)) }
        : {}),
    });
    return result;
  }

  private async shouldRunSoftSwitchForTarget(target: ActiveGroupQuotaSwitchTarget): Promise<boolean> {
    const policyGuard = this.softSwitchPolicyGuard;
    if (policyGuard) {
      let policyResult: SoftSwitchPolicyGuardResult;
      try {
        policyResult = await policyGuard({
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          activeProfileId: target.activeProfileId,
          reason: 'soft_threshold',
        });
      } catch {
        this.recordDiagnostic?.({
          event: 'quota_work_suppressed',
          phase: 'soft_switch',
          reason: 'quota_soft_switch_policy_guard_failed',
        });
        return false;
      }
      if (policyResult.status !== 'allow') {
        this.recordDiagnostic?.({
          event: 'quota_work_suppressed',
          phase: 'soft_switch',
          reason: policyResult.reason.trim() || 'quota_soft_switch_suppressed_policy_guard',
        });
        return false;
      }
    }

    const guard = this.softSwitchRecoveryGuard;
    if (!guard) return true;
    let result: SoftSwitchRecoveryGuardResult;
    try {
      result = await guard({
        sessionId: target.sessionId,
        serviceId: target.serviceId,
        groupId: target.groupId,
        activeProfileId: target.activeProfileId,
        reason: 'soft_threshold',
      });
    } catch {
      this.recordDiagnostic?.({
        event: 'quota_work_suppressed',
        phase: 'soft_switch',
        reason: 'quota_soft_switch_recovery_guard_failed',
      });
      return false;
    }
    if (result.status === 'allow') return true;
    this.recordDiagnostic?.({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: result.reason.trim() || 'quota_soft_switch_suppressed_recovery_pending',
    });
    return false;
  }

  private async persistCredentialHealthForQuotaFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    error: unknown;
    now: number;
  }>): Promise<boolean> {
    if (!isQuotaAuthFailure(input.error)) return false;
    const updateHealth = this.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return false;
    await updateHealth.call(this.api, {
      serviceId: input.serviceId,
      profileId: input.profileId,
      health: buildQuotaAuthFailureCredentialHealth(input.error, input.now),
    });
    return true;
  }

  private async maybeRequestActiveGroupSwitchForSnapshot(input: Readonly<{
    now: number;
    targets: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | undefined;
  }>): Promise<void> {
    const authGroupSwitchCoordinator = this.authGroupSwitchCoordinator;
    if (!authGroupSwitchCoordinator || !input.targets || input.targets.length === 0) return;
    if (this.checkQuotaWorkGate('soft_switch').status !== 'open') return;
    const targetsByKey = new Map<string, ActiveGroupQuotaSwitchTarget[]>();
    for (const target of input.targets) {
      const key = this.makeGroupSwitchCheckKey(target);
      const existingTargets = targetsByKey.get(key);
      if (existingTargets) {
        existingTargets.push(target);
      } else {
        targetsByKey.set(key, [target]);
      }
    }
    for (const [key, targets] of targetsByKey.entries()) {
      const nextCheckAt = this.groupSwitchCheckAtByKey.get(key);
      if (typeof nextCheckAt === 'number' && input.now < nextCheckAt) {
        continue;
      }
      this.groupSwitchCheckAtByKey.set(
        key,
        input.now + this.groupSwitchCheckMinIntervalMs + this.computeBoundedJitterMs(this.groupSwitchCheckJitterMs),
      );
      const allowedTargets: ActiveGroupQuotaSwitchTarget[] = [];
      for (const target of targets) {
        if (await this.shouldRunSoftSwitchForTarget(target)) {
          allowedTargets.push(target);
        }
      }
      await Promise.all(allowedTargets.map((target) =>
        authGroupSwitchCoordinator.switchBeforeTurn({
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          reason: 'soft_threshold',
          observedProfileId: target.activeProfileId,
        }).catch(() => {
          // Best-effort only. Runtime failure recovery remains the authoritative fallback.
        }),
      ));
    }
  }

  public async hydratePersistedQuotaSnapshotsForGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>): Promise<void> {
    if (this.checkQuotaWorkGate('hydrate_group').status !== 'open') return;
    if (!this.runtimeQuotaSnapshots) return;
    const now = Math.max(0, Math.trunc(this.now()));
    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });

    for (const rawProfileId of input.profileIds) {
      const profileId = String(rawProfileId ?? '').trim();
      if (!profileId) continue;
      const existing = await this.readExistingQuotaSnapshot({
        accountMode,
        serviceId: input.serviceId,
        profileId,
      }).catch(() => null);
      if (!existing?.existing) continue;
      const snapshot = this.openExistingQuotaSnapshot({
        storageMode: existing.storageMode,
        material,
        existing: existing.existing,
      });
      if (!snapshot) continue;
      this.runtimeQuotaSnapshots.recordSnapshot({
        serviceId: input.serviceId,
        groupId: input.groupId,
        profileId,
        snapshot,
      });
      await this.maybeClearStaleMemberLimitersForGroupQuotaSnapshot({
        serviceId: input.serviceId,
        groupId: input.groupId,
        profileId,
        now,
      });
    }
  }

  public async probeGroupQuotaSnapshots(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
  }>): Promise<void> {
    if (this.checkQuotaWorkGate('probe_group').status !== 'open') return;
    if (!this.runtimeQuotaSnapshots) return;
    const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
    const groupId = String(input.groupId ?? '').trim();
    if (!groupId) return;
    const fetcher = this.quotaFetchersByServiceId.get(serviceId);
    if (!fetcher) return;
    const profileIds = Array.from(new Set(input.profileIds
      .map((profileId) => String(profileId ?? '').trim())
      .filter((profileId) => profileId.length > 0)));
    if (profileIds.length === 0) return;

    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });
    const now = Math.max(0, Math.trunc(this.now()));

    for (const profileId of profileIds) {
      try {
        const lease = await this.acquireQuotaFetchLease({ serviceId, profileId });
        if (lease.type === 'contended') {
          const observedSnapshot = await this.waitForContendedQuotaFetch({
            accountMode,
            material,
            serviceId,
            profileId,
            fetcher,
            now,
            leaseUntil: lease.leaseUntil,
          });
          if (observedSnapshot) {
            this.runtimeQuotaSnapshots.recordSnapshot({
              serviceId,
              groupId,
              profileId,
              snapshot: observedSnapshot,
            });
            await this.maybeClearStaleMemberLimitersForGroupQuotaSnapshot({
              serviceId,
              groupId,
              profileId,
              now,
            });
          }
          continue;
        }

        const credential = await this.readCredentialForQuota({
          accountMode,
          material,
          serviceId,
          profileId,
        });
        if (!credential.record) continue;
        const raced = await this.fetchQuotaSnapshotWithRefresh({
          fetcher,
          serviceId,
          profileId,
          record: credential.record,
          now,
        });
        if (raced.type === 'timeout') continue;
        const snapshot = raced.snapshot;
        if (!snapshot) continue;
        this.runtimeQuotaSnapshots.recordSnapshot({
          serviceId,
          groupId,
          profileId,
          snapshot,
        });
        await this.maybeClearStaleMemberLimitersForGroupQuotaSnapshot({
          serviceId,
          groupId,
          profileId,
          now,
        });
        // RD-QUO-3: probe-driven snapshots persist through the same materiality →
        // coalescing → serverWork → HMAC-fingerprint idempotency path as event-driven
        // snapshots. A direct no-fingerprint write would hit the server's legacy
        // unconditional upsert and bypass the daemon storm budget/backoff accounting.
        await this.recordInBandQuotaSnapshot({
          serviceId,
          profileId,
          snapshot,
        });
      } catch (error) {
        await this.persistCredentialHealthForQuotaFailure({
          serviceId,
          profileId,
          error,
          now,
        }).catch(() => false);
        const key = this.makeBindingKey({ serviceId, profileId });
        this.applyFailureBackoff({
          now,
          key,
          retryAfterMs: readQuotaRetryAfterMs(error),
          retryAfterBackoffMinMs: fetcher.pollPolicy?.retryAfterBackoffMinMs,
        });
      }
    }
  }

  private openExistingQuotaSnapshot(input: Readonly<{
    storageMode: ResolvedQuotaStorageMode;
    material: Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'];
    existing: ExistingQuotaSnapshotResponse;
  }>): ConnectedServiceQuotaSnapshotV1 | null {
    if (input.storageMode === 'plain') {
      const plain = input.existing as Awaited<ReturnType<NonNullable<QuotaApi['getConnectedServiceQuotaSnapshotPlain']>>>;
      return plain?.content?.t === 'plain' ? plain.content.v : null;
    }
    const sealed = input.existing as Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>;
    if (!sealed?.sealed?.ciphertext) return null;
    const opened = openConnectedServiceQuotaSnapshotCiphertext({
      material: input.material,
      ciphertext: sealed.sealed.ciphertext,
    });
    return (opened?.value as ConnectedServiceQuotaSnapshotV1 | null | undefined) ?? null;
  }

  private async readExistingQuotaSnapshot(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ResolvedExistingQuotaSnapshot> {
    if (input.accountMode !== 'e2ee' && typeof this.api.getConnectedServiceQuotaSnapshotPlain === 'function') {
      const plain = await this.api.getConnectedServiceQuotaSnapshotPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
      });
      if (plain) {
        return { storageMode: 'plain', existing: plain };
      }
      if (input.accountMode === 'plain') {
        return { storageMode: 'plain', existing: null };
      }
    }

    return {
      storageMode: 'e2ee',
      existing: await this.api.getConnectedServiceQuotaSnapshotSealed({
        serviceId: input.serviceId,
        profileId: input.profileId,
      }),
    };
  }

  private async readCredentialForQuota(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'];
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<Readonly<{
    storageMode: ResolvedQuotaStorageMode;
    record: ConnectedServiceCredentialRecordV1 | null;
  }>> {
    if (input.accountMode !== 'e2ee' && typeof this.api.getConnectedServiceCredentialPlain === 'function') {
      const plain = await this.api.getConnectedServiceCredentialPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
      }).catch(() => null);
      const record = plain?.content?.t === 'plain' ? plain.content.v : null;
      if (record) {
        return { storageMode: 'plain', record };
      }
      if (input.accountMode === 'plain') {
        return { storageMode: 'plain', record: null };
      }
    }

    const sealed = await this.api.getConnectedServiceCredentialSealed({
      serviceId: input.serviceId,
      profileId: input.profileId,
    });
    if (!sealed?.sealed?.ciphertext) {
      return { storageMode: 'e2ee', record: null };
    }
    const opened = openConnectedServiceCredentialCiphertext({
      material: input.material,
      ciphertext: sealed.sealed.ciphertext,
    });
    return {
      storageMode: 'e2ee',
      record: (opened?.value as ConnectedServiceCredentialRecordV1 | null | undefined) ?? null,
    };
  }

  private isExistingQuotaSnapshotFresh(input: Readonly<{
    existing: ExistingQuotaSnapshotResponse;
    now: number;
    fetcher: ConnectedServiceQuotaFetcher;
    forcedRefresh: boolean;
  }>): boolean {
    if (!input.existing?.metadata) return false;
    const fetchedAt = Number(input.existing.metadata.fetchedAt ?? 0);
    const staleAfterMs = Number(input.existing.metadata.staleAfterMs ?? 0);
    if (!Number.isFinite(fetchedAt) || !Number.isFinite(staleAfterMs) || fetchedAt <= 0 || staleAfterMs <= 0) return false;
    const policyMinPollIntervalMs = readFiniteNonNegativeMs(input.fetcher.pollPolicy?.minPollIntervalMs) ?? 0;
    const effectiveStaleAfterMs = Math.max(staleAfterMs, policyMinPollIntervalMs);
    return !input.forcedRefresh && input.now < fetchedAt + effectiveStaleAfterMs;
  }

  private shouldForceQuotaRefresh(existing: ExistingQuotaSnapshotResponse): boolean {
    const fetchedAt = Number(existing?.metadata?.fetchedAt ?? 0);
    const refreshRequestedAt = Number(existing?.metadata?.refreshRequestedAt ?? 0);
    return Number.isFinite(refreshRequestedAt) && refreshRequestedAt > 0 && refreshRequestedAt > fetchedAt;
  }

  private async acquireQuotaFetchLease(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<Readonly<{ type: 'acquired' } | { type: 'contended'; leaseUntil: number }>> {
    if (typeof this.api.acquireConnectedServiceRefreshLease !== 'function' || !this.machineIdProvider) {
      return { type: 'acquired' };
    }
    const machineId = String(this.machineIdProvider() ?? '').trim();
    if (!machineId) return { type: 'acquired' };
    const ownerIdRaw = this.ownerIdProvider ? String(this.ownerIdProvider() ?? '').trim() : '';
    const lease = await this.api.acquireConnectedServiceRefreshLease({
      serviceId: input.serviceId,
      profileId: input.profileId,
      machineId,
      ...(ownerIdRaw ? { ownerId: ownerIdRaw } : {}),
      leaseMs: this.quotaFetchLeaseMs,
    });
    if (lease.acquired) return { type: 'acquired' };
    return { type: 'contended', leaseUntil: Number(lease.leaseUntil ?? 0) };
  }

  private async waitForContendedQuotaFetch(input: Readonly<{
    accountMode: ConnectedServiceAccountMode;
    material: Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'];
    serviceId: ConnectedServiceId;
    profileId: string;
    fetcher: ConnectedServiceQuotaFetcher;
    now: number;
    leaseUntil: number;
  }>): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    const maxWaitMs = this.quotaFetchLeaseContentionWaitMaxMs;
    if (maxWaitMs > 0) {
      const waitMs = Math.min(maxWaitMs, Math.max(0, Math.trunc(input.leaseUntil - input.now)));
    if (waitMs > 0) await this.sleepMs(waitMs);
    }
    const observed = await this.readExistingQuotaSnapshot(input).catch(() => null);
    if (!this.isExistingQuotaSnapshotFresh({
      existing: observed?.existing ?? null,
      now: this.now(),
      fetcher: input.fetcher,
      forcedRefresh: this.shouldForceQuotaRefresh(observed?.existing ?? null),
    })) {
      return null;
    }
    if (!observed) return null;
    return this.openExistingQuotaSnapshot({
      storageMode: observed.storageMode,
      material: input.material,
      existing: observed.existing,
    });
  }

  private shouldRefreshCredentialBeforeFetch(record: ConnectedServiceCredentialRecordV1, now: number): boolean {
    if (record.kind !== 'oauth') return false;
    const expiresAt = readFiniteNonNegativeMs(record.expiresAt);
    if (expiresAt === null) return false;
    return expiresAt - now <= this.credentialRefreshWindowMs;
  }

  private async maybeRefreshCredentialForQuota(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
  }>): Promise<ConnectedServiceCredentialRecordV1> {
    if (!this.refreshConnectedServiceCredentialForQuota) return input.record;
    if (!this.shouldRefreshCredentialBeforeFetch(input.record, input.now)) return input.record;
    const refreshed = await this.refreshConnectedServiceCredentialForQuota({
      serviceId: input.serviceId,
      profileId: input.profileId,
      force: false,
      reason: 'near_expiry',
    }).catch(() => null);
    return refreshed ?? input.record;
  }

  private async runFetcherWithTimeout(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
  }>): Promise<
    | Readonly<{ type: 'timeout' }>
    | Readonly<{ type: 'result'; snapshot: ConnectedServiceQuotaSnapshotV1 | null }>
  > {
    const controller = new AbortController();
    const timeoutMs = this.fetchTimeoutMs;
    const fetchPromise = input.fetcher.fetch({ record: input.record, now: input.now, signal: controller.signal });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        try {
          controller.abort('quota-fetch-timeout');
        } catch {
          // ignore
        }
        resolve({ type: 'timeout' });
      }, timeoutMs);
      (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
    });

    const raced = await Promise.race([
      fetchPromise.then(
        (snapshot) => ({ type: 'result' as const, snapshot }),
        (error) => ({ type: 'error' as const, error }),
      ),
      timeoutPromise,
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;

    if (raced.type === 'timeout') return raced;
    if (raced.type === 'error') throw raced.error;
    return raced;
  }

  private async fetchQuotaSnapshotWithRefresh(input: Readonly<{
    fetcher: ConnectedServiceQuotaFetcher;
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
    now: number;
  }>): Promise<
    | Readonly<{ type: 'timeout' }>
    | Readonly<{ type: 'result'; snapshot: ConnectedServiceQuotaSnapshotV1 | null }>
  > {
    const record = await this.maybeRefreshCredentialForQuota(input);
    try {
      return await this.runFetcherWithTimeout({
        fetcher: input.fetcher,
        record,
        now: input.now,
      });
    } catch (error) {
      if (!isQuotaAuthFailure(error) || !this.refreshConnectedServiceCredentialForQuota) throw error;
      const refreshed = await this.refreshConnectedServiceCredentialForQuota({
        serviceId: input.serviceId,
        profileId: input.profileId,
        force: true,
        reason: 'auth_failure',
      }).catch(() => null);
      if (!refreshed) throw error;
      return await this.runFetcherWithTimeout({
        fetcher: input.fetcher,
        record: refreshed,
        now: input.now,
      });
    }
  }

  public async tickOnce(): Promise<void> {
    const now = Math.max(0, Math.trunc(this.now()));
    if (this.checkQuotaWorkGate('tick').status !== 'open') return;
    const accountMode = await resolveConnectedServiceAccountMode(this.api);
    if (accountMode === 'unknown') return;
    const encryption = this.credentials.encryption;
    const material =
      encryption.type === 'legacy'
        ? ({ type: 'legacy' as const, secret: encryption.secret })
        : ({ type: 'dataKey' as const, machineKey: encryption.machineKey });

    const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
    const groupSwitchTargetsByBindingKey = new Map<string, ActiveGroupQuotaSwitchTarget[]>();
    const profileHealthByServiceId: ProfileHealthByServiceId = new Map();
    const loadProfileHealth = async (serviceId: ConnectedServiceId): Promise<Map<string, ConnectedServiceCredentialHealthStatusV1>> => {
      const existing = profileHealthByServiceId.get(serviceId);
      if (existing) return existing;
      if (typeof this.api.listConnectedServiceProfiles !== 'function') {
        const empty = new Map<string, ConnectedServiceCredentialHealthStatusV1>();
        profileHealthByServiceId.set(serviceId, empty);
        return empty;
      }
      try {
        const result = await this.api.listConnectedServiceProfiles({ serviceId });
        const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
        const byProfileId = new Map<string, ConnectedServiceCredentialHealthStatusV1>();
        for (const profile of profiles) {
          if (!profile || typeof profile !== 'object') continue;
          const profileId = typeof profile.profileId === 'string' ? String(profile.profileId).trim() : '';
          if (!profileId) continue;
          byProfileId.set(profileId, profile.status);
        }
        profileHealthByServiceId.set(serviceId, byProfileId);
        return byProfileId;
      } catch {
        const empty = new Map<string, ConnectedServiceCredentialHealthStatusV1>();
        profileHealthByServiceId.set(serviceId, empty);
        return empty;
      }
    };

    for (const target of this.spawnTargetsByPid.values()) {
      for (const entry of extractActiveBindings(target.bindings, target.connectedServiceSelectionsEnv)) {
        const profileId = String(entry.profileId ?? '').trim();
        if (!profileId) continue;
        const existing = bindingsByServiceId.get(entry.serviceId);
        if (existing) {
          existing.add(profileId);
        } else {
          bindingsByServiceId.set(entry.serviceId, new Set([profileId]));
        }
        const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
        const groupId = typeof entry.groupId === 'string' ? entry.groupId.trim() : '';
        if (sessionId && groupId) {
          const bindingKey = this.makeBindingKey({ serviceId: entry.serviceId, profileId });
          const targets = groupSwitchTargetsByBindingKey.get(bindingKey) ?? [];
          if (!targets.some((candidate) =>
            candidate.sessionId === sessionId
            && candidate.serviceId === entry.serviceId
            && candidate.groupId === groupId
            && candidate.activeProfileId === profileId
          )) {
            targets.push({
              sessionId,
              serviceId: entry.serviceId,
              groupId,
              activeProfileId: profileId,
            });
          }
          groupSwitchTargetsByBindingKey.set(bindingKey, targets);
        }
      }
    }

    if (this.discoveryEnabled && typeof this.api.listConnectedServiceProfiles === 'function') {
      const discoveryDue = this.lastDiscoveryAt <= 0 || now - this.lastDiscoveryAt >= this.discoveryIntervalMs;
      if (discoveryDue) {
        this.lastDiscoveryAt = now;
        for (const serviceId of this.quotaFetchersByServiceId.keys()) {
          try {
            const profiles = await loadProfileHealth(serviceId);
            for (const [profileId, status] of profiles.entries()) {
              if (status !== 'connected') continue;
              if (!profileId) continue;
              const existing = bindingsByServiceId.get(serviceId);
              if (existing) {
                existing.add(profileId);
              } else {
                bindingsByServiceId.set(serviceId, new Set([profileId]));
              }
            }
          } catch {
            // Best-effort only.
            continue;
          }
        }
      }
    }

    for (const [serviceId, profileIds] of bindingsByServiceId.entries()) {
      const fetcher = this.quotaFetchersByServiceId.get(serviceId);
      if (!fetcher) continue;
      const profileHealthByProfileId = await loadProfileHealth(serviceId);

      for (const profileId of profileIds) {
        if (profileHealthByProfileId.get(profileId) === 'needs_reauth') continue;
        // X8: capture any stale snapshot found during read so the catch path can
        // surface it with a stale_quota annotation instead of discarding it.
        let staleSnapshotForFallback: ConnectedServiceQuotaSnapshotV1 | null = null;
        try {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          const existing = await this.readExistingQuotaSnapshot({ accountMode, serviceId, profileId });
          const forcedRefresh = this.shouldForceQuotaRefresh(existing.existing);

          const failureState = this.failureStateByBindingKey.get(bindingKey);
          if (failureState && now < failureState.nextAllowedAt) {
            continue;
          }

          if (this.isExistingQuotaSnapshotFresh({ existing: existing.existing, now, fetcher, forcedRefresh })) {
            const existingSnapshot = this.openExistingQuotaSnapshot({
              storageMode: existing.storageMode,
              material,
              existing: existing.existing,
            });
            if (existingSnapshot) {
              this.recordPersistedInBandQuotaStateFromExisting({
                serviceId,
                profileId,
                snapshot: existingSnapshot,
                existing: existing.existing,
              });
              this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: existingSnapshot });
              await this.maybeRequestActiveGroupSwitchForSnapshot({
                now,
                targets: groupSwitchTargetsByBindingKey.get(bindingKey),
              });
            }
            this.failureStateByBindingKey.delete(bindingKey);
            continue;
          }

          // Snapshot is stale — capture it for the failure fallback path (X8) before
          // attempting the fetch.  The fetch may throw, and if so we want to surface
          // the last-known data with a stale_quota annotation.
          staleSnapshotForFallback = this.openExistingQuotaSnapshot({
            storageMode: existing.storageMode,
            material,
            existing: existing.existing,
          });
          if (staleSnapshotForFallback) {
            this.recordPersistedInBandQuotaStateFromExisting({
              serviceId,
              profileId,
              snapshot: staleSnapshotForFallback,
              existing: existing.existing,
            });
          }

          const lease = await this.acquireQuotaFetchLease({ serviceId, profileId });
          if (lease.type === 'contended') {
            const observedSnapshot = await this.waitForContendedQuotaFetch({
              accountMode,
              material,
              serviceId,
              profileId,
              fetcher,
              now,
              leaseUntil: lease.leaseUntil,
            });
            if (observedSnapshot) {
              this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot: observedSnapshot });
              await this.maybeRequestActiveGroupSwitchForSnapshot({
                now,
                targets: groupSwitchTargetsByBindingKey.get(bindingKey),
              });
              this.failureStateByBindingKey.delete(bindingKey);
            }
            continue;
          }

          const credential = await this.readCredentialForQuota({
            accountMode,
            material,
            serviceId,
            profileId,
          });
          const record = credential.record;
          if (!record) continue;

          const raced = await this.fetchQuotaSnapshotWithRefresh({
            fetcher,
            serviceId,
            profileId,
            record,
            now,
          });
          if (raced.type === 'timeout') {
            // Best-effort only: ignore late results. The AbortController should be enough for well-behaved fetchers.
            continue;
          }

          const snapshot = raced.snapshot;
          if (!snapshot) continue;

          if (staleSnapshotForFallback && isQuotaUnknownFallbackSnapshot(snapshot)) {
            this.recordRuntimeProfileSnapshot({
              serviceId,
              profileId,
              snapshot: annotateSnapshotAsStale(staleSnapshotForFallback),
            });
            this.failureStateByBindingKey.delete(bindingKey);
            continue;
          }

          this.recordRuntimeProfileSnapshot({ serviceId, profileId, snapshot });
          await this.maybeRequestActiveGroupSwitchForSnapshot({
            now,
            targets: groupSwitchTargetsByBindingKey.get(bindingKey),
          });
          await this.persistQuotaSnapshotWithServerWork({
            accountMode: credential.storageMode,
            serviceId,
            profileId,
            snapshot,
            materialFingerprint: this.computeQuotaMaterialFingerprint(snapshot),
          });
          this.failureStateByBindingKey.delete(bindingKey);
        } catch (error) {
          const bindingKey = this.makeBindingKey({ serviceId, profileId });
          const credentialHealthUpdated = await this.persistCredentialHealthForQuotaFailure({
            serviceId,
            profileId,
            error,
            now,
          }).catch(() => false);
          if (credentialHealthUpdated) {
            profileHealthByProfileId.set(profileId, 'needs_reauth');
          }
          this.applyFailureBackoff({
            now,
            key: bindingKey,
            retryAfterMs: readQuotaRetryAfterMs(error),
            retryAfterBackoffMinMs: fetcher?.pollPolicy?.retryAfterBackoffMinMs,
          });
          // X8: keep last-known quota in the runtime store with stale_quota annotation
          // so the UI can display "stale data" rather than showing nothing.
          if (staleSnapshotForFallback) {
            this.recordRuntimeProfileSnapshot({
              serviceId,
              profileId,
              snapshot: annotateSnapshotAsStale(staleSnapshotForFallback),
            });
          }
          // Best-effort only.
          continue;
        }
      }
    }
  }
}
