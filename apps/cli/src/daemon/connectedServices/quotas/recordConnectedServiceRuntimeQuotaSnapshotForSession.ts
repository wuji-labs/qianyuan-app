import type {
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import type { ConnectedServiceAuthGroupQuotaSnapshot } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import type { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { RuntimeAccountIdentityRecordInput } from './identity/runtimeAccountIdentityTypes';

type QuotaCoordinatorLike = Pick<ConnectedServiceQuotasCoordinator, 'recordInBandQuotaSnapshot'> & Readonly<{
  recordRuntimeAccountIdentityFromSnapshot?: (input: RuntimeAccountIdentityRecordInput) => unknown;
  recordAccountExhaustionAndFanout?: (input: Readonly<{
    sourceSessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    exhaustedProfileId: string;
    providerAccountId: string;
    resetAtMs: number | null;
    reason: 'usage_limit';
  }>) => Promise<unknown>;
}>;

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

function quotaSnapshotProvesExhaustion(snapshot: ConnectedServiceAuthGroupQuotaSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  if (snapshot.exhausted === true) return true;
  const remaining = snapshot.effectiveRemainingPercent;
  return typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= 0;
}

function normalizeResetAtMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function recordConnectedServiceRuntimeQuotaSnapshotForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  quotaCoordinator: QuotaCoordinatorLike | null;
  publishQuotaRef?: (ref: Readonly<{ sessionId: string; serviceId: ConnectedServiceId; profileId: string }>) => Promise<void>;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  sessionId: string;
  serviceId: ConnectedServiceId;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>): Promise<
  | Readonly<{ status: 'recorded'; groupRuntimeStateRecorded: boolean; quotaStateRecorded: boolean }>
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{ status: 'service_id_mismatch' }>
> {
  if (input.snapshot.serviceId !== input.serviceId) return { status: 'service_id_mismatch' };

  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) return { status: 'session_not_found' };
  const selection = parseConnectedServiceBindingSelections(resolveTrackedConnectedServiceBindingsRaw(tracked))
    .find((candidate) => candidate.serviceId === input.serviceId) ?? null;
  const activeGroupSelection = readConnectedServiceChildSelectionsFromEnv(tracked.spawnOptions?.environmentVariables ?? {})
    .find((candidate) => (
      candidate.kind === 'group'
      && candidate.serviceId === input.serviceId
      && candidate.groupId === (selection?.kind === 'group' ? selection.groupId : '')
    )) ?? null;

  const groupRuntimeStateRecorded = selection?.kind === 'group';
  if (groupRuntimeStateRecorded) {
    input.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: input.serviceId,
      groupId: selection.groupId,
      profileId: input.snapshot.profileId,
      snapshot: input.snapshot,
    });
  }

  let quotaStateRecorded = false;
  if (input.quotaCoordinator) {
    try {
      const persistence = await input.quotaCoordinator.recordInBandQuotaSnapshot({
        serviceId: input.serviceId,
        profileId: input.snapshot.profileId,
        snapshot: input.snapshot,
      });
      quotaStateRecorded = persistence.status !== 'deferred_unknown_mode';
    } catch {
      quotaStateRecorded = false;
    }
  }

  if (quotaStateRecorded) {
    try {
      await input.publishQuotaRef?.({
        sessionId: input.sessionId,
        serviceId: input.serviceId,
        profileId: input.snapshot.profileId,
      });
    } catch {
      // Session metadata refs are a best-effort display projection over the durable quota row.
    }
  }

  if (input.quotaCoordinator?.recordRuntimeAccountIdentityFromSnapshot && input.snapshot.activeAccountId) {
    input.quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot({
      sessionId: input.sessionId,
      serviceId: input.serviceId,
      groupId: selection?.kind === 'group' ? selection.groupId : null,
      profileId: input.snapshot.profileId,
      providerAccountId: input.snapshot.activeAccountId,
      accountLabel: input.snapshot.accountLabel ?? null,
      observedAtMs: input.snapshot.fetchedAt,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: activeGroupSelection?.kind === 'group' ? activeGroupSelection.generation : null,
    });
  }

  if (
    selection?.kind === 'group'
    && input.snapshot.activeAccountId
    && input.quotaCoordinator?.recordAccountExhaustionAndFanout
  ) {
    const state = input.runtimeQuotaSnapshots.buildMemberStates({
      serviceId: input.serviceId,
      groupId: selection.groupId,
      capturedAtMs: input.snapshot.fetchedAt,
    }).get(input.snapshot.profileId) ?? null;
    if (quotaSnapshotProvesExhaustion(state?.quotaSnapshot ?? null)) {
      await input.quotaCoordinator.recordAccountExhaustionAndFanout({
        sourceSessionId: input.sessionId,
        serviceId: input.serviceId,
        groupId: selection.groupId,
        exhaustedProfileId: input.snapshot.profileId,
        providerAccountId: input.snapshot.activeAccountId,
        resetAtMs: normalizeResetAtMs(state?.providerResetsAtMs),
        reason: 'usage_limit',
      });
    }
  }

  return { status: 'recorded', groupRuntimeStateRecorded, quotaStateRecorded };
}
