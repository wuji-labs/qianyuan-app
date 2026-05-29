import { inferAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
  AgentRuntimeDescriptorV1Schema,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

export type BuildInactiveUsageLimitResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId: string;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>;

function readNonEmptyMetadataString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parsePersistedAgentRuntimeDescriptorForResume(
  metadata: Record<string, unknown>,
): SpawnSessionOptions['agentRuntimeDescriptorV1'] | undefined {
  const parsed = AgentRuntimeDescriptorV1Schema.safeParse(metadata.agentRuntimeDescriptorV1);
  return parsed.success ? parsed.data : undefined;
}

export function buildInactiveUsageLimitResumeSpawnOptions(
  params: BuildInactiveUsageLimitResumeSpawnOptionsParams,
): SpawnSessionOptions | null {
  const agentId = inferAgentIdFromSessionMetadata(params.metadata);
  const directory = readNonEmptyMetadataString(params.rawSession.path) ?? readNonEmptyMetadataString(params.metadata.path);
  const machineId =
    readNonEmptyMetadataString(params.rawSession.machineId)
    ?? readNonEmptyMetadataString(params.metadata.machineId)
    ?? params.fallbackMachineId;
  if (!agentId || !directory || !machineId) return null;

  const agentRuntimeDescriptorV1 = parsePersistedAgentRuntimeDescriptorForResume(params.metadata);
  const baseOptions: SpawnSessionOptions = {
    existingSessionId: params.sessionId,
    machineId,
    directory,
    backendTarget: { kind: 'builtInAgent', agentId },
    approvedNewDirectoryCreation: true,
    ...(agentRuntimeDescriptorV1 !== undefined ? { agentRuntimeDescriptorV1 } : {}),
  };

  return resolveSessionRuntimeSnapshot({
    incomingOptions: baseOptions,
    persistedMetadata: params.metadata,
  }).spawnOptions;
}
