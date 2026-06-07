import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceBindingsV1, ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceCredentialRefreshResult } from '../refresh/ConnectedServiceRefreshCoordinator';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../accountTransitions/acceptedConnectedServiceAccountVerification';

import {
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupSwitchEvent,
  type ConnectedServiceAuthGroupSwitchResult,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import {
  createConnectedServiceSessionAuthSwitchCore,
  type ConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';
import { buildConnectedServiceSwitchContinuationAttemptId } from '../sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';
import {
  isGroupRuntimeRecoverySelection,
  resolveConnectedServiceRuntimeAuthRecoverySelection,
  type RuntimeRecoverySelection,
} from './resolveConnectedServiceRuntimeAuthRecoverySelection';

type SwitchCoordinatorLike = Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator'];
type SwitchAfterClassifiedFailureInput = Parameters<SwitchCoordinatorLike['switchAfterClassifiedFailure']>[0];
type TemporaryThrottleRecoveryLike = NonNullable<
  Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['temporaryThrottleRecovery']
>;
type SwitchAttemptTrackerLike = Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  | 'resolveSwitchesThisTurn'
  | 'recordSwitchResult'
  | 'countRecordedSwitchesInWindow'
  | 'hasFreshCredentialRefreshAttempt'
  | 'recordCredentialRefreshAttempt'
  | 'clearSession'
> & Partial<Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  | 'hasFreshSuccessfulCredentialRefreshAttempt'
  | 'recordCredentialRefreshSuccess'
>>;

type RuntimeCredentialRefreshService = Readonly<{
  refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: string;
    profileId: string;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

type RuntimeAuthSwitchContinuation = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
}>) => Promise<void> | void;

type RuntimeAuthRecoverySuccessObserver = (input: Readonly<{
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
  status: 'switched' | 'observed_generation' | 'credential_refreshed';
  generation: number | null;
  // Provider-outcome proof carriers. The observer is a LOCAL-substep notification;
  // consumers MUST gate clearing recovery on these (post-switch account-adoption
  // verification, or a genuinely fresh candidate). A bare status is never proof.
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId | null;
  fromProfileId?: string | null;
}>) => Promise<void> | void;

type RuntimeAuthRestartFailureObserver = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  source: 'group_switch' | 'credential_refresh';
  error: unknown;
  groupSwitchResult?: ConnectedServiceAuthGroupSwitchResult;
  credentialRefreshResult?: ConnectedServiceCredentialRefreshResult;
}>) => Promise<void> | void;

type RuntimeAuthRecoveryActionRequired = Readonly<{
  status: 'recovery_action_required';
  action: Readonly<{
    kind: 'reconnect_profile';
    serviceId: string;
    profileId: string;
    groupId: string | null;
    reason: ConnectedServiceRuntimeFailureClassification['kind'];
  }>;
}>;

type RuntimeAuthRecoveryInvocationSource = 'daemon_report' | 'scheduler_retry';

type RuntimeAuthCredentialRefreshProviderOutcomeWaiting = Readonly<{
  status: 'credential_refreshed';
  restartRequested: false;
  pendingProviderOutcome: true;
}>;

const unavailableSwitchCoordinator: SwitchCoordinatorLike = {
  switchAfterClassifiedFailure: async () => ({
    status: 'no_eligible_member',
    generation: 0,
    groupExhausted: true,
    retryAtMs: null,
    excluded: [],
  }),
};

const defaultSwitchCore = createConnectedServiceSessionAuthSwitchCore();

function requestRuntimeAuthRestart(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  source: 'group_switch' | 'credential_refresh';
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  onRestartFailure?: RuntimeAuthRestartFailureObserver | null;
  groupSwitchResult?: ConnectedServiceAuthGroupSwitchResult;
  credentialRefreshResult?: ConnectedServiceCredentialRefreshResult;
}>): boolean {
  const restartSession = input.restartSession;
  if (!restartSession) return false;
  void Promise.resolve(restartSession(input.tracked)).catch((error) => {
    void Promise.resolve(input.onRestartFailure?.({
      sessionId: input.sessionId,
      tracked: input.tracked,
      source: input.source,
      error,
      ...(input.groupSwitchResult === undefined ? {} : { groupSwitchResult: input.groupSwitchResult }),
      ...(input.credentialRefreshResult === undefined ? {} : { credentialRefreshResult: input.credentialRefreshResult }),
    })).catch(() => {});
  });
  return true;
}

function createCommitOnlySwitchCoordinator(
  switchCoordinator: SwitchCoordinatorLike,
): SwitchCoordinatorLike {
  return {
    switchAfterClassifiedFailure: async (input: SwitchAfterClassifiedFailureInput) => {
      const { sessionId: _liveSessionId, ...commitOnlyInput } = input;
      return await switchCoordinator.switchAfterClassifiedFailure(commitOnlyInput);
    },
  };
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function isRuntimeCredentialFailure(classification: ConnectedServiceRuntimeFailureClassification): boolean {
  return classification.kind === 'auth_expired'
    || classification.kind === 'account_changed'
    || classification.kind === 'refresh_failed'
    || classification.kind === 'permission_denied';
}

function isReconnectRequiredRefreshResult(result: ConnectedServiceCredentialRefreshResult): boolean {
  const category = result.diagnostic.category;
  return result.status === 'credential_missing'
    || category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function normalizeNullableProfileId(value: unknown): string | null {
  const normalized = normalizeSessionId(value);
  return normalized.length > 0 ? normalized : null;
}

function buildReconnectProfileAfterRepeatedCredentialRefresh(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  selection: RuntimeRecoverySelection;
  profileId: string;
}>): RuntimeAuthRecoveryActionRequired {
  return {
    status: 'recovery_action_required',
    action: {
      kind: 'reconnect_profile',
      serviceId: input.selection.serviceId,
      profileId: input.profileId,
      groupId: input.classification.groupId ?? (
        input.selection.kind === 'group' ? input.selection.groupId : null
      ),
      reason: input.classification.kind,
    },
  };
}

function shouldSwitchAwayAfterRepeatedCredentialRefreshFailure(
  selection: RuntimeRecoverySelection,
): boolean {
  return selection.kind === 'group';
}

function emitRuntimeGroupSwitchSessionEvent(input: Readonly<{
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
  result: ConnectedServiceAuthGroupSwitchResult;
}>): void {
  if (input.result.status !== 'switched') return;
  const fromProfileId = normalizeNullableProfileId(
    input.classification.profileId
      ?? input.selection.activeProfileId
      ?? input.selection.fallbackProfileId,
  );
  const event = {
    type: 'connected_service_auth_group_switch',
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    fromProfileId,
    toProfileId: input.result.activeProfileId,
    reason: input.classification.kind,
    ...(input.result.mode ? { mode: input.result.mode } : {}),
    fromGeneration: 0,
    toGeneration: input.result.generation,
    resultStatus: input.result.status,
    success: true,
    latencyMs: 0,
  } satisfies ConnectedServiceAuthGroupSwitchEvent;
  input.emitSessionEvent?.(input.sessionId, event);
}

async function runRuntimeGroupSwitchRecovery(input: Readonly<{
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
  switchesThisTurn: number;
  switchCoordinator: SwitchCoordinatorLike;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  applyLiveSession?: boolean;
}>): Promise<Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>> {
  const effectiveSwitchesThisTurn = input.switchAttemptTracker?.resolveSwitchesThisTurn({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    reportedSwitchesThisTurn: input.switchesThisTurn,
  }) ?? input.switchesThisTurn;
  const sessionSwitchesThisHour = input.switchAttemptTracker?.countRecordedSwitchesInWindow({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    windowMs: SESSION_SWITCH_LIMIT_WINDOW_MS,
  });

  return await handleConnectedServiceRuntimeAuthFailure({
    sessionId: input.sessionId,
    selection: {
      kind: 'group',
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId,
      activeProfileId: input.classification.profileId
        ?? input.selection.activeProfileId
        ?? input.selection.fallbackProfileId
        ?? '',
    },
    classification: {
      ...input.classification,
      groupId: input.classification.groupId ?? input.selection.groupId,
      profileId: input.classification.profileId
        ?? input.selection.activeProfileId
        ?? input.selection.fallbackProfileId
        ?? null,
    },
    switchesThisTurn: effectiveSwitchesThisTurn,
    sessionSwitchesThisHour,
    switchCoordinator: input.applyLiveSession === false
      ? createCommitOnlySwitchCoordinator(input.switchCoordinator)
      : input.switchCoordinator,
    temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
  });
}

function finalizeRuntimeGroupSwitchAttempt(input: Readonly<{
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
  result: Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
}>): void {
  if (input.result.status !== 'switch_attempted') return;
  emitRuntimeGroupSwitchSessionEvent({
    emitSessionEvent: input.emitSessionEvent,
    sessionId: input.sessionId,
    selection: input.selection,
    classification: input.classification,
    result: input.result.result,
  });
  input.switchAttemptTracker?.recordSwitchResult({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    resultStatus: input.result.result.status,
  });
}

function maybeRestartAfterRuntimeGroupSwitch(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  result: ConnectedServiceAuthGroupSwitchResult;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  onRestartFailure?: RuntimeAuthRestartFailureObserver | null;
}>): void {
  if (input.result.status !== 'switched') return;
  if (input.result.mode !== 'spawn_next_turn') return;
  requestRuntimeAuthRestart({
    sessionId: input.sessionId,
    tracked: input.tracked,
    source: 'group_switch',
    restartSession: input.restartSession ?? null,
    onRestartFailure: input.onRestartFailure ?? null,
    groupSwitchResult: input.result,
  });
}

async function maybeContinueAfterHotAppliedRuntimeGeneration(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: ConnectedServiceAuthGroupSwitchResult;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.continueAfterRuntimeAuthSwitch) return;
  if (
    input.result.status !== 'observed_generation'
    && !(input.result.status === 'switched' && input.result.mode === 'hot_apply')
  ) {
    return;
  }
  const activeProfileId = normalizeSessionId(input.result.activeProfileId);
  if (!activeProfileId) return;

  const serviceId = input.selection.serviceId as ConnectedServiceId;
  const normalizedBindings = {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.selection.groupId,
        profileId: activeProfileId,
      },
    },
  } satisfies ConnectedServiceBindingsV1;
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'hot_applied',
      serviceIds,
      normalizedBindings,
      expectedGroupGenerationByServiceId: {
        [serviceId]: input.result.generation,
      },
    }),
    normalizedBindings,
    serviceIds,
    action: 'hot_applied',
  });
}

async function maybeContinueAfterCredentialRefresh(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  selection: RuntimeRecoverySelection;
  profileId: string;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const serviceId = input.selection.serviceId as ConnectedServiceId;
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);
  const normalizedBindings: ConnectedServiceBindingsV1 = {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: input.selection.kind === 'group'
        ? {
            source: 'connected',
            selection: 'group',
            groupId: input.selection.groupId,
            profileId: input.profileId,
          }
        : {
            source: 'connected',
            selection: 'profile',
            profileId: input.profileId,
          },
    },
  };

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'restart_requested',
      serviceIds,
      normalizedBindings,
    }),
    normalizedBindings,
    serviceIds,
    action: 'restart_requested',
  });
}

async function maybeRefreshCredentialBeforeRuntimeRecovery(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  classification: ConnectedServiceRuntimeFailureClassification;
  selection: RuntimeRecoverySelection;
  recoveryInvocationSource: RuntimeAuthRecoveryInvocationSource;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  credentialRefreshService?: RuntimeCredentialRefreshService | null;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  onRuntimeAuthRestartFailure?: RuntimeAuthRestartFailureObserver | null;
}>): Promise<
  | null
  | Readonly<{
      status: 'credential_refreshed';
      result: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | RuntimeAuthRecoveryActionRequired
  | RuntimeAuthCredentialRefreshProviderOutcomeWaiting
> {
  if (!input.credentialRefreshService || !isRuntimeCredentialFailure(input.classification)) return null;
  const profileId = normalizeSessionId(
    input.classification.profileId
    ?? (
      input.selection.kind === 'profile'
        ? input.selection.profileId
        : input.selection.activeProfileId ?? input.selection.fallbackProfileId
    )
    ?? '',
  );
  if (!profileId) return null;

  const attempt = {
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    profileId,
    reason: input.classification.kind,
  };
  if (input.switchAttemptTracker?.hasFreshSuccessfulCredentialRefreshAttempt?.(attempt)) {
    if (input.recoveryInvocationSource === 'scheduler_retry') {
      return {
        status: 'credential_refreshed',
        restartRequested: false,
        pendingProviderOutcome: true,
      };
    }
    if (shouldSwitchAwayAfterRepeatedCredentialRefreshFailure(input.selection)) {
      return null;
    }
    return buildReconnectProfileAfterRepeatedCredentialRefresh({
      classification: input.classification,
      selection: input.selection,
      profileId,
    });
  }
  if (input.switchAttemptTracker?.hasFreshCredentialRefreshAttempt(attempt)) return null;
  input.switchAttemptTracker?.recordCredentialRefreshAttempt(attempt);

  const result = await input.credentialRefreshService.refreshConnectedServiceCredentialForRuntimeAuthFailure({
    serviceId: input.selection.serviceId,
    profileId,
  });
  if (result.status === 'refreshed') {
    input.switchAttemptTracker?.recordCredentialRefreshSuccess?.(attempt);
    await input.onRuntimeAuthRecoverySuccess?.({
      sessionId: input.sessionId,
      serviceId: input.selection.serviceId,
      groupId: input.classification.groupId,
      profileId,
      status: 'credential_refreshed',
      generation: null,
    });
    await maybeContinueAfterCredentialRefresh({
      tracked: input.tracked,
      sessionId: input.sessionId,
      selection: input.selection,
      profileId,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
    const restartRequested = requestRuntimeAuthRestart({
      sessionId: input.sessionId,
      tracked: input.tracked,
      source: 'credential_refresh',
      restartSession: input.restartSession ?? null,
      onRestartFailure: input.onRuntimeAuthRestartFailure ?? null,
      credentialRefreshResult: result,
    });
    return {
      status: 'credential_refreshed',
      result,
      restartRequested,
    };
  }
  if (result.status === 'refresh_failed' && !isReconnectRequiredRefreshResult(result)) {
    return null;
  }
  return null;
}

async function notifyRuntimeGroupSwitchRecoverySuccess(input: Readonly<{
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>;
}>): Promise<void> {
  if (input.result.status !== 'switch_attempted') return;
  if (input.result.result.status !== 'switched' && input.result.result.status !== 'observed_generation') return;
  // Surface the post-switch account-adoption verification (when present) so the
  // daemon's reactive proof gate can clear recovery on verified adoption. A bare
  // switched/observed_generation status without verification is NOT proof.
  const verificationByServiceId = input.result.result.verificationByServiceId ?? null;
  await input.onRuntimeAuthRecoverySuccess?.({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    profileId: input.result.result.activeProfileId,
    status: input.result.result.status,
    generation: input.result.result.generation,
    ...(verificationByServiceId ? { verificationByServiceId } : {}),
  });
}

export async function handleConnectedServiceRuntimeAuthFailureForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  switchCoordinator: SwitchCoordinatorLike | null;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  switchCore?: ConnectedServiceSessionAuthSwitchCore | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  credentialRefreshService?: RuntimeCredentialRefreshService | null;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  onRuntimeAuthRestartFailure?: RuntimeAuthRestartFailureObserver | null;
  sessionId: string;
  switchesThisTurn: number;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  classification: ConnectedServiceRuntimeFailureClassification | null;
}>): Promise<
  | Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>
  | Readonly<{
      status: 'credential_refreshed';
      result: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | RuntimeAuthCredentialRefreshProviderOutcomeWaiting
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{
      status: 'switch_coordinator_unavailable';
      blocker: 'CLI has no connected-service auth-group load/commit API in this branch.';
    }>
> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) {
    const classification = input.classification;
    const { selection } = classification
      ? resolveConnectedServiceRuntimeAuthRecoverySelection({
        classification,
        environmentVariables: {},
      })
      : { selection: null };
    if (classification && selection && isGroupRuntimeRecoverySelection(selection)) {
      if (!input.switchCoordinator) {
        return {
          status: 'switch_coordinator_unavailable',
          blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
        };
      }
      const switchCoordinator = input.switchCoordinator;
      const switchCore = input.switchCore ?? defaultSwitchCore;
      const result = await switchCore.run({
        sessionId: input.sessionId,
        reason: 'automatic_runtime_failure',
        execute: async () => await runRuntimeGroupSwitchRecovery({
          sessionId: input.sessionId,
          selection,
          classification,
          switchesThisTurn: input.switchesThisTurn,
          switchCoordinator,
          switchAttemptTracker: input.switchAttemptTracker ?? null,
          temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
          applyLiveSession: false,
        }),
      });
      finalizeRuntimeGroupSwitchAttempt({
        emitSessionEvent: input.emitSessionEvent,
        sessionId: input.sessionId,
        selection,
        classification,
        result,
        switchAttemptTracker: input.switchAttemptTracker ?? null,
      });
      await notifyRuntimeGroupSwitchRecoverySuccess({
        onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
        sessionId: input.sessionId,
        selection,
        result,
      });
      return result;
    }
    input.switchAttemptTracker?.clearSession(input.sessionId);
    input.switchCore?.clearSession(input.sessionId);
    return { status: 'session_not_found' };
  }
  const classification = input.classification;
  if (!classification) {
    return await handleConnectedServiceRuntimeAuthFailure({
      selection: null,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  const { selection } = resolveConnectedServiceRuntimeAuthRecoverySelection({
    classification,
    environmentVariables: tracked.spawnOptions?.environmentVariables ?? {},
    trackedConnectedServices: tracked.spawnOptions?.connectedServices,
    sessionMetadataConnectedServices: tracked.happySessionMetadataFromLocalWebhook?.connectedServices,
  });
  if (!selection) {
    return await handleConnectedServiceRuntimeAuthFailure({
      sessionId: input.sessionId,
      selection,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  const switchCore = input.switchCore ?? defaultSwitchCore;
  const result = await switchCore.run({
    sessionId: input.sessionId,
    reason: 'automatic_runtime_failure',
    execute: async () => {
      const refreshed = await maybeRefreshCredentialBeforeRuntimeRecovery({
        sessionId: input.sessionId,
        tracked,
        classification,
        selection,
        recoveryInvocationSource: input.recoveryInvocationSource ?? 'daemon_report',
        switchAttemptTracker: input.switchAttemptTracker ?? null,
        credentialRefreshService: input.credentialRefreshService ?? null,
        restartSession: input.restartSession ?? null,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
        onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
        onRuntimeAuthRestartFailure: input.onRuntimeAuthRestartFailure ?? null,
      });
      if (refreshed) return refreshed;

      if (!isGroupRuntimeRecoverySelection(selection)) {
        if (!input.switchCoordinator) {
          return await handleConnectedServiceRuntimeAuthFailure({
            sessionId: input.sessionId,
            selection,
            classification,
            switchesThisTurn: input.switchesThisTurn,
            switchCoordinator: unavailableSwitchCoordinator,
            temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
          });
        }
        return await handleConnectedServiceRuntimeAuthFailure({
          sessionId: input.sessionId,
          selection,
          classification,
          switchesThisTurn: input.switchesThisTurn,
          switchCoordinator: input.switchCoordinator,
          temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
        });
      }
      const groupSelection = selection;

      if (!input.switchCoordinator) {
        return {
          status: 'switch_coordinator_unavailable',
          blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
        } as const;
      }

      const switchCoordinator = input.switchCoordinator;
      return await runRuntimeGroupSwitchRecovery({
        sessionId: input.sessionId,
        selection: groupSelection,
        classification,
        switchesThisTurn: input.switchesThisTurn,
        switchCoordinator,
        switchAttemptTracker: input.switchAttemptTracker ?? null,
        temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
      });
    },
  });
  if (result.status === 'switch_attempted' && isGroupRuntimeRecoverySelection(selection)) {
    finalizeRuntimeGroupSwitchAttempt({
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.sessionId,
      selection,
      classification,
      result,
      switchAttemptTracker: input.switchAttemptTracker ?? null,
    });
    await notifyRuntimeGroupSwitchRecoverySuccess({
      onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
      sessionId: input.sessionId,
      selection,
      result,
    });
    maybeRestartAfterRuntimeGroupSwitch({
      sessionId: input.sessionId,
      tracked,
      result: result.result,
      restartSession: input.restartSession ?? null,
      onRestartFailure: input.onRuntimeAuthRestartFailure ?? null,
    });
    await maybeContinueAfterHotAppliedRuntimeGeneration({
      tracked,
      sessionId: input.sessionId,
      selection,
      result: result.result,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
  }
  return result;
}
