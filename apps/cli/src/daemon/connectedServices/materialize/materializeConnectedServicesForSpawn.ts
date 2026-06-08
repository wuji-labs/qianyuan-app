import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { getConnectedServiceMaterializer } from '@/backends/catalog';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  serializeConnectedServiceMaterializedEnvKeys,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import type { ConnectedServicesMaterializeResult } from './providerMaterializerTypes';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

export type ConnectedServiceResolvedSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      record: ConnectedServiceCredentialRecordV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      record: ConnectedServiceCredentialRecordV1;
      policy: unknown;
    }>;

function bestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
}

function rewriteEnvRoot(
  env: Readonly<Record<string, string>>,
  fromRoot: string,
  toRoot: string,
): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const rel = relative(fromRoot, value);
    rewritten[key] = rel === ''
      ? toRoot
      : !rel.startsWith('..') && !isAbsolute(rel)
        ? join(toRoot, rel)
        : value;
  }
  return rewritten;
}

function rewritePathRoot(
  value: string,
  fromRoot: string,
  toRoot: string,
): string {
  const rel = relative(fromRoot, value);
  return rel === ''
    ? toRoot
    : !rel.startsWith('..') && !isAbsolute(rel)
      ? join(toRoot, rel)
      : value;
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<ConnectedServicesMaterializeResult | null> {
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: params.baseDir,
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    materializationIdentity: params.connectedServiceMaterializationIdentityV1 ?? null,
  });
  // `rootDir` is `<baseDir>/<segment>/<agentId>`; recover the segment for the sibling attempt dir.
  const materializationSegment = basename(dirname(rootDir));
  const attemptRoot = join(params.baseDir, '.attempts', `${materializationSegment}-${params.agentId}-${randomUUID()}`);
  const cleanupRoot = bestEffortCleanupDirectory(attemptRoot);

  const materializer = await getConnectedServiceMaterializer(params.agentId);
  if (!materializer) return null;
  await mkdir(attemptRoot, { recursive: true });
  let materialized: ConnectedServicesMaterializeResult | null;
  try {
    materialized = await materializer({
      agentId: params.agentId,
      activeServerDir: params.activeServerDir,
      rootDir: attemptRoot,
      sessionDirectory: params.sessionDirectory ?? null,
      recordsByServiceId: params.recordsByServiceId,
      selectionsByServiceId: params.selectionsByServiceId,
      accountSettings: params.accountSettings ?? null,
      processEnv: params.processEnv ?? process.env,
      cleanupRoot,
    });
  } catch (error) {
    cleanupRoot();
    throw error;
  }
  if (!materialized) {
    cleanupRoot();
    return null;
  }
  await replaceDirectoryAtomically({ stagedDir: attemptRoot, targetDir: rootDir });
  const materializedEnv = rewriteEnvRoot(materialized.env, attemptRoot, rootDir);
  const explicitTargetMaterializedRoot = typeof materialized.targetMaterializedRoot === 'string'
    && materialized.targetMaterializedRoot.trim().length > 0
    ? rewritePathRoot(materialized.targetMaterializedRoot, attemptRoot, rootDir)
    : null;
  const serializedSelections = serializeConnectedServiceChildSelections(params.selectionsByServiceId);
  const serializedMaterializedEnvKeys = serializeConnectedServiceMaterializedEnvKeys(materializedEnv);
  const targetMaterializedRoot = explicitTargetMaterializedRoot ?? resolveConnectedServiceTargetMaterializedRoot({
    agentId: params.agentId,
    targetMaterializedEnv: materializedEnv,
  }) ?? (materialized.cleanupOnFailure ? rootDir : null);
  const cleanupFinalRoot = bestEffortCleanupDirectory(rootDir);
  const cleanupOnFailure = materialized.cleanupOnFailure ? cleanupFinalRoot : materialized.cleanupOnFailure;
  const cleanupOnExit = materialized.cleanupOnExit ? cleanupFinalRoot : materialized.cleanupOnExit;
  return {
    ...materialized,
    cleanupOnFailure,
    cleanupOnExit,
    env: {
      ...materializedEnv,
      ...(targetMaterializedRoot
        ? { [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: targetMaterializedRoot }
        : null),
      ...(serializedSelections
        ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializedSelections }
        : null),
      ...(serializedMaterializedEnvKeys
        ? { [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: serializedMaterializedEnvKeys }
        : null),
    },
  };
}
