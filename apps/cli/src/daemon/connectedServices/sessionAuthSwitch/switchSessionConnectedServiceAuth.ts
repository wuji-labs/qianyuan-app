import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceId,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import { AGENT_IDS, AGENTS_CORE, type AgentId } from '@happier-dev/agents';

import type { CatalogAgentId } from '@/backends/types';
import { resolveCatalogAgentId } from '@/backends/catalog';
import type { TrackedSession } from '@/daemon/types';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
  type ConnectedServiceChildSelection,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  createConnectedServiceMaterializationIdentity,
  readConnectedServiceMaterializationIdentityV1,
} from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';

import type {
  ConnectedServiceSessionAuthSwitchCore,
  ConnectedServiceSessionAuthSwitchReason,
} from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialize/providerMaterializerTypes';

type ConnectedServiceBinding = ConnectedServiceBindingsV1['bindingsByServiceId'][string];
type AgentConnectedServiceSupport = Readonly<{
  connectedServices?: Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
  }> | null;
}>;
type SessionConnectedServiceAuthSwitchFailure = Extract<
  SessionConnectedServiceAuthSwitchResult,
  Readonly<{ ok: false }>
>;

export type SessionConnectedServiceAuthSwitchErrorCode =
  | 'session_not_found'
  | 'agent_mismatch'
  | 'unsupported_service'
  | 'profile_missing'
  | 'profile_disconnected'
  | 'group_missing'
  | 'group_generation_conflict'
  | 'provider_state_sharing_required'
  | 'provider_state_sharing_unavailable'
  | 'provider_session_state_unavailable_for_resume'
  | 'metadata_update_failed'
  | 'restart_failed'
  | 'hot_apply_failed'
  | 'bindings_rollback_failed'
  | 'post_switch_recovery_failed'
  | 'hot_apply_succeeded_but_recovery_failed'
  | 'profile_action_required';

export type SessionConnectedServiceAuthSwitchServiceResult = Readonly<{
  status: 'applied' | 'failed' | 'not_attempted';
  errorCode?: string;
}>;

export type SessionConnectedServiceAuthSwitchDiagnostics = Readonly<{
  failurePhase?: 'session_lookup' | 'agent_validation' | 'normalization' | 'continuity' | 'metadata' | 'restart' | 'hot_apply' | 'rollback' | 'post_switch_recovery';
  partialState?: 'metadata_may_reference_new_binding' | 'runtime_auth_applied' | 'runtime_auth_partially_applied';
  serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
  actionRequired?: Readonly<{
    kind: 'reconnect_profile' | 'profile_action_required';
    profileId: string;
    healthStatus?: ConnectedServiceCredentialHealthStatusV1;
  }>;
  accountSettingsFreshness?: Readonly<{
    requestedVersion: number | null;
    status: 'succeeded' | 'failed';
    error?: string;
  }>;
}>;

export type SessionConnectedServiceSwitchContinuity =
  | Readonly<{ mode: 'restart_rematerialize'; warnings?: readonly string[] }>
  | Readonly<{ mode: 'hot_apply'; warnings?: readonly string[] }>
  | Readonly<{
      mode: 'unsupported';
      errorCode: Extract<
        SessionConnectedServiceAuthSwitchErrorCode,
        | 'provider_state_sharing_required'
        | 'provider_state_sharing_unavailable'
        | 'provider_session_state_unavailable_for_resume'
        | 'unsupported_service'
      >;
      warnings?: readonly string[];
    }>;

export type SessionConnectedServiceAuthSwitchResult =
  | Readonly<{
      ok: true;
      action: 'unchanged' | 'restart_requested' | 'hot_applied' | 'metadata_updated';
      normalizedBindings: ConnectedServiceBindingsV1;
      continuityByServiceId: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>;
      warnings: readonly string[];
    }>
  | Readonly<{
      ok: false;
      errorCode: SessionConnectedServiceAuthSwitchErrorCode;
      serviceId?: string;
      continuityByServiceId?: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>;
      diagnostics?: SessionConnectedServiceAuthSwitchDiagnostics;
    }>;

function failureResult(
  errorCode: SessionConnectedServiceAuthSwitchErrorCode,
  options: Readonly<{
    serviceId?: string;
    continuityByServiceId?: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>;
    failurePhase?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['failurePhase']>;
    partialState?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['partialState']>;
    serviceResultsByServiceId?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['serviceResultsByServiceId']>;
    actionRequired?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['actionRequired']>;
  }> = {},
): SessionConnectedServiceAuthSwitchFailure {
  const diagnostics = options.failurePhase || options.partialState || options.serviceResultsByServiceId || options.actionRequired
    ? {
        ...(options.failurePhase ? { failurePhase: options.failurePhase } : {}),
        ...(options.partialState ? { partialState: options.partialState } : {}),
        ...(options.serviceResultsByServiceId ? { serviceResultsByServiceId: options.serviceResultsByServiceId } : {}),
        ...(options.actionRequired ? { actionRequired: options.actionRequired } : {}),
      }
    : undefined;
  return {
    ok: false,
    errorCode,
    ...(options.serviceId ? { serviceId: options.serviceId } : {}),
    ...(options.continuityByServiceId ? { continuityByServiceId: options.continuityByServiceId } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export type SessionConnectedServiceAuthSwitchRequest = Readonly<{
  sessionId: string;
  agentId: string;
  bindings: ConnectedServiceBindingsV1;
  rematerializeServiceId?: ConnectedServiceId;
  expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
  accountSettingsVersionHint?: number;
}>;

type ConnectedServiceProfilesApi = Readonly<{
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceCredentialHealthStatusV1;
    }>>;
  }>>;
  getConnectedServiceAuthGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null>;
}>;

type EffectiveBinding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>;
type ConnectedServiceGroupRuntimeMetadata = Readonly<{
  groupId: string;
  activeProfileId: string;
  fallbackProfileId: string;
  generation: number;
}>;
type ConnectedServiceAccountSwitchMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

export type SessionConnectedServiceRuntimeAuthSelectionMaterializerInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previous: EffectiveBinding | null;
  next: EffectiveBinding;
  previousBindings: ConnectedServiceBindingsV1;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadata?: ConnectedServiceGroupRuntimeMetadata;
}>;

type RuntimeAuthSelectionsByServiceId = ReadonlyMap<ConnectedServiceId, unknown>;
type PostSwitchRecoveryResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode?: string }>;

type SwitchContinuationRecoveryInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
}>;

export type SwitchSessionConnectedServiceAuthInput = Readonly<{
  core: ConnectedServiceSessionAuthSwitchCore;
  skipCoreLock?: boolean;
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  sessionEventReason?: string;
  getChildren: () => ReadonlyArray<TrackedSession>;
  resolveInactiveSession?(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    /** Session working directory — drives the source-aware resume-reachability probe at continuity. */
    cwd?: string | null;
    /** Persisted vendor session-file hint (provider-derived by the caller) — reachability fast path. */
    candidatePersistedSessionFile?: string | null;
  }> | null>;
  api: ConnectedServiceProfilesApi;
  resolveContinuity(input: Readonly<{
    tracked: TrackedSession | null;
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    previous: EffectiveBinding | null;
    next: EffectiveBinding;
    previousBindings: ConnectedServiceBindingsV1;
    normalizedBindings: ConnectedServiceBindingsV1;
    runtimeAuthSelection?: unknown;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    /**
     * For an INACTIVE switch (tracked=null) the daemon adapter cannot read cwd/target root from a
     * tracked session, so the switch forwards the inactive session's working directory and persisted
     * session-file hint here. The adapter uses them (plus the deterministic reconstructed materialized
     * root) to prove shared-state resume reachability instead of fail-closing a resumable session.
     */
    cwd?: string | null;
    candidatePersistedSessionFile?: string | null;
  }>): Promise<SessionConnectedServiceSwitchContinuity>;
  materializeRuntimeAuthSelection?(
    input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput,
  ): Promise<unknown | null>;
  restartSession(tracked: TrackedSession): Promise<void>;
  hotApply(input: Readonly<{
    tracked: TrackedSession;
    normalizedBindings: ConnectedServiceBindingsV1;
    serviceIds?: ReadonlySet<ConnectedServiceId>;
    runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  }>): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        errorCode?: string;
        serviceId?: string;
        serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
      }>
  >;
  recoverAfterRuntimeAuthSwitch?(input: Readonly<{
    tracked: TrackedSession;
    normalizedBindings: ConnectedServiceBindingsV1;
    serviceIds: ReadonlySet<ConnectedServiceId>;
    action: 'hot_applied' | 'restart_requested';
    runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  }>): Promise<PostSwitchRecoveryResult>;
  continueAfterRuntimeAuthSwitch?(input: SwitchContinuationRecoveryInput): Promise<void>;
  persistSessionBindings?(input: Readonly<{
    sessionId: string;
    normalizedBindings: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  }>): Promise<void>;
  isExpectedGroupGenerationCurrent?(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    expectedGeneration: number;
  }>): boolean;
  registerHotApplyTargets(tracked: TrackedSession): void;
  emitSessionEvent(sessionId: string, event: unknown): void;
  request: SessionConnectedServiceAuthSwitchRequest;
}>;

async function rollbackPersistedSessionBindings(input: Readonly<{
  persistSessionBindings: SwitchSessionConnectedServiceAuthInput['persistSessionBindings'];
  sessionId: string;
  previousBindings: ConnectedServiceBindingsV1;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<boolean> {
  if (!input.persistSessionBindings) return true;
  try {
    await input.persistSessionBindings({
      sessionId: input.sessionId,
      normalizedBindings: input.previousBindings,
      ...(input.connectedServiceMaterializationIdentityV1
        ? { connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1 }
        : {}),
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveTrackedVendorResumeId(tracked: TrackedSession): string | null {
  return readNonEmptyString(tracked.vendorResumeId)
    || readNonEmptyString(tracked.spawnOptions?.resume)
    || null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readGroupGeneration(value: unknown): number {
  return readNonNegativeInteger(value) ?? 0;
}

function resolveGroupFallbackProfileId(input: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  requestedFallbackProfileId?: string | null;
  activeProfileId: string;
}>): string {
  const requestedFallbackProfileId = readNonEmptyString(input.requestedFallbackProfileId);
  if (requestedFallbackProfileId) {
    const requestedFallbackMember = input.group.members.find((member) =>
      member.profileId === requestedFallbackProfileId && member.enabled !== false
    ) ?? null;
    if (requestedFallbackMember) return requestedFallbackProfileId;
  }
  return input.activeProfileId;
}

function findTrackedSession(children: ReadonlyArray<TrackedSession>, sessionId: string): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function resolveTrackedAgentId(tracked: TrackedSession): CatalogAgentId {
  const target = tracked.spawnOptions?.backendTarget;
  if (target?.kind === 'configuredAcpBackend') return 'customAcp';
  if (target?.kind === 'builtInAgent') {
    const agentId = AGENT_IDS.includes(target.agentId as AgentId) ? target.agentId as AgentId : null;
    return resolveCatalogAgentId(agentId);
  }
  return resolveCatalogAgentId(null);
}

function readExpectedGeneration(
  expectedByServiceId: Readonly<Record<string, number>> | undefined,
  serviceId: string,
): number | null {
  const value = expectedByServiceId?.[serviceId];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function findStaleExpectedGeneration(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  serviceIds: Iterable<ConnectedServiceId>;
  isExpectedGroupGenerationCurrent?: SwitchSessionConnectedServiceAuthInput['isExpectedGroupGenerationCurrent'];
}>): ConnectedServiceId | null {
  if (!input.isExpectedGroupGenerationCurrent) return null;
  for (const serviceId of input.serviceIds) {
    const expectedGeneration = readExpectedGeneration(input.request.expectedGroupGenerationByServiceId, serviceId);
    if (expectedGeneration === null) continue;
    if (!input.isExpectedGroupGenerationCurrent({
      sessionId: input.request.sessionId,
      serviceId,
      expectedGeneration,
    })) {
      return serviceId;
    }
  }
  return null;
}

function toEffectiveBinding(
  serviceId: ConnectedServiceId,
  binding: ConnectedServiceBinding | undefined,
): EffectiveBinding | null {
  if (!binding) return null;
  if (binding.source === 'native') {
    return {
      source: 'native',
      selection: 'native',
      serviceId,
      profileId: null,
      groupId: null,
    };
  }
  if (binding.selection === 'group') {
    return {
      source: 'connected',
      selection: 'group',
      serviceId,
      profileId: binding.profileId ?? null,
      groupId: binding.groupId,
    };
  }
  return {
    source: 'connected',
    selection: 'profile',
    serviceId,
    profileId: binding.profileId,
    groupId: null,
  };
}

function effectiveBindingChanged(previous: EffectiveBinding | null, next: EffectiveBinding): boolean {
  if (!previous) return next.source !== 'native';
  return previous?.source !== next.source
    || previous.selection !== next.selection
    || previous.profileId !== next.profileId
    || previous.groupId !== next.groupId;
}

function readHotApplyFailurePartialState(
  serviceResultsByServiceId: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>> | undefined,
): NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['partialState']> | undefined {
  if (!serviceResultsByServiceId) return undefined;
  return Object.values(serviceResultsByServiceId).some((result) => result.status === 'applied')
    ? 'runtime_auth_partially_applied'
    : undefined;
}

function hotApplyFailureRequiresRestart(input: Readonly<{
  errorCode?: string;
  serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
}>): boolean {
  const serviceResults = Object.values(input.serviceResultsByServiceId ?? {});
  if (input.errorCode === 'hot_apply_restart_required') return true;
  if (input.errorCode === 'hot_apply_unavailable') {
    return serviceResults.length === 0 || !serviceResults.some((result) => result.status === 'applied');
  }
  if (serviceResults.some((result) => (
    result.errorCode === 'hot_apply_restart_required'
  ))) {
    return true;
  }

  if (input.errorCode !== 'hot_apply_failed') return false;
  if (serviceResults.length === 0) return true;
  return !serviceResults.some((result) => result.status === 'applied')
    && serviceResults.every((result) => (
      result.status !== 'failed' || result.errorCode === 'hot_apply_failed'
    ));
}

function markHotApplyContinuityAsRestart(
  continuityByServiceId: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>,
): Record<string, SessionConnectedServiceSwitchContinuity['mode']> {
  return Object.fromEntries(
    Object.entries(continuityByServiceId).map(([serviceId, mode]) => [
      serviceId,
      mode === 'hot_apply' ? 'restart_rematerialize' : mode,
    ]),
  );
}

function buildConnectedServiceChildSelection(input: Readonly<{
  serviceId: ConnectedServiceId;
  binding: Extract<ConnectedServiceBinding, Readonly<{ source: 'connected' }>>;
  runtimeAuthSelection?: unknown;
  previousSelection?: ConnectedServiceChildSelection;
  groupMetadata?: ConnectedServiceGroupRuntimeMetadata;
}>): ConnectedServiceChildSelection | null {
  if (input.binding.selection === 'profile') {
    return {
      kind: 'profile',
      serviceId: input.serviceId,
      profileId: input.binding.profileId,
    };
  }

  const runtimeAuthSelection = readRecord(input.runtimeAuthSelection);
  const previousGroupSelection = input.previousSelection?.kind === 'group'
    ? input.previousSelection
    : null;
  const groupMetadata = input.groupMetadata?.groupId === input.binding.groupId ? input.groupMetadata : null;
  const groupId = readNonEmptyString(runtimeAuthSelection?.groupId)
    || groupMetadata?.groupId
    || input.binding.groupId;
  const activeProfileId = readNonEmptyString(
    runtimeAuthSelection?.activeProfileId ?? runtimeAuthSelection?.profileId,
  ) || groupMetadata?.activeProfileId || input.binding.profileId;
  if (!groupId || !activeProfileId) return null;

  return {
    kind: 'group',
    serviceId: input.serviceId,
    groupId,
    activeProfileId,
    fallbackProfileId: readNonEmptyString(runtimeAuthSelection?.fallbackProfileId)
      || groupMetadata?.fallbackProfileId
      || previousGroupSelection?.fallbackProfileId
      || activeProfileId,
    generation: readNonNegativeInteger(runtimeAuthSelection?.generation)
      ?? groupMetadata?.generation
      ?? previousGroupSelection?.generation
      ?? 0,
  };
}

function buildTrackedSessionEnvironmentVariables(input: Readonly<{
  existingEnvironmentVariables?: Record<string, string>;
  normalizedBindings: ConnectedServiceBindingsV1;
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  groupMetadataByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
}>): Record<string, string> | undefined {
  const environmentVariables = input.existingEnvironmentVariables
    ? { ...input.existingEnvironmentVariables }
    : {};
  const previousSelectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceChildSelection>(
    readConnectedServiceChildSelectionsFromEnv(environmentVariables).map((selection) => [selection.serviceId, selection]),
  );
  const nextSelections: ConnectedServiceChildSelection[] = [];

  for (const [serviceIdRaw, binding] of Object.entries(input.normalizedBindings.bindingsByServiceId)) {
    if (binding.source !== 'connected') continue;
    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!serviceIdParsed.success) continue;
    const nextSelection = buildConnectedServiceChildSelection({
      serviceId: serviceIdParsed.data,
      binding,
      runtimeAuthSelection: input.runtimeAuthSelectionsByServiceId?.get(serviceIdParsed.data),
      previousSelection: previousSelectionsByServiceId.get(serviceIdParsed.data),
      groupMetadata: input.groupMetadataByServiceId?.get(serviceIdParsed.data),
    });
    if (nextSelection) {
      nextSelections.push(nextSelection);
    }
  }

  if (nextSelections.length > 0) {
    environmentVariables[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify(nextSelections);
  } else {
    delete environmentVariables[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  }

  return Object.keys(environmentVariables).length > 0 ? environmentVariables : undefined;
}

async function validateConnectedProfile(input: Readonly<{
  api: ConnectedServiceProfilesApi;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  const profiles = await input.api.listConnectedServiceProfiles({ serviceId: input.serviceId });
  const profile = profiles.profiles.find((candidate) => candidate.profileId === input.profileId) ?? null;
  if (!profile) {
    return { ok: false, errorCode: 'profile_missing', serviceId: input.serviceId };
  }
  if (profile.status === 'needs_reauth') {
    return failureResult('profile_action_required', {
      serviceId: input.serviceId,
      failurePhase: 'normalization',
      actionRequired: {
        kind: 'reconnect_profile',
        profileId: input.profileId,
        healthStatus: profile.status,
      },
    });
  }
  if (profile.status !== 'connected') {
    return { ok: false, errorCode: 'profile_disconnected', serviceId: input.serviceId };
  }
  return null;
}

async function normalizeRequestedBindings(input: Readonly<{
  api: ConnectedServiceProfilesApi;
  agentId: CatalogAgentId;
  request: SessionConnectedServiceAuthSwitchRequest;
}>): Promise<
  | Readonly<{
      ok: true;
      normalized: ConnectedServiceBindingsV1;
      effectiveByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
      groupMetadataByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
    }>
  | SessionConnectedServiceAuthSwitchFailure
> {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(input.request.bindings);
  if (!parsed.success) {
    return { ok: false, errorCode: 'unsupported_service' };
  }

  const effectiveByServiceId = new Map<ConnectedServiceId, EffectiveBinding>();
  const groupMetadataByServiceId = new Map<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>();
  const normalizedBindingsByServiceId: ConnectedServiceBindingsV1['bindingsByServiceId'] = {};

  for (const [serviceIdRaw, binding] of Object.entries(parsed.data.bindingsByServiceId)) {
    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!serviceIdParsed.success) {
      return { ok: false, errorCode: 'unsupported_service', serviceId: serviceIdRaw };
    }
    const serviceId = serviceIdParsed.data;
    const agent = (AGENTS_CORE as Partial<Record<CatalogAgentId, AgentConnectedServiceSupport>>)[input.agentId] ?? null;
    const supportedServiceIds = agent?.connectedServices?.supportedServiceIds ?? [];
    if (!supportedServiceIds.includes(serviceId)) {
      return { ok: false, errorCode: 'unsupported_service', serviceId };
    }
    if (binding.source === 'native') {
      normalizedBindingsByServiceId[serviceId] = { source: 'native' };
      effectiveByServiceId.set(serviceId, {
        source: 'native',
        selection: 'native',
        serviceId,
        profileId: null,
        groupId: null,
      });
      continue;
    }

    if (binding.selection === 'group') {
      const group = await input.api.getConnectedServiceAuthGroup({
        serviceId,
        groupId: binding.groupId,
      });
      if (!group) {
        return { ok: false, errorCode: 'group_missing', serviceId };
      }
      const expectedGeneration = readExpectedGeneration(input.request.expectedGroupGenerationByServiceId, serviceId);
      if (expectedGeneration !== null && expectedGeneration !== group.generation) {
        return { ok: false, errorCode: 'group_generation_conflict', serviceId };
      }
      const activeProfileId = typeof group.activeProfileId === 'string' ? group.activeProfileId.trim() : '';
      if (!activeProfileId) {
        return { ok: false, errorCode: 'profile_missing', serviceId };
      }
      const fallbackProfileId = resolveGroupFallbackProfileId({
        group,
        requestedFallbackProfileId: binding.profileId,
        activeProfileId,
      });
      const profileError = await validateConnectedProfile({
        api: input.api,
        serviceId,
        profileId: activeProfileId,
      });
      if (profileError) return profileError;
      if (fallbackProfileId !== activeProfileId) {
        const fallbackProfileError = await validateConnectedProfile({
          api: input.api,
          serviceId,
          profileId: fallbackProfileId,
        });
        if (fallbackProfileError) return fallbackProfileError;
      }

      normalizedBindingsByServiceId[serviceId] = {
        source: 'connected',
        selection: 'group',
        groupId: binding.groupId,
        profileId: activeProfileId,
      };
      groupMetadataByServiceId.set(serviceId, {
        groupId: binding.groupId,
        activeProfileId,
        fallbackProfileId,
        generation: readGroupGeneration(group.generation),
      });
      effectiveByServiceId.set(serviceId, {
        source: 'connected',
        selection: 'group',
        serviceId,
        profileId: activeProfileId,
        groupId: binding.groupId,
      });
      continue;
    }

    const profileError = await validateConnectedProfile({
      api: input.api,
      serviceId,
      profileId: binding.profileId,
    });
    if (profileError) return profileError;
    normalizedBindingsByServiceId[serviceId] = {
      source: 'connected',
      selection: 'profile',
      profileId: binding.profileId,
    };
    effectiveByServiceId.set(serviceId, {
      source: 'connected',
      selection: 'profile',
      serviceId,
      profileId: binding.profileId,
      groupId: null,
    });
  }

  return {
    ok: true,
    normalized: {
      v: 1,
      bindingsByServiceId: normalizedBindingsByServiceId,
    },
    effectiveByServiceId,
    groupMetadataByServiceId,
  };
}

function previousEffectiveBindings(raw: unknown): ReadonlyMap<ConnectedServiceId, EffectiveBinding> {
  const parsed = readConnectedServiceBindingsOrEmpty(raw);
  const out = new Map<ConnectedServiceId, EffectiveBinding>();
  for (const [serviceIdRaw, binding] of Object.entries(parsed.bindingsByServiceId)) {
    const serviceId = serviceIdRaw as ConnectedServiceId;
    const effective = toEffectiveBinding(serviceId, binding);
    if (effective) out.set(serviceId, effective);
  }
  return out;
}

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 1, bindingsByServiceId: {} };
}

function bindingsRequireMaterializationIdentity(bindings: ConnectedServiceBindingsV1): boolean {
  return Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

function resolveMaterializationIdentityForAcceptedBindings(input: Readonly<{
  existingIdentity: unknown;
  normalizedBindings: ConnectedServiceBindingsV1;
}>): ConnectedServiceMaterializationIdentityV1 | null {
  const existing = readConnectedServiceMaterializationIdentityV1(input.existingIdentity);
  if (existing) return existing;
  return bindingsRequireMaterializationIdentity(input.normalizedBindings)
    ? createConnectedServiceMaterializationIdentity()
    : null;
}

function resolveNextEffectiveBindings(input: Readonly<{
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  requestedByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
}>): ReadonlyMap<ConnectedServiceId, EffectiveBinding> {
  const out = new Map(input.requestedByServiceId);
  for (const [serviceId, previous] of input.previousByServiceId.entries()) {
    if (out.has(serviceId)) continue;
    out.set(serviceId, {
      source: 'native',
      selection: 'native',
      serviceId,
      profileId: null,
      groupId: null,
    });
  }
  return out;
}

function emitManualSwitchEvents(input: Readonly<{
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  reason: string;
  mode: ConnectedServiceAccountSwitchMode;
}>): void {
  for (const [serviceId, next] of input.nextByServiceId.entries()) {
    const previous = input.previousByServiceId.get(serviceId) ?? null;
    if (!effectiveBindingChanged(previous, next)) continue;
    input.emitSessionEvent(input.sessionId, {
      type: 'connected_service_account_switch',
      serviceId,
      groupId: next.groupId ?? previous?.groupId ?? null,
      fromProfileId: previous?.profileId ?? null,
      toProfileId: next.profileId,
      reason: input.reason,
      mode: input.mode,
    });
  }
}

const SWITCH_ATTEMPT_FAILURE_ERROR_CODES = new Set<SessionConnectedServiceAuthSwitchErrorCode>([
  'unsupported_service',
  'profile_missing',
  'profile_disconnected',
  'group_missing',
  'group_generation_conflict',
  'provider_state_sharing_required',
  'provider_state_sharing_unavailable',
  'provider_session_state_unavailable_for_resume',
  'profile_action_required',
  'metadata_update_failed',
  'restart_failed',
  'hot_apply_failed',
  'bindings_rollback_failed',
  'post_switch_recovery_failed',
  'hot_apply_succeeded_but_recovery_failed',
]);

type SwitchAttemptEventAction = 'restart_requested' | 'hot_applied' | 'metadata_updated';

function resolveSwitchAttemptEventActionFromFailure(
  result: Extract<SessionConnectedServiceAuthSwitchResult, Readonly<{ ok: false }>>,
): SwitchAttemptEventAction {
  if (result.errorCode === 'hot_apply_succeeded_but_recovery_failed' || result.errorCode === 'hot_apply_failed') {
    return 'hot_applied';
  }
  const continuityModes = Object.values(result.continuityByServiceId ?? {});
  if (continuityModes.length > 0 && continuityModes.every((mode) => mode === 'hot_apply')) {
    return 'hot_applied';
  }
  return 'restart_requested';
}

function emitConnectedServiceSwitchAttemptEvent(input: Readonly<{
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  result: SessionConnectedServiceAuthSwitchResult;
}>): void {
  if (input.result.ok) {
    if (input.result.action === 'unchanged') return;
    input.emitSessionEvent(input.sessionId, {
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: input.result.action,
      errorCode: null,
      partialState: null,
    });
    return;
  }

  if (!SWITCH_ATTEMPT_FAILURE_ERROR_CODES.has(input.result.errorCode)) return;
  input.emitSessionEvent(input.sessionId, {
    type: 'connected_service_account_switch_attempt',
    ok: false,
    action: resolveSwitchAttemptEventActionFromFailure(input.result),
    errorCode: input.result.errorCode,
    partialState: input.result.diagnostics?.partialState ?? null,
  });
}

function readMaterializationDiagnostics(raw: unknown): readonly ConnectedServicesMaterializationDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const code = readNonEmptyString(record.code);
    const providerId = readNonEmptyString(record.providerId);
    if (!code || !providerId) return [];
    const serviceIdParsed = record.serviceId === undefined
      ? null
      : ConnectedServiceIdSchema.safeParse(record.serviceId);
    const serviceId = serviceIdParsed?.success ? serviceIdParsed.data : undefined;
    const requestedStateMode = readNonEmptyString(record.requestedStateMode) || undefined;
    const effectiveStateMode = readNonEmptyString(record.effectiveStateMode) || undefined;
    const entryName = readNonEmptyString(record.entryName) || undefined;
    const reason = readNonEmptyString(record.reason) || undefined;
    return [{
      code,
      providerId: providerId as CatalogAgentId,
      ...(serviceId ? { serviceId } : {}),
      ...(requestedStateMode ? { requestedStateMode } : {}),
      ...(effectiveStateMode ? { effectiveStateMode } : {}),
      ...(entryName ? { entryName } : {}),
      ...(reason ? { reason } : {}),
    }];
  });
}

function emitProviderStateSharingDegradedEvents(input: Readonly<{
  tracked: TrackedSession | null;
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  result: SessionConnectedServiceAuthSwitchResult;
}>): void {
  if (!input.tracked || !input.result.ok || input.result.action === 'unchanged') return;
  const diagnostics = readMaterializationDiagnostics(
    input.tracked.spawnOptions?.materializationDiagnostics,
  );
  for (const diagnostic of diagnostics) {
    const requestedStateMode = readNonEmptyString(diagnostic.requestedStateMode);
    const effectiveStateMode = readNonEmptyString(diagnostic.effectiveStateMode);
    if (!requestedStateMode || !effectiveStateMode || requestedStateMode === effectiveStateMode) continue;
    if (!diagnostic.serviceId) continue;
    input.emitSessionEvent(input.sessionId, {
      type: 'provider_state_sharing_degraded',
      serviceId: diagnostic.serviceId,
      requestedStateMode,
      effectiveStateMode,
      code: diagnostic.code,
      ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
      ...(diagnostic.entryName ? { entryName: diagnostic.entryName } : {}),
    });
  }
}

async function runPostSwitchRecovery(input: Readonly<{
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  tracked: TrackedSession;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  if (!input.recoverAfterRuntimeAuthSwitch) return null;
  try {
    const result = await input.recoverAfterRuntimeAuthSwitch({
      tracked: input.tracked,
      normalizedBindings: input.normalizedBindings,
      serviceIds: input.serviceIds,
      action: input.action,
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    if (result.ok) return null;
  } catch {
    // Shape provider recovery errors through the same typed partial result.
  }
  return failureResult(input.action === 'hot_applied'
    ? 'hot_apply_succeeded_but_recovery_failed'
    : 'post_switch_recovery_failed', {
    failurePhase: 'post_switch_recovery',
    partialState: 'runtime_auth_applied',
  });
}

function buildContinuationAttemptId(input: Readonly<{
  action: 'hot_applied' | 'restart_requested';
  serviceIds: ReadonlySet<ConnectedServiceId>;
  normalizedBindings: ConnectedServiceBindingsV1;
  expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
}>): string {
  const parts = [...input.serviceIds]
    .sort()
    .map((serviceId) => {
      const binding = input.normalizedBindings.bindingsByServiceId[serviceId];
      if (!binding || binding.source !== 'connected') return `${serviceId}:native`;
      if (binding.selection === 'group') {
        const generation = input.expectedGroupGenerationByServiceId?.[serviceId];
        return [
          serviceId,
          'group',
          binding.groupId,
          binding.profileId ?? '',
          typeof generation === 'number' ? String(generation) : '',
        ].join(':');
      }
      return [serviceId, 'profile', binding.profileId].join(':');
    });
  return ['connected-service-auth-switch', input.action, ...parts].join('|');
}

async function runContinuationRecovery(input: SwitchContinuationRecoveryInput & Readonly<{
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  if (!input.continueAfterRuntimeAuthSwitch) return null;
  try {
    await input.continueAfterRuntimeAuthSwitch({
      tracked: input.tracked,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      normalizedBindings: input.normalizedBindings,
      serviceIds: input.serviceIds,
      action: input.action,
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    return null;
  } catch {
    return failureResult('post_switch_recovery_failed', {
      failurePhase: 'post_switch_recovery',
      partialState: 'runtime_auth_applied',
    });
  }
}

async function maybeMaterializeRuntimeAuthSelection(input: Readonly<{
  materializeRuntimeAuthSelection: SwitchSessionConnectedServiceAuthInput['materializeRuntimeAuthSelection'];
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previous: EffectiveBinding | null;
  next: EffectiveBinding;
  previousBindings: ConnectedServiceBindingsV1;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadataByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
}>): Promise<unknown | null> {
  if (!input.materializeRuntimeAuthSelection || input.next.source !== 'connected') return null;
  return await input.materializeRuntimeAuthSelection({
    tracked: input.tracked,
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceId: input.serviceId,
    previous: input.previous,
    next: input.next,
    previousBindings: input.previousBindings,
    normalizedBindings: input.normalizedBindings,
    groupMetadata: input.groupMetadataByServiceId?.get(input.serviceId),
  });
}

async function rematerializeUnchangedConnectedServiceBinding(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  tracked: TrackedSession;
  trackedAgentId: CatalogAgentId;
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadataByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
  resolveContinuity: SwitchSessionConnectedServiceAuthInput['resolveContinuity'];
  materializeRuntimeAuthSelection: SwitchSessionConnectedServiceAuthInput['materializeRuntimeAuthSelection'];
  restartSession: SwitchSessionConnectedServiceAuthInput['restartSession'];
  hotApply: SwitchSessionConnectedServiceAuthInput['hotApply'];
  persistSessionBindings: SwitchSessionConnectedServiceAuthInput['persistSessionBindings'];
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  isExpectedGroupGenerationCurrent: SwitchSessionConnectedServiceAuthInput['isExpectedGroupGenerationCurrent'];
  registerHotApplyTargets: SwitchSessionConnectedServiceAuthInput['registerHotApplyTargets'];
}>): Promise<SessionConnectedServiceAuthSwitchResult | null> {
  const serviceId = input.request.rematerializeServiceId;
  if (!serviceId) return null;

  const next = input.nextByServiceId.get(serviceId);
  if (!next || next.source !== 'connected') {
    return {
      ok: true,
      action: 'unchanged',
      normalizedBindings: input.normalizedBindings,
      continuityByServiceId: {},
      warnings: [],
    };
  }

  const previous = input.previousByServiceId.get(serviceId) ?? null;
  const previousBindings = readConnectedServiceBindingsOrEmpty(input.tracked.spawnOptions?.connectedServices);
  const runtimeAuthSelection = await maybeMaterializeRuntimeAuthSelection({
    materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
    tracked: input.tracked,
    sessionId: input.request.sessionId,
    agentId: input.trackedAgentId,
    serviceId,
    previous,
    next,
    previousBindings,
    normalizedBindings: input.normalizedBindings,
    groupMetadataByServiceId: input.groupMetadataByServiceId,
  });
  const previousSpawnOptions = input.tracked.spawnOptions;
  const connectedServiceMaterializationIdentityV1 = resolveMaterializationIdentityForAcceptedBindings({
    existingIdentity: previousSpawnOptions?.connectedServiceMaterializationIdentityV1,
    normalizedBindings: input.normalizedBindings,
  });
  const trackedVendorResumeId = resolveTrackedVendorResumeId(input.tracked);
  const continuity = await input.resolveContinuity({
    tracked: input.tracked,
    sessionId: input.request.sessionId,
    agentId: input.trackedAgentId,
    serviceId,
    previous,
    next,
    previousBindings,
    normalizedBindings: input.normalizedBindings,
    ...(runtimeAuthSelection === null || runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
    ...(connectedServiceMaterializationIdentityV1 ? { connectedServiceMaterializationIdentityV1 } : {}),
    ...(trackedVendorResumeId ? { vendorResumeId: trackedVendorResumeId } : {}),
  });
  if (continuity.mode === 'unsupported') {
    return failureResult(continuity.errorCode, { serviceId, failurePhase: 'continuity' });
  }

  const runtimeAuthSelectionsByServiceId = runtimeAuthSelection === null || runtimeAuthSelection === undefined
    ? undefined
    : new Map([[serviceId, runtimeAuthSelection]]);
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);
  const continuationAttemptId = buildContinuationAttemptId({
    action: continuity.mode === 'hot_apply' ? 'hot_applied' : 'restart_requested',
    serviceIds,
    normalizedBindings: input.normalizedBindings,
    expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
  });
  const nextEnvironmentVariables = buildTrackedSessionEnvironmentVariables({
    existingEnvironmentVariables: previousSpawnOptions?.environmentVariables,
    normalizedBindings: input.normalizedBindings,
    runtimeAuthSelectionsByServiceId,
    groupMetadataByServiceId: input.groupMetadataByServiceId,
  });
  const staleServiceId = findStaleExpectedGeneration({
    request: input.request,
    serviceIds,
    isExpectedGroupGenerationCurrent: input.isExpectedGroupGenerationCurrent,
  });
  if (staleServiceId) return { ok: false, errorCode: 'group_generation_conflict', serviceId: staleServiceId };
  input.tracked.spawnOptions = {
    ...(input.tracked.spawnOptions ?? { directory: '' }),
    connectedServices: input.normalizedBindings,
    connectedServicesUpdatedAt: Date.now(),
    ...(connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1 }
      : {}),
    environmentVariables: nextEnvironmentVariables,
  };

  try {
    if (
      connectedServiceMaterializationIdentityV1
      && !readConnectedServiceMaterializationIdentityV1(previousSpawnOptions?.connectedServiceMaterializationIdentityV1)
    ) {
      try {
        await input.persistSessionBindings?.({
          sessionId: input.request.sessionId,
          normalizedBindings: input.normalizedBindings,
          connectedServiceMaterializationIdentityV1,
        });
      } catch {
        input.tracked.spawnOptions = previousSpawnOptions;
        return failureResult('metadata_update_failed', { failurePhase: 'metadata' });
      }
    }
    if (continuity.mode === 'hot_apply') {
      let hotApplyResult: Awaited<ReturnType<SwitchSessionConnectedServiceAuthInput['hotApply']>>;
      try {
        hotApplyResult = await input.hotApply({
          tracked: input.tracked,
          normalizedBindings: input.normalizedBindings,
          serviceIds: new Set([serviceId]),
          ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
        });
      } catch {
        hotApplyResult = {
          ok: false,
          errorCode: 'hot_apply_failed',
        };
      }
      if (!hotApplyResult.ok) {
        if (hotApplyFailureRequiresRestart(hotApplyResult)) {
          try {
            await input.restartSession(input.tracked);
          } catch {
            input.tracked.spawnOptions = previousSpawnOptions;
            return failureResult('restart_failed', { failurePhase: 'restart' });
          }
          const restartServiceIds = new Set([serviceId]);
          const restartContinuationAttemptId = buildContinuationAttemptId({
            action: 'restart_requested',
            serviceIds: restartServiceIds,
            normalizedBindings: input.normalizedBindings,
            expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
          });
          const recoveryFailure = await runPostSwitchRecovery({
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
            tracked: input.tracked,
            normalizedBindings: input.normalizedBindings,
            serviceIds: restartServiceIds,
            action: 'restart_requested',
            ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
          });
          if (recoveryFailure) return recoveryFailure;
          const continuationFailure = await runContinuationRecovery({
            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
            tracked: input.tracked,
            sessionId: input.request.sessionId,
            attemptId: restartContinuationAttemptId,
            normalizedBindings: input.normalizedBindings,
            serviceIds: restartServiceIds,
            action: 'restart_requested',
            ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
          });
          if (continuationFailure) return continuationFailure;
          return {
            ok: true,
            action: 'restart_requested',
            normalizedBindings: input.normalizedBindings,
            continuityByServiceId: { [serviceId]: 'restart_rematerialize' },
            warnings: continuity.warnings ?? [],
          };
        }
        input.tracked.spawnOptions = previousSpawnOptions;
        return failureResult('hot_apply_failed', {
          serviceId: hotApplyResult.serviceId ?? serviceId,
          continuityByServiceId: { [serviceId]: continuity.mode },
          failurePhase: 'hot_apply',
          partialState: readHotApplyFailurePartialState(hotApplyResult.serviceResultsByServiceId),
          serviceResultsByServiceId: hotApplyResult.serviceResultsByServiceId,
        });
      }
      input.registerHotApplyTargets(input.tracked);
      const recoveryFailure = await runPostSwitchRecovery({
        recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
        tracked: input.tracked,
        normalizedBindings: input.normalizedBindings,
        serviceIds,
        action: 'hot_applied',
        ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
      });
      if (recoveryFailure) return recoveryFailure;
      const continuationFailure = await runContinuationRecovery({
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
        tracked: input.tracked,
        sessionId: input.request.sessionId,
        attemptId: continuationAttemptId,
        normalizedBindings: input.normalizedBindings,
        serviceIds,
        action: 'hot_applied',
        ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
      });
      if (continuationFailure) return continuationFailure;
      return {
        ok: true,
        action: 'hot_applied',
        normalizedBindings: input.normalizedBindings,
        continuityByServiceId: { [serviceId]: continuity.mode },
        warnings: continuity.warnings ?? [],
      };
    }

    await input.restartSession(input.tracked);
    const recoveryFailure = await runPostSwitchRecovery({
      recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
      tracked: input.tracked,
      normalizedBindings: input.normalizedBindings,
      serviceIds,
      action: 'restart_requested',
      ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
    });
    if (recoveryFailure) return recoveryFailure;
    const continuationFailure = await runContinuationRecovery({
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
      tracked: input.tracked,
      sessionId: input.request.sessionId,
      attemptId: continuationAttemptId,
      normalizedBindings: input.normalizedBindings,
      serviceIds,
      action: 'restart_requested',
      ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
    });
    if (continuationFailure) return continuationFailure;
    return {
      ok: true,
      action: 'restart_requested',
      normalizedBindings: input.normalizedBindings,
      continuityByServiceId: { [serviceId]: continuity.mode },
      warnings: continuity.warnings ?? [],
    };
  } catch {
    input.tracked.spawnOptions = previousSpawnOptions;
    return failureResult(
      continuity.mode === 'hot_apply' ? 'hot_apply_failed' : 'restart_failed',
      { failurePhase: continuity.mode === 'hot_apply' ? 'hot_apply' : 'restart' },
    );
  }
}

export async function switchSessionConnectedServiceAuth(
  input: SwitchSessionConnectedServiceAuthInput,
): Promise<SessionConnectedServiceAuthSwitchResult> {
  const execute = async (): Promise<SessionConnectedServiceAuthSwitchResult> => {
      const tracked = findTrackedSession(input.getChildren(), input.request.sessionId);
      if (!tracked) {
        const inactive = await input.resolveInactiveSession?.({ sessionId: input.request.sessionId }) ?? null;
        if (!inactive) return { ok: false, errorCode: 'session_not_found' };
        if (input.request.agentId.trim() !== inactive.agentId) {
          return { ok: false, errorCode: 'agent_mismatch' };
        }

        const normalized = await normalizeRequestedBindings({
          api: input.api,
          agentId: inactive.agentId,
          request: input.request,
        });
        if (!normalized.ok) return normalized;

        const previousByServiceId = previousEffectiveBindings(inactive.connectedServices);
        const previousBindings = readConnectedServiceBindingsOrEmpty(inactive.connectedServices);
        const nextByServiceId = resolveNextEffectiveBindings({
          previousByServiceId,
          requestedByServiceId: normalized.effectiveByServiceId,
        });
        const changedServiceIds = Array.from(nextByServiceId.entries())
          .filter(([serviceId, next]) => effectiveBindingChanged(previousByServiceId.get(serviceId) ?? null, next))
          .map(([serviceId]) => serviceId);

        if (changedServiceIds.length === 0) {
          return {
            ok: true,
            action: 'unchanged',
            normalizedBindings: normalized.normalized,
            continuityByServiceId: {},
            warnings: [],
          };
        }

        const continuityByServiceId: Record<string, SessionConnectedServiceSwitchContinuity['mode']> = {};
        const warnings: string[] = [];
        const connectedServiceMaterializationIdentityV1 = resolveMaterializationIdentityForAcceptedBindings({
          existingIdentity: inactive.connectedServiceMaterializationIdentityV1,
          normalizedBindings: normalized.normalized,
        });
        for (const serviceId of changedServiceIds) {
          const next = nextByServiceId.get(serviceId);
          if (!next) continue;
          const continuity = await input.resolveContinuity({
            tracked: null,
            sessionId: input.request.sessionId,
            agentId: inactive.agentId,
            serviceId,
            previous: previousByServiceId.get(serviceId) ?? null,
            next,
            previousBindings,
            normalizedBindings: normalized.normalized,
            ...(connectedServiceMaterializationIdentityV1
              ? { connectedServiceMaterializationIdentityV1 }
              : {}),
            ...(typeof inactive.vendorResumeId === 'string' && inactive.vendorResumeId.trim()
              ? { vendorResumeId: inactive.vendorResumeId.trim() }
              : {}),
            // Inactive switch (tracked=null): forward the session cwd + persisted hint so the daemon
            // adapter can reconstruct the target materialized root and prove resume reachability.
            ...(typeof inactive.cwd === 'string' && inactive.cwd.trim()
              ? { cwd: inactive.cwd.trim() }
              : {}),
            ...(typeof inactive.candidatePersistedSessionFile === 'string' && inactive.candidatePersistedSessionFile.trim()
              ? { candidatePersistedSessionFile: inactive.candidatePersistedSessionFile.trim() }
              : {}),
          });
          continuityByServiceId[serviceId] = continuity.mode;
          warnings.push(...(continuity.warnings ?? []));
          if (continuity.mode === 'unsupported') {
            return failureResult(continuity.errorCode, { serviceId, failurePhase: 'continuity' });
          }
        }

        const staleServiceId = findStaleExpectedGeneration({
          request: input.request,
          serviceIds: changedServiceIds,
          isExpectedGroupGenerationCurrent: input.isExpectedGroupGenerationCurrent,
        });
        if (staleServiceId) {
          return { ok: false, errorCode: 'group_generation_conflict', serviceId: staleServiceId };
        }

        try {
          await input.persistSessionBindings?.({
            sessionId: input.request.sessionId,
            normalizedBindings: normalized.normalized,
            ...(connectedServiceMaterializationIdentityV1
              ? { connectedServiceMaterializationIdentityV1 }
              : {}),
          });
        } catch {
          return failureResult('metadata_update_failed', { failurePhase: 'metadata' });
        }

        emitManualSwitchEvents({
          emitSessionEvent: input.emitSessionEvent,
          sessionId: input.request.sessionId,
          previousByServiceId,
          nextByServiceId,
          reason: input.sessionEventReason ?? 'manual',
          mode: 'spawn_next_turn',
        });

        return {
          ok: true,
          action: 'metadata_updated',
          normalizedBindings: normalized.normalized,
          continuityByServiceId,
          warnings,
        };
      }

      const trackedAgentId = resolveTrackedAgentId(tracked);
      if (input.request.agentId.trim() !== trackedAgentId) {
        return { ok: false, errorCode: 'agent_mismatch' };
      }

      const normalized = await normalizeRequestedBindings({
        api: input.api,
        agentId: trackedAgentId,
        request: input.request,
      });
      if (!normalized.ok) return normalized;

      const previousBindings = readConnectedServiceBindingsOrEmpty(tracked.spawnOptions?.connectedServices);
      const previousByServiceId = previousEffectiveBindings(previousBindings);
      const nextByServiceId = resolveNextEffectiveBindings({
        previousByServiceId,
        requestedByServiceId: normalized.effectiveByServiceId,
      });
      const changedServiceIds = Array.from(nextByServiceId.entries())
        .filter(([serviceId, next]) => effectiveBindingChanged(previousByServiceId.get(serviceId) ?? null, next))
        .map(([serviceId]) => serviceId);

      if (changedServiceIds.length === 0) {
        const rematerialized = await rematerializeUnchangedConnectedServiceBinding({
          request: input.request,
          tracked,
          trackedAgentId,
          previousByServiceId,
          nextByServiceId,
          normalizedBindings: normalized.normalized,
          groupMetadataByServiceId: normalized.groupMetadataByServiceId,
          resolveContinuity: input.resolveContinuity,
          materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
          restartSession: input.restartSession,
          hotApply: input.hotApply,
          persistSessionBindings: input.persistSessionBindings,
          recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
          continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
          isExpectedGroupGenerationCurrent: input.isExpectedGroupGenerationCurrent,
          registerHotApplyTargets: input.registerHotApplyTargets,
        });
        if (rematerialized) return rematerialized;
        return {
          ok: true,
          action: 'unchanged',
          normalizedBindings: normalized.normalized,
          continuityByServiceId: {},
          warnings: [],
        };
      }

      const continuityByServiceId: Record<string, SessionConnectedServiceSwitchContinuity['mode']> = {};
      const warnings: string[] = [];
      let allChangedServicesHotApply = true;
      const runtimeAuthSelectionsByServiceId = new Map<ConnectedServiceId, unknown>();
      const previousSpawnOptions = tracked.spawnOptions;
      const connectedServiceMaterializationIdentityV1 = resolveMaterializationIdentityForAcceptedBindings({
        existingIdentity: previousSpawnOptions?.connectedServiceMaterializationIdentityV1,
        normalizedBindings: normalized.normalized,
      });
      const trackedVendorResumeId = resolveTrackedVendorResumeId(tracked);
      for (const serviceId of changedServiceIds) {
        const next = nextByServiceId.get(serviceId);
        if (!next) continue;
        const previous = previousByServiceId.get(serviceId) ?? null;
        const runtimeAuthSelection = await maybeMaterializeRuntimeAuthSelection({
          materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
          tracked,
          sessionId: input.request.sessionId,
          agentId: trackedAgentId,
          serviceId,
          previous,
          next,
          previousBindings,
          normalizedBindings: normalized.normalized,
          groupMetadataByServiceId: normalized.groupMetadataByServiceId,
        });
        if (runtimeAuthSelection !== null && runtimeAuthSelection !== undefined) {
          runtimeAuthSelectionsByServiceId.set(serviceId, runtimeAuthSelection);
        }
        const continuity = await input.resolveContinuity({
          tracked,
          sessionId: input.request.sessionId,
          agentId: trackedAgentId,
          serviceId,
          previous,
          next,
          previousBindings,
          normalizedBindings: normalized.normalized,
          ...(runtimeAuthSelection === null || runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
          ...(connectedServiceMaterializationIdentityV1 ? { connectedServiceMaterializationIdentityV1 } : {}),
          ...(trackedVendorResumeId ? { vendorResumeId: trackedVendorResumeId } : {}),
        });
        continuityByServiceId[serviceId] = continuity.mode;
        warnings.push(...(continuity.warnings ?? []));
        if (continuity.mode === 'unsupported') {
          return failureResult(continuity.errorCode, { serviceId, failurePhase: 'continuity' });
        }
        if (continuity.mode !== 'hot_apply') {
          allChangedServicesHotApply = false;
        }
      }

      let action: 'restart_requested' | 'hot_applied' = allChangedServicesHotApply
        ? 'hot_applied'
        : 'restart_requested';
      const changedServiceIdSet = new Set<ConnectedServiceId>(changedServiceIds);
      const continuationAttemptId = buildContinuationAttemptId({
        action,
        serviceIds: changedServiceIdSet,
        normalizedBindings: normalized.normalized,
        expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
      });

      const nextEnvironmentVariables = buildTrackedSessionEnvironmentVariables({
        existingEnvironmentVariables: previousSpawnOptions?.environmentVariables,
        normalizedBindings: normalized.normalized,
        ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
        groupMetadataByServiceId: normalized.groupMetadataByServiceId,
      });
      const staleServiceId = findStaleExpectedGeneration({
        request: input.request,
        serviceIds: changedServiceIds,
        isExpectedGroupGenerationCurrent: input.isExpectedGroupGenerationCurrent,
      });
      if (staleServiceId) {
        return { ok: false, errorCode: 'group_generation_conflict', serviceId: staleServiceId };
      }
      tracked.spawnOptions = {
        ...(tracked.spawnOptions ?? { directory: '' }),
        connectedServices: normalized.normalized,
        connectedServicesUpdatedAt: Date.now(),
        ...(connectedServiceMaterializationIdentityV1
          ? { connectedServiceMaterializationIdentityV1 }
          : {}),
        environmentVariables: nextEnvironmentVariables,
      };

      try {
        if (action === 'hot_applied') {
          try {
            await input.persistSessionBindings?.({
              sessionId: input.request.sessionId,
              normalizedBindings: normalized.normalized,
              ...(connectedServiceMaterializationIdentityV1
                ? { connectedServiceMaterializationIdentityV1 }
                : {}),
            });
          } catch {
            tracked.spawnOptions = previousSpawnOptions;
            return failureResult('metadata_update_failed', { failurePhase: 'metadata' });
          }
          let hotApplyResult: Awaited<ReturnType<SwitchSessionConnectedServiceAuthInput['hotApply']>>;
          try {
            hotApplyResult = await input.hotApply({
              tracked,
              normalizedBindings: normalized.normalized,
              serviceIds: new Set(changedServiceIds),
              ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
            });
          } catch {
            hotApplyResult = {
              ok: false,
              errorCode: 'hot_apply_failed',
            };
          }
          if (!hotApplyResult.ok) {
            if (hotApplyFailureRequiresRestart(hotApplyResult)) {
              try {
                await input.restartSession(tracked);
              } catch {
                const rolledBack = await rollbackPersistedSessionBindings({
                  persistSessionBindings: input.persistSessionBindings,
                  sessionId: input.request.sessionId,
                  previousBindings,
                  connectedServiceMaterializationIdentityV1,
                });
                tracked.spawnOptions = previousSpawnOptions;
                if (!rolledBack) {
                  return failureResult('bindings_rollback_failed', {
                    failurePhase: 'rollback',
                    partialState: 'metadata_may_reference_new_binding',
                  });
                }
                return failureResult('restart_failed', { failurePhase: 'restart' });
              }
              action = 'restart_requested';
              Object.assign(continuityByServiceId, markHotApplyContinuityAsRestart(continuityByServiceId));
              const restartContinuationAttemptId = buildContinuationAttemptId({
                action,
                serviceIds: changedServiceIdSet,
                normalizedBindings: normalized.normalized,
                expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
              });
              const recoveryFailure = await runPostSwitchRecovery({
                recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
                tracked,
                normalizedBindings: normalized.normalized,
                serviceIds: changedServiceIdSet,
                action,
                ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
              });
              if (recoveryFailure) return recoveryFailure;
              const continuationFailure = await runContinuationRecovery({
                continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
                tracked,
                sessionId: input.request.sessionId,
                attemptId: restartContinuationAttemptId,
                normalizedBindings: normalized.normalized,
                serviceIds: changedServiceIdSet,
                action,
                ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
              });
              if (continuationFailure) return continuationFailure;
            } else {
              const rolledBack = await rollbackPersistedSessionBindings({
                persistSessionBindings: input.persistSessionBindings,
                sessionId: input.request.sessionId,
                previousBindings,
                connectedServiceMaterializationIdentityV1,
              });
              tracked.spawnOptions = previousSpawnOptions;
              if (!rolledBack) {
                return failureResult('bindings_rollback_failed', {
                  failurePhase: 'rollback',
                  partialState: 'metadata_may_reference_new_binding',
                });
              }
              return failureResult('hot_apply_failed', {
                serviceId: hotApplyResult.serviceId,
                continuityByServiceId,
                failurePhase: 'hot_apply',
                partialState: readHotApplyFailurePartialState(hotApplyResult.serviceResultsByServiceId),
                serviceResultsByServiceId: hotApplyResult.serviceResultsByServiceId,
              });
            }
          } else {
            input.registerHotApplyTargets(tracked);
            const recoveryFailure = await runPostSwitchRecovery({
              recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
              tracked,
              normalizedBindings: normalized.normalized,
              serviceIds: changedServiceIdSet,
              action: 'hot_applied',
              ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
            });
            if (recoveryFailure) return recoveryFailure;
            const continuationFailure = await runContinuationRecovery({
              continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
              tracked,
              sessionId: input.request.sessionId,
              attemptId: continuationAttemptId,
              normalizedBindings: normalized.normalized,
              serviceIds: changedServiceIdSet,
              action: 'hot_applied',
              ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
            });
            if (continuationFailure) return continuationFailure;
          }
        } else {
          try {
            await input.persistSessionBindings?.({
              sessionId: input.request.sessionId,
              normalizedBindings: normalized.normalized,
              ...(connectedServiceMaterializationIdentityV1
                ? { connectedServiceMaterializationIdentityV1 }
                : {}),
            });
          } catch {
            tracked.spawnOptions = previousSpawnOptions;
            return failureResult('metadata_update_failed', { failurePhase: 'metadata' });
          }
          try {
            await input.restartSession(tracked);
          } catch {
            const rolledBack = await rollbackPersistedSessionBindings({
              persistSessionBindings: input.persistSessionBindings,
              sessionId: input.request.sessionId,
              previousBindings,
              connectedServiceMaterializationIdentityV1,
            });
            tracked.spawnOptions = previousSpawnOptions;
            if (!rolledBack) {
              return failureResult('bindings_rollback_failed', {
                failurePhase: 'rollback',
                partialState: 'metadata_may_reference_new_binding',
              });
            }
            return failureResult('restart_failed', { failurePhase: 'restart' });
          }
          const recoveryFailure = await runPostSwitchRecovery({
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
            tracked,
            normalizedBindings: normalized.normalized,
            serviceIds: changedServiceIdSet,
            action: 'restart_requested',
            ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
          });
          if (recoveryFailure) return recoveryFailure;
          const continuationFailure = await runContinuationRecovery({
            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
            tracked,
            sessionId: input.request.sessionId,
            attemptId: continuationAttemptId,
            normalizedBindings: normalized.normalized,
            serviceIds: changedServiceIdSet,
            action: 'restart_requested',
            ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
          });
          if (continuationFailure) return continuationFailure;
        }
      } catch {
        tracked.spawnOptions = previousSpawnOptions;
        return failureResult(
          action === 'hot_applied' ? 'hot_apply_failed' : 'restart_failed',
          { failurePhase: action === 'hot_applied' ? 'hot_apply' : 'restart' },
        );
      }

      emitManualSwitchEvents({
        emitSessionEvent: input.emitSessionEvent,
        sessionId: input.request.sessionId,
        previousByServiceId,
        nextByServiceId,
        reason: input.sessionEventReason ?? 'manual',
        mode: action === 'hot_applied' ? 'hot_apply' : 'restart_resume',
      });

      return {
        ok: true,
        action,
        normalizedBindings: normalized.normalized,
        continuityByServiceId,
        warnings,
      };
  };
  if (input.skipCoreLock) {
    const result = await execute();
    emitConnectedServiceSwitchAttemptEvent({
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.request.sessionId,
      result,
    });
    emitProviderStateSharingDegradedEvents({
      tracked: findTrackedSession(input.getChildren(), input.request.sessionId),
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.request.sessionId,
      result,
    });
    return result;
  }
  const result = await input.core.run({
    sessionId: input.request.sessionId,
    reason: input.switchReason ?? 'manual',
    execute,
  });
  emitConnectedServiceSwitchAttemptEvent({
    emitSessionEvent: input.emitSessionEvent,
    sessionId: input.request.sessionId,
    result,
  });
  emitProviderStateSharingDegradedEvents({
    tracked: findTrackedSession(input.getChildren(), input.request.sessionId),
    emitSessionEvent: input.emitSessionEvent,
    sessionId: input.request.sessionId,
    result,
  });
  return result;
}
