import {
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMember,
  type ConnectedServiceAuthGroupMemberRuntimeState,
  type ConnectedServiceAuthGroupPolicyV1,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from '../selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import { readConnectedServiceAuthGenerationApplyFailure } from '../../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../../accountTransitions/acceptedConnectedServiceAccountVerification';

export type ConnectedServiceAuthGroupSwitchState = Readonly<{
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  policy: ConnectedServiceAuthGroupPolicyV1;
  members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>;

type LeaseCompletion = Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  reason?: string;
  fromProfileId?: string | null;
  result: ConnectedServiceAuthGroupSwitchResult;
}>;
type ConnectedServiceAuthGroupSwitchApplyMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';
type ConnectedServiceAuthGroupProviderApplication = 'applied' | 'observed';
type ConnectedServiceAuthGroupSwitchApplyGenerationResult = Readonly<{
  mode?: ConnectedServiceAuthGroupSwitchApplyMode;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>;

type LeaseOutcome =
  | Readonly<{ status: 'completed'; completion: LeaseCompletion }>
  | Readonly<{ status: 'failed'; error: unknown }>;

type LeaseAcquireResult =
  | Readonly<{
      kind: 'owner';
      complete(completion: LeaseCompletion): void;
      fail(error: unknown): void;
    }>
  | Readonly<{
      kind: 'loser';
      waitForOwner(): Promise<LeaseCompletion>;
    }>;

const DEFAULT_SWITCH_LEASE_TIMEOUT_MS = 30_000;
export const SESSION_SWITCH_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function switchKey(serviceId: string, groupId: string): string {
  return `${serviceId}\0${groupId}`;
}

export class ConnectedServiceAuthGroupSwitchLeaseExpiredError extends Error {
  constructor() {
    super('connected_service_auth_group_switch_lease_expired');
  }
}

export class InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry {
  private readonly pendingByKey = new Map<string, {
    promise: Promise<LeaseOutcome>;
    resolve: (outcome: LeaseOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly options: Readonly<{ leaseTimeoutMs?: number }> = {}) {}

  acquire(input: Readonly<{ serviceId: string; groupId: string }>): LeaseAcquireResult {
    const key = switchKey(input.serviceId, input.groupId);
    const pending = this.pendingByKey.get(key);
    if (pending) {
      return {
        kind: 'loser',
        waitForOwner: async () => {
          const outcome = await pending.promise;
          if (outcome.status === 'failed') throw outcome.error;
          return outcome.completion;
        },
      };
    }

    let resolveCompletion: (outcome: LeaseOutcome) => void = () => {};
    const promise = new Promise<LeaseOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    const timer = setTimeout(() => {
      const current = this.pendingByKey.get(key);
      if (!current) return;
      this.pendingByKey.delete(key);
      current.resolve({ status: 'failed', error: new ConnectedServiceAuthGroupSwitchLeaseExpiredError() });
    }, this.options.leaseTimeoutMs ?? DEFAULT_SWITCH_LEASE_TIMEOUT_MS);
    this.pendingByKey.set(key, { promise, resolve: resolveCompletion, timer });
    return {
      kind: 'owner',
      complete: (completion) => {
        const current = this.pendingByKey.get(key);
        if (!current) return;
        this.pendingByKey.delete(key);
        clearTimeout(current.timer);
        current.resolve({ status: 'completed', completion });
      },
      fail: (error) => {
        const current = this.pendingByKey.get(key);
        if (!current) return;
        this.pendingByKey.delete(key);
        clearTimeout(current.timer);
        current.resolve({ status: 'failed', error });
      },
    };
  }
}

export type ConnectedServiceAuthGroupSwitchResult =
  | Readonly<{
      status: 'switched';
      activeProfileId: string;
      generation: number;
      mode?: ConnectedServiceAuthGroupSwitchApplyMode;
      providerApplication?: ConnectedServiceAuthGroupProviderApplication;
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
    }>
  | Readonly<{
      status: 'generation_apply_failed';
      activeProfileId: string | null;
      generation: number;
      errorCode: string;
      diagnostics?: unknown;
    }>
  | Readonly<{
      status: 'observed_generation';
      activeProfileId: string | null;
      generation: number;
      mode?: ConnectedServiceAuthGroupSwitchApplyMode;
      providerApplication?: ConnectedServiceAuthGroupProviderApplication;
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
    }>
  | Readonly<{
      status: 'no_eligible_member';
      generation: number;
      groupExhausted: true;
      retryAtMs: number | null;
      excluded: ReadonlyArray<Readonly<{
        profileId: string;
        reason: string;
        retryAtMs?: number | null;
      }>>;
    }>
  | Readonly<{ status: 'manual_strategy'; generation: number }>
  | Readonly<{ status: 'auto_switch_disabled'; generation: number }>
  | Readonly<{ status: 'switch_reason_disabled'; generation: number }>
  | Readonly<{ status: 'switch_limit_reached'; generation: number }>;

export type ConnectedServiceAuthGroupSwitchLimitAction = Readonly<{
  kind: 'open_url';
  url: string;
}>;

export type ConnectedServiceAuthGroupSwitchEvent = Readonly<{
  type: 'connected_service_auth_group_switch';
  serviceId: string;
  groupId: string;
  fromProfileId: string | null;
  toProfileId: string | null;
  reason: string;
  limitCategory?: string | null;
  retryAfterMs?: number | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
  mode?: ConnectedServiceAuthGroupSwitchApplyMode;
  fromGeneration: number;
  toGeneration: number;
  resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
  success: boolean;
  latencyMs: number;
}>;

function isReasonEnabled(policy: ConnectedServiceAuthGroupPolicyV1, reason: string): boolean {
  switch (reason) {
    case 'usage_limit':
    case 'rate_limit':
    case 'soft_threshold':
    case 'capacity':
      return policy.switchOn.usageLimit;
    case 'auth_expired':
    case 'account_disabled':
      return policy.switchOn.authExpired;
    case 'account_changed':
      return policy.switchOn.accountChanged;
    case 'refresh_failed':
      return policy.switchOn.refreshFailure || policy.switchOn.authExpired;
    default:
      return false;
  }
}

function resolveEarliestRetryAtMs(excluded: ReadonlyArray<Readonly<{ retryAtMs?: number | null }>>): number | null {
  let earliest: number | null = null;
  for (const item of excluded) {
    if (typeof item.retryAtMs !== 'number' || !Number.isFinite(item.retryAtMs)) continue;
    earliest = earliest === null ? item.retryAtMs : Math.min(earliest, item.retryAtMs);
  }
  return earliest;
}

function resolvePolicyRecoveryWaitRetryAtMs(input: Readonly<{
  retryAtMs?: number | null;
  resetsAtMs?: number | null;
}>): number | null {
  const values = [input.retryAtMs, input.resetsAtMs]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function normalizeProfileId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canRetryCurrentProfileForObservedProfile(input: Readonly<{
  observedProfileId?: string | null;
  activeProfileId: string | null | undefined;
}>): boolean {
  const observedProfileId = normalizeProfileId(input.observedProfileId);
  const activeProfileId = normalizeProfileId(input.activeProfileId);
  return !observedProfileId || !activeProfileId || observedProfileId === activeProfileId;
}

function isProfileEligibleForObservedGeneration(input: Readonly<{
  profileId: string;
  reason: string;
  nowMs: number;
  quotaFreshnessMs: number;
  memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
  selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
}>): boolean {
  return input.selected.selected?.profileId === input.profileId
    && hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: input.reason,
      profileId: input.profileId,
      nowMs: input.nowMs,
      quotaFreshnessMs: input.quotaFreshnessMs,
      memberStatesByProfileId: input.memberStatesByProfileId,
    });
}

function buildLeaseCompletion(input: Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
  reason?: string;
  fromProfileId?: string | null;
  result: ConnectedServiceAuthGroupSwitchResult;
}>): LeaseCompletion {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    serviceId: input.serviceId,
    groupId: input.groupId,
    activeProfileId: input.activeProfileId,
    generation: input.generation,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.fromProfileId === undefined ? {} : { fromProfileId: input.fromProfileId }),
    result: input.result,
  };
}

function buildSessionApplyFromLeaseCompletion(input: Readonly<{
  completion: LeaseCompletion;
  sessionId?: string;
}>): LeaseCompletion {
  const { sessionId: _ownerSessionId, ...completion } = input.completion;
  return {
    ...completion,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

function shouldApplyLeaseCompletion(completion: LeaseCompletion): boolean {
  return completion.result.status === 'switched' || completion.result.status === 'observed_generation';
}

function providerApplicationForApplyMode(
  mode: ConnectedServiceAuthGroupSwitchApplyMode | undefined,
): ConnectedServiceAuthGroupProviderApplication | null {
  if (mode === 'spawn_next_turn') return 'observed';
  if (mode === 'hot_apply' || mode === 'restart_resume') return 'applied';
  return null;
}

function switchResultApplyFields(
  applyResult: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void,
): Pick<
  Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'switched' | 'observed_generation' }>,
  'mode' | 'providerApplication' | 'verificationByServiceId'
> {
  const providerApplication = providerApplicationForApplyMode(applyResult?.mode);
  return {
    ...(applyResult?.mode ? { mode: applyResult.mode } : {}),
    ...(providerApplication ? { providerApplication } : {}),
    ...(applyResult?.verificationByServiceId
      ? { verificationByServiceId: applyResult.verificationByServiceId }
      : {}),
  };
}

type ObservedGenerationApplyResult = Extract<
  ConnectedServiceAuthGroupSwitchResult,
  { status: 'observed_generation' | 'generation_apply_failed' }
>;

type GenerationConflictResolution =
  | Readonly<{ kind: 'observed_generation'; result: ObservedGenerationApplyResult }>
  | Readonly<{
      kind: 'retry';
      state: ConnectedServiceAuthGroupSwitchState;
      selectionActiveProfileId?: string | null;
    }>;

type RecordObservedFailureStateOutcome =
  | Readonly<{ kind: 'recorded'; state: ConnectedServiceAuthGroupSwitchState }>
  | Readonly<{ kind: 'observed_generation'; result: ObservedGenerationApplyResult }>;

type ConnectedServiceAuthGroupSwitchPipelineTrigger = 'classified_failure' | 'pre_turn';

type ConnectedServiceAuthGroupSwitchPipelineRequest = Readonly<{
  sessionId?: string;
  serviceId: string;
  groupId: string;
  reason: string;
  observedProfileId?: string | null;
  retryAtMs?: number | null;
  retryAfterMs?: number | null;
  resetsAtMs?: number | null;
  limitCategory?: string | null;
  quotaScope?: string | null;
  providerLimitId?: string | null;
  action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
  planType?: string | null;
  switchesThisTurn?: number;
  sessionSwitchesThisHour?: number;
}>;

type ConnectedServiceAuthGroupSwitchPipelinePhase =
  | 'lease_loser_non_apply'
  | 'lease_loser_apply'
  | 'record_observed_generation'
  | 'policy'
  | 'switch_limit'
  | 'no_candidate'
  | 'observed_divergence'
  | 'conflict_observed_generation'
  | 'apply_failed'
  | 'switched';

export class ConnectedServiceAuthGroupSwitchCoordinator {
  private readonly switchTimestampsBySessionKey = new Map<string, number[]>();

  constructor(private readonly deps: Readonly<{
    leases: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry;
    nowMs: () => number;
    quotaFreshnessMs: number;
    loadState(input: Readonly<{ serviceId: string; groupId: string }>): Promise<ConnectedServiceAuthGroupSwitchState>;
    commitSwitch(input: Readonly<{
      serviceId: string;
      groupId: string;
      fromProfileId: string | null;
      toProfileId: string;
      expectedGeneration: number;
      reason: string;
    }>): Promise<ConnectedServiceAuthGroupSwitchState>;
    applyGeneration(input: Readonly<{
      sessionId?: string;
      serviceId: string;
      groupId: string;
      activeProfileId: string | null;
      generation: number;
      reason?: string;
      /**
       * Pre-switch active group member. The persisted session group binding does not track the live
       * member, so it is threaded here so the session transcript "from" is the real member rather
       * than null (which the UI renders as the native / "CLI Auth" label).
       */
      fromProfileId?: string | null;
    }>): Promise<ConnectedServiceAuthGroupSwitchApplyGenerationResult | void>;
    recordObservedFailureState?(input: Readonly<{
      serviceId: string;
      groupId: string;
      loaded: ConnectedServiceAuthGroupSwitchState;
      reason: string;
      observedProfileId?: string | null;
      retryAtMs?: number | null;
      retryAfterMs?: number | null;
      resetsAtMs?: number | null;
      planType?: string | null;
    }>): Promise<void>;
    probeQuotaSnapshotsForGroup?(input: Readonly<{
      serviceId: string;
      groupId: string;
      profileIds: ReadonlyArray<string>;
      reason: string;
    }>): Promise<void>;
    resolveGenerationConflict?: (error: unknown) => number | null;
    emitEvent?: (event: ConnectedServiceAuthGroupSwitchEvent) => void;
  }>) {}

  private async probeQuotaSnapshotsBeforePreTurnSelection(input: Readonly<{
    request: Readonly<{
      serviceId: string;
      groupId: string;
      reason: string;
    }>;
    loaded: ConnectedServiceAuthGroupSwitchState;
    activeProfileId?: string | null;
    allowCurrentProfileRetry: boolean;
  }>): Promise<ConnectedServiceAuthGroupSwitchState> {
    if (!this.deps.probeQuotaSnapshotsForGroup) return input.loaded;
    const profileIds = resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: input.activeProfileId ?? input.loaded.activeProfileId,
      members: input.loaded.members,
      memberStatesByProfileId: input.loaded.memberStatesByProfileId,
      policy: input.loaded.policy,
      nowMs: this.deps.nowMs(),
      quotaFreshnessMs: this.deps.quotaFreshnessMs,
      allowCurrentProfileRetry: input.allowCurrentProfileRetry,
    });
    if (profileIds.length === 0) return input.loaded;
    await this.deps.probeQuotaSnapshotsForGroup({
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      profileIds,
      reason: input.request.reason,
    });
    return await this.deps.loadState({
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
    });
  }

  private resolveSessionSwitchKey(input: Readonly<{ sessionId?: string; serviceId: string; groupId: string }>): string | null {
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 ? input.sessionId.trim() : null;
    if (!sessionId) return null;
    return `${sessionId}\0${input.serviceId}\0${input.groupId}`;
  }

  private countRecentSessionSwitches(key: string, nowMs: number): number {
    const cutoffMs = nowMs - SESSION_SWITCH_LIMIT_WINDOW_MS;
    const recent = (this.switchTimestampsBySessionKey.get(key) ?? []).filter((timestamp) => timestamp >= cutoffMs);
    this.switchTimestampsBySessionKey.set(key, recent);
    return recent.length;
  }

  private recordSessionSwitch(key: string | null, nowMs: number): void {
    if (!key) return;
    const cutoffMs = nowMs - SESSION_SWITCH_LIMIT_WINDOW_MS;
    const recent = (this.switchTimestampsBySessionKey.get(key) ?? []).filter((timestamp) => timestamp >= cutoffMs);
    recent.push(nowMs);
    this.switchTimestampsBySessionKey.set(key, recent);
  }

  private async resolveStateAfterGenerationConflict(input: Readonly<{
    error: unknown;
    sessionId?: string;
    serviceId: string;
    groupId: string;
    loaded: ConnectedServiceAuthGroupSwitchState;
    reason?: string;
    observedProfileId?: string | null;
    lease: Extract<LeaseAcquireResult, { kind: 'owner' }>;
  }>): Promise<GenerationConflictResolution | null> {
    const conflictGeneration = this.deps.resolveGenerationConflict?.(input.error);
    if (typeof conflictGeneration !== 'number' || !Number.isFinite(conflictGeneration)) return null;
    const observed = await this.deps.loadState({
      serviceId: input.serviceId,
      groupId: input.groupId,
    });
    if (observed.generation <= input.loaded.generation) return null;
    if (normalizeProfileId(observed.activeProfileId) === normalizeProfileId(input.loaded.activeProfileId)) {
      return { kind: 'retry', state: observed };
    }
    const failedProfileId = normalizeProfileId(input.observedProfileId)
      ?? normalizeProfileId(input.loaded.activeProfileId);
    const observedActiveProfileId = normalizeProfileId(observed.activeProfileId);
    if (!observedActiveProfileId || !failedProfileId) {
      return { kind: 'retry', state: observed };
    }
    const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
      nowMs: this.deps.nowMs(),
      quotaFreshnessMs: this.deps.quotaFreshnessMs,
      activeProfileId: failedProfileId,
      policy: observed.policy,
      members: observed.members,
      memberStatesByProfileId: observed.memberStatesByProfileId,
    });
    if (!isProfileEligibleForObservedGeneration({
      profileId: observedActiveProfileId,
      reason: input.reason ?? '',
      nowMs: this.deps.nowMs(),
      quotaFreshnessMs: this.deps.quotaFreshnessMs,
      memberStatesByProfileId: observed.memberStatesByProfileId,
      selected: observedGenerationSelection,
    })) {
      return {
        kind: 'retry',
        state: observed,
        selectionActiveProfileId: observed.activeProfileId,
      };
    }
    const completion = buildLeaseCompletion({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      serviceId: input.serviceId,
      groupId: input.groupId,
      activeProfileId: observed.activeProfileId,
      generation: observed.generation,
      ...(input.reason ? { reason: input.reason } : {}),
      result: {
        status: 'observed_generation',
        activeProfileId: observed.activeProfileId,
        generation: observed.generation,
      },
    });
    input.lease.complete(completion);
    return {
      kind: 'observed_generation',
      result: await this.applyObservedGeneration(completion),
    };
  }

  private async applyObservedGeneration(completion: LeaseCompletion): Promise<ObservedGenerationApplyResult> {
    let applyResult: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void;
    try {
      applyResult = await this.deps.applyGeneration(completion);
      return {
        status: 'observed_generation',
        activeProfileId: completion.activeProfileId,
        generation: completion.generation,
        ...switchResultApplyFields(applyResult),
      };
    } catch (error) {
      const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
      if (!applyFailure) throw error;
      return {
        status: 'generation_apply_failed',
        activeProfileId: completion.activeProfileId,
        generation: completion.generation,
        errorCode: applyFailure.errorCode,
        ...(applyFailure.diagnostics === undefined ? {} : { diagnostics: applyFailure.diagnostics }),
      };
    }
  }

  private async recordObservedFailureStateWithConflictRecovery(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    loaded: ConnectedServiceAuthGroupSwitchState;
    reason: string;
    observedProfileId?: string | null;
    retryAtMs?: number | null;
    retryAfterMs?: number | null;
    resetsAtMs?: number | null;
    planType?: string | null;
    lease: Extract<LeaseAcquireResult, { kind: 'owner' }>;
  }>): Promise<RecordObservedFailureStateOutcome> {
    if (!this.deps.recordObservedFailureState) {
      return { kind: 'recorded', state: input.loaded };
    }

    let loaded = input.loaded;
    for (;;) {
      try {
        await this.deps.recordObservedFailureState({
          serviceId: input.serviceId,
          groupId: input.groupId,
          loaded,
          reason: input.reason,
          observedProfileId: input.observedProfileId,
          retryAtMs: input.retryAtMs,
          retryAfterMs: input.retryAfterMs,
          resetsAtMs: input.resetsAtMs,
          planType: input.planType,
        });
        return {
          kind: 'recorded',
          state: await this.deps.loadState({
            serviceId: input.serviceId,
            groupId: input.groupId,
          }),
        };
      } catch (error) {
        const resolvedConflict = await this.resolveStateAfterGenerationConflict({
          error,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          serviceId: input.serviceId,
          groupId: input.groupId,
          loaded,
          reason: input.reason,
          observedProfileId: input.observedProfileId,
          lease: input.lease,
        });
        if (!resolvedConflict) throw error;
        if (resolvedConflict.kind === 'observed_generation') {
          return resolvedConflict;
        }
        loaded = resolvedConflict.state;
      }
    }
  }

  private emitSwitchResult(input: Readonly<{
    request: Readonly<{
      serviceId: string;
      groupId: string;
      reason: string;
      observedProfileId?: string | null;
      limitCategory?: string | null;
      retryAtMs?: number | null;
      retryAfterMs?: number | null;
      quotaScope?: string | null;
      providerLimitId?: string | null;
      action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
    }>;
    loaded: Readonly<{ activeProfileId: string | null; generation: number }>;
    resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
    toProfileId: string | null;
    toGeneration: number;
    mode?: ConnectedServiceAuthGroupSwitchApplyMode;
    success: boolean;
    startedAtMs: number;
  }>): void {
    this.deps.emitEvent?.({
      type: 'connected_service_auth_group_switch',
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      fromProfileId: normalizeProfileId(input.request.observedProfileId) ?? input.loaded.activeProfileId,
      toProfileId: input.toProfileId,
      reason: input.request.reason,
      ...(input.request.limitCategory === undefined ? {} : { limitCategory: input.request.limitCategory }),
      ...(input.request.retryAfterMs === undefined && input.request.retryAtMs === undefined
        ? {}
        : { retryAfterMs: input.request.retryAfterMs ?? input.request.retryAtMs ?? null }),
      ...(input.request.quotaScope === undefined ? {} : { quotaScope: input.request.quotaScope }),
      ...(input.request.providerLimitId === undefined ? {} : { providerLimitId: input.request.providerLimitId }),
      ...(input.request.action === undefined ? {} : { action: input.request.action }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      fromGeneration: input.loaded.generation,
      toGeneration: input.toGeneration,
      resultStatus: input.resultStatus,
      success: input.success,
      latencyMs: Math.max(0, this.deps.nowMs() - input.startedAtMs),
    });
  }

  private shouldEmitSwitchPipelineResult(
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger,
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase,
  ): boolean {
    if (trigger === 'classified_failure') return true;
    return phase === 'switch_limit'
      || phase === 'observed_divergence'
      || phase === 'apply_failed'
      || phase === 'switched';
  }

  private maybeEmitSwitchPipelineResult(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase;
    request: ConnectedServiceAuthGroupSwitchPipelineRequest;
    loaded: Readonly<{ activeProfileId: string | null; generation: number }>;
    resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
    toProfileId: string | null;
    toGeneration: number;
    mode?: ConnectedServiceAuthGroupSwitchApplyMode;
    success: boolean;
    startedAtMs: number;
  }>): void {
    if (!this.shouldEmitSwitchPipelineResult(input.trigger, input.phase)) return;
    this.emitSwitchResult(input);
  }

  private resolvePipelineResultProfileId(input: Readonly<{
    result: ConnectedServiceAuthGroupSwitchResult;
    loaded: Readonly<{ activeProfileId: string | null }>;
  }>): string | null {
    switch (input.result.status) {
      case 'switched':
      case 'observed_generation':
      case 'generation_apply_failed':
        return input.result.activeProfileId;
      case 'auto_switch_disabled':
      case 'switch_reason_disabled':
      case 'manual_strategy':
        return input.loaded.activeProfileId;
      case 'no_eligible_member':
      case 'switch_limit_reached':
        return null;
    }
  }

  private completePipelineResult(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase;
    lease: Extract<LeaseAcquireResult, { kind: 'owner' }>;
    request: ConnectedServiceAuthGroupSwitchPipelineRequest;
    loaded: Readonly<{ activeProfileId: string | null; generation: number }>;
    result: ConnectedServiceAuthGroupSwitchResult;
    startedAtMs: number;
  }>): ConnectedServiceAuthGroupSwitchResult {
    input.lease.complete(buildLeaseCompletion({
      ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
      serviceId: input.request.serviceId,
      groupId: input.request.groupId,
      activeProfileId: input.loaded.activeProfileId,
      generation: input.loaded.generation,
      reason: input.request.reason,
      result: input.result,
    }));
    this.maybeEmitSwitchPipelineResult({
      trigger: input.trigger,
      phase: input.phase,
      request: input.request,
      loaded: input.loaded,
      resultStatus: input.result.status,
      toProfileId: this.resolvePipelineResultProfileId(input),
      toGeneration: input.result.generation,
      success: false,
      startedAtMs: input.startedAtMs,
    });
    return input.result;
  }

  private resolvePolicyResult(input: Readonly<{
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger;
    request: ConnectedServiceAuthGroupSwitchPipelineRequest;
    loaded: ConnectedServiceAuthGroupSwitchState;
  }>): Readonly<{
    phase: ConnectedServiceAuthGroupSwitchPipelinePhase;
    result: ConnectedServiceAuthGroupSwitchResult;
  }> | null {
    if (!input.loaded.policy.autoSwitch || input.loaded.policy.recoveryMode === 'off') {
      return {
        phase: 'policy',
        result: { status: 'auto_switch_disabled', generation: input.loaded.generation },
      };
    }
    if (!isReasonEnabled(input.loaded.policy, input.request.reason)) {
      return {
        phase: 'policy',
        result: { status: 'switch_reason_disabled', generation: input.loaded.generation },
      };
    }
    if (input.loaded.policy.recoveryMode === 'wait_until_reset') {
      return {
        phase: 'policy',
        result: {
          status: 'no_eligible_member',
          generation: input.loaded.generation,
          groupExhausted: true,
          retryAtMs: input.trigger === 'classified_failure'
            ? resolvePolicyRecoveryWaitRetryAtMs(input.request)
            : null,
          excluded: [],
        },
      };
    }

    const switchesThisTurn = typeof input.request.switchesThisTurn === 'number' && Number.isFinite(input.request.switchesThisTurn)
      ? Math.max(0, Math.trunc(input.request.switchesThisTurn))
      : 0;
    const sessionSwitchKey = this.resolveSessionSwitchKey(input.request);
    const hourlySwitchCount = typeof input.request.sessionSwitchesThisHour === 'number' && Number.isFinite(input.request.sessionSwitchesThisHour)
      ? Math.max(0, Math.trunc(input.request.sessionSwitchesThisHour))
      : sessionSwitchKey
        ? this.countRecentSessionSwitches(sessionSwitchKey, this.deps.nowMs())
        : 0;
    if (
      switchesThisTurn >= input.loaded.policy.maxSwitchesPerTurn
      || hourlySwitchCount >= input.loaded.policy.maxSwitchesPerSessionHour
    ) {
      return {
        phase: 'switch_limit',
        result: { status: 'switch_limit_reached', generation: input.loaded.generation },
      };
    }
    return null;
  }

  async switchAfterClassifiedFailure(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: string;
    observedProfileId?: string | null;
    retryAtMs?: number | null;
    retryAfterMs?: number | null;
    resetsAtMs?: number | null;
    limitCategory?: string | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
    action?: ConnectedServiceAuthGroupSwitchLimitAction | null;
    planType?: string | null;
    switchesThisTurn?: number;
    sessionSwitchesThisHour?: number;
  }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    return await this.runSwitchPipeline(input, 'classified_failure');
  }

  async switchBeforeTurn(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    observedProfileId?: string | null;
    switchesThisTurn?: number;
    sessionSwitchesThisHour?: number;
  }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    return await this.runSwitchPipeline(input, 'pre_turn');
  }

  private async runSwitchPipeline(
    input: ConnectedServiceAuthGroupSwitchPipelineRequest,
    trigger: ConnectedServiceAuthGroupSwitchPipelineTrigger,
  ): Promise<ConnectedServiceAuthGroupSwitchResult> {
    const startedAtMs = this.deps.nowMs();
    const lease = this.deps.leases.acquire(input);
    if (lease.kind === 'loser') {
      const observed = await lease.waitForOwner();
      if (!shouldApplyLeaseCompletion(observed)) {
        this.maybeEmitSwitchPipelineResult({
          trigger,
          phase: 'lease_loser_non_apply',
          request: input,
          loaded: observed,
          resultStatus: observed.result.status,
          toProfileId: observed.activeProfileId,
          toGeneration: observed.generation,
          success: false,
          startedAtMs,
        });
        return observed.result;
      }
      if (
        trigger === 'classified_failure'
        &&
        normalizeProfileId(input.observedProfileId)
        && normalizeProfileId(input.observedProfileId) === normalizeProfileId(observed.activeProfileId)
      ) {
        return await this.runSwitchPipeline(input, trigger);
      }
      const result = await this.applyObservedGeneration(buildSessionApplyFromLeaseCompletion({
        completion: observed,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }));
      this.maybeEmitSwitchPipelineResult({
        trigger,
        phase: 'lease_loser_apply',
        request: input,
        loaded: observed,
        resultStatus: result.status,
        toProfileId: result.activeProfileId,
        toGeneration: result.generation,
        success: result.status === 'observed_generation',
        startedAtMs,
      });
      return result;
    }

    try {
      let loaded = await this.deps.loadState(input);
      const observedProfileId = normalizeProfileId(input.observedProfileId);
      let selectionActiveProfileId = loaded.activeProfileId;

      if (trigger === 'classified_failure') {
        const observedFailureOutcome = await this.recordObservedFailureStateWithConflictRecovery({
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          serviceId: input.serviceId,
          groupId: input.groupId,
          loaded,
          reason: input.reason,
          observedProfileId: input.observedProfileId,
          retryAtMs: input.retryAtMs,
          retryAfterMs: input.retryAfterMs,
          resetsAtMs: input.resetsAtMs,
          planType: input.planType,
          lease,
        });
        if (observedFailureOutcome.kind === 'observed_generation') {
          this.maybeEmitSwitchPipelineResult({
            trigger,
            phase: 'record_observed_generation',
            request: input,
            loaded,
            resultStatus: observedFailureOutcome.result.status,
            toProfileId: observedFailureOutcome.result.activeProfileId,
            toGeneration: observedFailureOutcome.result.generation,
            success: observedFailureOutcome.result.status === 'observed_generation',
            startedAtMs,
          });
          return observedFailureOutcome.result;
        }
        loaded = observedFailureOutcome.state;
        const loadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
        let didProbeForSelection = false;
        if (observedProfileId && loadedActiveProfileId && loadedActiveProfileId !== observedProfileId) {
          selectionActiveProfileId = observedProfileId;
          loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
            request: input,
            loaded,
            activeProfileId: selectionActiveProfileId,
            allowCurrentProfileRetry: false,
          });
          didProbeForSelection = true;
          const currentLoadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
          const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            activeProfileId: selectionActiveProfileId,
            policy: loaded.policy,
            members: loaded.members,
            memberStatesByProfileId: loaded.memberStatesByProfileId,
          });
          if (
            currentLoadedActiveProfileId
            && currentLoadedActiveProfileId !== observedProfileId
            && isProfileEligibleForObservedGeneration({
              profileId: currentLoadedActiveProfileId,
              reason: input.reason,
              nowMs: this.deps.nowMs(),
              quotaFreshnessMs: this.deps.quotaFreshnessMs,
              memberStatesByProfileId: loaded.memberStatesByProfileId,
              selected: observedGenerationSelection,
            })
          ) {
            const completion = buildLeaseCompletion({
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              serviceId: input.serviceId,
              groupId: input.groupId,
              activeProfileId: loaded.activeProfileId,
              generation: loaded.generation,
              reason: input.reason,
              result: {
                status: 'observed_generation',
                activeProfileId: loaded.activeProfileId,
                generation: loaded.generation,
              },
            });
            lease.complete(completion);
            const result = await this.applyObservedGeneration(completion);
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'observed_divergence',
              request: input,
              loaded,
              resultStatus: result.status,
              toProfileId: result.activeProfileId,
              toGeneration: result.generation,
              success: result.status === 'observed_generation',
              startedAtMs,
            });
            return result;
          }
          selectionActiveProfileId = currentLoadedActiveProfileId;
        }
        if (!didProbeForSelection) {
          loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
            request: input,
            loaded,
            activeProfileId: selectionActiveProfileId,
            allowCurrentProfileRetry: false,
          });
        }
      }

      const preProbePolicyResult = trigger === 'pre_turn'
        ? this.resolvePolicyResult({ trigger, request: input, loaded })
        : null;
      if (preProbePolicyResult) {
        return this.completePipelineResult({
          trigger,
          phase: preProbePolicyResult.phase,
          lease,
          request: input,
          loaded,
          result: preProbePolicyResult.result,
          startedAtMs,
        });
      }

      if (trigger === 'pre_turn') {
        loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
          request: input,
          loaded,
          allowCurrentProfileRetry: true,
        });

        const loadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
        if (observedProfileId && loadedActiveProfileId && observedProfileId !== loadedActiveProfileId) {
          const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            activeProfileId: observedProfileId,
            policy: loaded.policy,
            members: loaded.members,
            memberStatesByProfileId: loaded.memberStatesByProfileId,
            allowCurrentProfileRetry: true,
          });
          if (isProfileEligibleForObservedGeneration({
            profileId: loadedActiveProfileId,
            reason: input.reason,
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            memberStatesByProfileId: loaded.memberStatesByProfileId,
            selected: observedGenerationSelection,
          })) {
            const result: ConnectedServiceAuthGroupSwitchResult = {
              status: 'observed_generation',
              activeProfileId: loaded.activeProfileId,
              generation: loaded.generation,
            };
            const completion = buildLeaseCompletion({
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              serviceId: input.serviceId,
              groupId: input.groupId,
              activeProfileId: loaded.activeProfileId,
              generation: loaded.generation,
              reason: input.reason,
              fromProfileId: observedProfileId,
              result,
            });
            lease.complete(completion);
            const applied = await this.applyObservedGeneration(completion);
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'observed_divergence',
              request: input,
              loaded,
              resultStatus: applied.status,
              toProfileId: applied.activeProfileId,
              toGeneration: applied.generation,
              ...(applied.status === 'observed_generation' && applied.mode ? { mode: applied.mode } : {}),
              success: applied.status === 'observed_generation',
              startedAtMs,
            });
            return applied;
          }
        }
      }

      const postProbePolicyResult = trigger === 'classified_failure'
        ? this.resolvePolicyResult({ trigger, request: input, loaded })
        : null;
      if (postProbePolicyResult) {
        return this.completePipelineResult({
          trigger,
          phase: postProbePolicyResult.phase,
          lease,
          request: input,
          loaded,
          result: postProbePolicyResult.result,
          startedAtMs,
        });
      }

      const allowLoadedActiveProfileRetry = trigger === 'pre_turn'
        ? canRetryCurrentProfileForObservedProfile({
            observedProfileId,
            activeProfileId: loaded.activeProfileId,
          })
        : false;
      const selected = selectConnectedServiceAuthGroupCandidate({
        nowMs: this.deps.nowMs(),
        quotaFreshnessMs: this.deps.quotaFreshnessMs,
        activeProfileId: trigger === 'pre_turn' ? loaded.activeProfileId : selectionActiveProfileId,
        policy: loaded.policy,
        members: loaded.members,
        memberStatesByProfileId: loaded.memberStatesByProfileId,
        ...(trigger === 'pre_turn' ? { allowCurrentProfileRetry: allowLoadedActiveProfileRetry } : {}),
      });
      if (!selected.selected) {
        const result: ConnectedServiceAuthGroupSwitchResult = selected.reason === 'manual_strategy'
          ? { status: 'manual_strategy', generation: loaded.generation }
          : {
              status: 'no_eligible_member',
              generation: loaded.generation,
              groupExhausted: true,
              retryAtMs: resolveEarliestRetryAtMs(selected.excluded),
              excluded: selected.excluded,
            };
        return this.completePipelineResult({
          trigger,
          phase: 'no_candidate',
          lease,
          request: input,
          loaded,
          result,
          startedAtMs,
        });
      }

      let selectedProfileId = selected.selected.profileId;
      if (trigger === 'pre_turn' && selectedProfileId === loaded.activeProfileId && allowLoadedActiveProfileRetry) {
        const result: ConnectedServiceAuthGroupSwitchResult = {
          status: 'observed_generation',
          activeProfileId: loaded.activeProfileId,
          generation: loaded.generation,
        };
        return this.completePipelineResult({
          trigger,
          phase: 'conflict_observed_generation',
          lease,
          request: input,
          loaded,
          result,
          startedAtMs,
        });
      }

      let commitLoaded = loaded;
      let commitSelectionActiveProfileId: string | null | undefined = trigger === 'pre_turn'
        ? loaded.activeProfileId
        : selectionActiveProfileId;
      let committed: ConnectedServiceAuthGroupSwitchState;
      for (;;) {
        try {
          committed = await this.deps.commitSwitch({
            serviceId: input.serviceId,
            groupId: input.groupId,
            fromProfileId: commitLoaded.activeProfileId,
            toProfileId: selectedProfileId,
            expectedGeneration: commitLoaded.generation,
            reason: input.reason,
          });
          break;
        } catch (error) {
          const resolvedConflict = await this.resolveStateAfterGenerationConflict({
            error,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            serviceId: input.serviceId,
            groupId: input.groupId,
            loaded: commitLoaded,
            reason: input.reason,
            ...(trigger === 'classified_failure' ? { observedProfileId: input.observedProfileId } : {}),
            lease,
          });
          if (resolvedConflict?.kind === 'observed_generation') {
            this.maybeEmitSwitchPipelineResult({
              trigger,
              phase: 'conflict_observed_generation',
              request: input,
              loaded: commitLoaded,
              resultStatus: resolvedConflict.result.status,
              toProfileId: resolvedConflict.result.activeProfileId,
              toGeneration: resolvedConflict.result.generation,
              success: resolvedConflict.result.status === 'observed_generation',
              startedAtMs,
            });
            return resolvedConflict.result;
          }
          if (resolvedConflict?.kind === 'retry') {
            commitLoaded = resolvedConflict.state;
            commitSelectionActiveProfileId = resolvedConflict.selectionActiveProfileId
              ?? (trigger === 'pre_turn' ? commitLoaded.activeProfileId : commitSelectionActiveProfileId);
            const retrySelected = selectConnectedServiceAuthGroupCandidate({
              nowMs: this.deps.nowMs(),
              quotaFreshnessMs: this.deps.quotaFreshnessMs,
              activeProfileId: commitSelectionActiveProfileId,
              policy: commitLoaded.policy,
              members: commitLoaded.members,
              memberStatesByProfileId: commitLoaded.memberStatesByProfileId,
            });
            if (!retrySelected.selected) {
              const result: ConnectedServiceAuthGroupSwitchResult = retrySelected.reason === 'manual_strategy'
                ? { status: 'manual_strategy', generation: commitLoaded.generation }
                : {
                    status: 'no_eligible_member',
                    generation: commitLoaded.generation,
                    groupExhausted: true,
                    retryAtMs: resolveEarliestRetryAtMs(retrySelected.excluded),
                    excluded: retrySelected.excluded,
                  };
              return this.completePipelineResult({
                trigger,
                phase: 'no_candidate',
                lease,
                request: input,
                loaded: commitLoaded,
                result,
                startedAtMs,
              });
            }
            selectedProfileId = retrySelected.selected.profileId;
            if (trigger === 'pre_turn' && selectedProfileId === commitLoaded.activeProfileId) {
              const result: ConnectedServiceAuthGroupSwitchResult = {
                status: 'observed_generation',
                activeProfileId: commitLoaded.activeProfileId,
                generation: commitLoaded.generation,
              };
              return this.completePipelineResult({
                trigger,
                phase: 'conflict_observed_generation',
                lease,
                request: input,
                loaded: commitLoaded,
                result,
                startedAtMs,
              });
            }
            continue;
          }
          throw error;
        }
      }
      const completion = buildLeaseCompletion({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        serviceId: input.serviceId,
        groupId: input.groupId,
        activeProfileId: committed.activeProfileId,
        generation: committed.generation,
        reason: input.reason,
        result: {
          status: 'switched',
          activeProfileId: committed.activeProfileId ?? selectedProfileId,
          generation: committed.generation,
        },
      });
      let applyResult: ConnectedServiceAuthGroupSwitchApplyGenerationResult | void;
      lease.complete(completion);
      try {
        applyResult = await this.deps.applyGeneration({
          ...completion,
          // Pre-switch active member, so the transcript "from" is the real member rather than null.
          fromProfileId: commitLoaded.activeProfileId,
        });
      } catch (error) {
        const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
        if (!applyFailure) throw error;
        this.maybeEmitSwitchPipelineResult({
          trigger,
          phase: 'apply_failed',
          request: input,
          loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
          resultStatus: 'generation_apply_failed',
          toProfileId: committed.activeProfileId ?? selectedProfileId,
          toGeneration: committed.generation,
          success: false,
          startedAtMs,
        });
        return {
          status: 'generation_apply_failed',
          activeProfileId: committed.activeProfileId ?? selectedProfileId,
          generation: committed.generation,
          errorCode: applyFailure.errorCode,
          ...(applyFailure.diagnostics === undefined ? {} : { diagnostics: applyFailure.diagnostics }),
        };
      }
      const sessionSwitchKey = this.resolveSessionSwitchKey(input);
      this.recordSessionSwitch(sessionSwitchKey, this.deps.nowMs());
      this.maybeEmitSwitchPipelineResult({
        trigger,
        phase: 'switched',
        request: input,
        loaded: trigger === 'classified_failure' ? loaded : commitLoaded,
        resultStatus: 'switched',
        toProfileId: committed.activeProfileId ?? selectedProfileId,
        toGeneration: committed.generation,
        ...(applyResult?.mode ? { mode: applyResult.mode } : {}),
        success: true,
        startedAtMs,
      });
      return {
        status: 'switched',
        activeProfileId: committed.activeProfileId ?? selectedProfileId,
        generation: committed.generation,
        ...switchResultApplyFields(applyResult),
      };
    } catch (error) {
      lease.fail(error);
      throw error;
    }
  }
}
