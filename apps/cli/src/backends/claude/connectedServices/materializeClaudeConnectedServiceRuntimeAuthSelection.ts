import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';

import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';

function readCredentialRecord(value: unknown): ConnectedServiceCredentialRecordV1 | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConnectedServiceCredentialRecordV1
    : null;
}

function readBinding(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildSelection(params: Readonly<{
  serviceId: ConnectedServiceId;
  record: ConnectedServiceCredentialRecordV1;
  binding: unknown;
  profileId: string;
  groupId?: string;
  activeProfileId?: string;
  fallbackProfileId?: string;
  generation?: number;
}>): ConnectedServiceResolvedSelection | null {
  const binding = readBinding(params.binding);
  if (binding?.selection === 'group') {
    const groupId = typeof params.groupId === 'string' && params.groupId.trim().length > 0
      ? params.groupId.trim()
      : null;
    const activeProfileId = typeof params.activeProfileId === 'string' && params.activeProfileId.trim().length > 0
      ? params.activeProfileId.trim()
      : params.profileId;
    const fallbackProfileId = typeof params.fallbackProfileId === 'string' && params.fallbackProfileId.trim().length > 0
      ? params.fallbackProfileId.trim()
      : activeProfileId;
    const generation = typeof params.generation === 'number' && Number.isFinite(params.generation)
      ? params.generation
      : 0;
    if (!groupId) return null;
    return {
      kind: 'group',
      serviceId: params.serviceId,
      groupId,
      activeProfileId,
      fallbackProfileId,
      generation,
      record: params.record,
      policy: null,
    };
  }

  return {
    kind: 'profile',
    serviceId: params.serviceId,
    profileId: params.profileId,
    record: params.record,
  };
}

export const materializeClaudeConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (
  params,
) => {
  if (params.input.agentId !== 'claude') return params.baseSelection;
  if (params.input.serviceId !== 'claude-subscription' && params.input.serviceId !== 'anthropic') {
    return params.baseSelection;
  }
  const activeServerDir = typeof params.activeServerDir === 'string' && params.activeServerDir.trim().length > 0
    ? params.activeServerDir.trim()
    : '';
  if (!activeServerDir) return params.baseSelection;

  const record = readCredentialRecord(params.baseSelection.record);
  if (!record) return params.baseSelection;
  const selection = buildSelection({
    serviceId: params.input.serviceId,
    record,
    binding: params.baseSelection.binding,
    profileId: params.baseSelection.profileId,
    ...(typeof params.baseSelection.groupId === 'string' ? { groupId: params.baseSelection.groupId } : {}),
    ...(typeof params.baseSelection.activeProfileId === 'string' ? { activeProfileId: params.baseSelection.activeProfileId } : {}),
    ...(typeof params.baseSelection.fallbackProfileId === 'string' ? { fallbackProfileId: params.baseSelection.fallbackProfileId } : {}),
    ...(typeof params.baseSelection.generation === 'number' ? { generation: params.baseSelection.generation } : {}),
  });
  const materialized = await materializeClaudeConnectedServiceSelection({
    activeServerDir,
    serviceId: params.input.serviceId,
    record,
    fallbackProfileId: params.baseSelection.profileId,
    selection,
    processEnv: params.processEnv ?? process.env,
    accountSettings: params.accountSettings ?? null,
    sessionDirectory: params.input.tracked.spawnOptions?.directory ?? null,
  });
  if (!materialized) return params.baseSelection;

  return {
    ...params.baseSelection,
    targetMaterializedEnv: materialized.env,
    targetMaterializedRoot: materialized.targetMaterializedRoot,
    materializationDiagnostics: materialized.diagnostics,
  };
};
