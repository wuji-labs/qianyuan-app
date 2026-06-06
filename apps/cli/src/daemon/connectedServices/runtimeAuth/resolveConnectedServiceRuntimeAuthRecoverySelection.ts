import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

export type RuntimeRecoverySelection =
  | Readonly<{
      kind: 'profile';
      serviceId: string;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: string;
      groupId: string;
      activeProfileId?: string;
      fallbackProfileId?: string;
    }>;

export type ConnectedServiceRuntimeAuthRecoverySelectionSource =
  | 'child_env'
  | 'tracked_spawn_options'
  | 'session_metadata'
  | 'classification';

type ResolvedRuntimeRecoverySelection = Readonly<{
  selection: RuntimeRecoverySelection | null;
  source: ConnectedServiceRuntimeAuthRecoverySelectionSource | null;
}>;

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapParsedBindingSelectionToRuntimeRecoverySelection(
  selection: RuntimeRecoverySelection | null,
  failedProfileId?: string,
): RuntimeRecoverySelection | null {
  if (selection?.kind === 'group' && failedProfileId) {
    return {
      ...selection,
      fallbackProfileId: failedProfileId,
    };
  }
  return selection;
}

export function isGroupRuntimeRecoverySelection(
  selection: RuntimeRecoverySelection,
): selection is Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>> {
  return selection.kind === 'group';
}

export function resolveConnectedServiceRuntimeAuthRecoverySelection(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  trackedConnectedServices?: unknown;
  sessionMetadataConnectedServices?: unknown;
  environmentVariables?: Readonly<Record<string, string | undefined>> | null;
}>): ResolvedRuntimeRecoverySelection {
  const serviceId = normalizeNonEmptyString(input.classification.serviceId);
  if (!serviceId) return { selection: null, source: null };

  const reportedProfileId = normalizeNonEmptyString(input.classification.profileId);
  if (reportedProfileId) {
    const reportedGroupId = normalizeNonEmptyString(input.classification.groupId);
    if (reportedGroupId) {
      return {
        selection: {
          kind: 'group',
          serviceId,
          groupId: reportedGroupId,
          fallbackProfileId: reportedProfileId,
        },
        source: 'classification',
      };
    }
  }
  const preferDurableGroup = Boolean(reportedProfileId);

  const childEnvSelection = readConnectedServiceChildSelectionsFromEnv(
    input.environmentVariables ?? {},
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (childEnvSelection && (!preferDurableGroup || childEnvSelection.kind === 'group')) {
    if (childEnvSelection.kind === 'profile') {
      return {
        selection: {
          kind: 'profile',
          serviceId: childEnvSelection.serviceId,
          profileId: childEnvSelection.profileId,
        },
        source: 'child_env',
      };
    }
    return {
      selection: {
        kind: 'group',
        serviceId: childEnvSelection.serviceId,
        groupId: childEnvSelection.groupId,
        activeProfileId: childEnvSelection.activeProfileId,
        fallbackProfileId: reportedProfileId || childEnvSelection.fallbackProfileId,
      },
      source: 'child_env',
    };
  }

  const trackedSelection = parseConnectedServiceBindingSelections(
    input.trackedConnectedServices,
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (trackedSelection && (!preferDurableGroup || trackedSelection.kind === 'group')) {
    return {
      selection: mapParsedBindingSelectionToRuntimeRecoverySelection(trackedSelection, reportedProfileId),
      source: 'tracked_spawn_options',
    };
  }

  const metadataSelection = parseConnectedServiceBindingSelections(
    input.sessionMetadataConnectedServices,
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (metadataSelection && (!preferDurableGroup || metadataSelection.kind === 'group')) {
    return {
      selection: mapParsedBindingSelectionToRuntimeRecoverySelection(metadataSelection, reportedProfileId),
      source: 'session_metadata',
    };
  }
  if (reportedProfileId) {
    return {
      selection: {
        kind: 'profile',
        serviceId,
        profileId: reportedProfileId,
      },
      source: 'classification',
    };
  }
  return { selection: null, source: null };
}
