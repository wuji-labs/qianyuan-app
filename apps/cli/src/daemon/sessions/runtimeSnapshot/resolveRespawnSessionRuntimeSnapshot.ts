import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

type ResolveExistingSessionAttachContext = typeof resolveExistingSessionAttachContext;

export type ResolveRespawnSessionRuntimeSnapshotParams = Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
  credentials: Credentials | null;
  readCredentials: () => Promise<Credentials | null>;
  resolveAttachContext?: ResolveExistingSessionAttachContext;
}>;

function resolveAttachAgent(options: SpawnSessionOptions): string {
  const backendTarget = options.backendTarget;
  return backendTarget?.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp';
}

export async function resolveRespawnSessionRuntimeSnapshot(
  params: ResolveRespawnSessionRuntimeSnapshotParams,
): Promise<SpawnSessionOptions> {
  const resolver = params.resolveAttachContext ?? resolveExistingSessionAttachContext;
  const storedCredentials = await params.readCredentials().catch(() => null);
  const effectiveCredentials = storedCredentials ?? params.credentials;
  const token = typeof effectiveCredentials?.token === 'string' ? effectiveCredentials.token.trim() : '';
  if (!token) return params.defaultOptions;

  const attachContext = await resolver({
    token,
    sessionId: params.sessionId,
    agent: resolveAttachAgent(params.defaultOptions),
    credentials: effectiveCredentials,
  }).catch(() => null);
  if (!attachContext?.ok) return params.defaultOptions;

  return resolveSessionRuntimeSnapshot({
    incomingOptions: params.defaultOptions,
    persistedMetadata: attachContext.metadata,
    trackedSpawnOptions: params.spawnOptions,
    persistedVendorResumeId: attachContext.vendorResumeId,
    trackedVendorResumeId: params.vendorResumeId,
  }).spawnOptions;
}
