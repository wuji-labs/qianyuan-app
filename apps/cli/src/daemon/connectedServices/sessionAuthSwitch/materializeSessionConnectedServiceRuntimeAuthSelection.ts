import type { ApiClient } from '@/api/api';
import { materializeConnectedServiceRuntimeAuthSelectionThroughCatalog } from '@/backends/catalog';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { AccountSettings } from '@happier-dev/protocol';

import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from './switchSessionConnectedServiceAuth';

export async function materializeSessionConnectedServiceRuntimeAuthSelection(params: Readonly<{
  credentials: Credentials;
  api: ApiClient;
  activeServerDir?: string;
  input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput;
  accountSettings?: AccountSettings | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<unknown | null> {
  if (params.input.next.source !== 'connected') return null;
  const binding = params.input.normalizedBindings.bindingsByServiceId[params.input.serviceId];
  if (!binding || binding.source !== 'connected') return null;

  const profileId = typeof binding.profileId === 'string' ? binding.profileId.trim() : '';
  if (!profileId) return null;

  const records = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.input.serviceId, profileId }],
  });
  const record = records.get(params.input.serviceId);
  if (!record) return null;

  const previousSelection = findConnectedServiceChildSelection(
    params.input.tracked.spawnOptions?.environmentVariables ?? {},
    params.input.serviceId,
  );
  const previousGroupSelection =
    binding.selection === 'group'
    && previousSelection?.kind === 'group'
    && previousSelection.groupId === binding.groupId
      ? previousSelection
      : null;
  const groupMetadata =
    binding.selection === 'group'
    && params.input.groupMetadata?.groupId === binding.groupId
      ? params.input.groupMetadata
      : null;

  const baseSelection = {
    serviceId: params.input.serviceId,
    binding,
    profileId,
    ...(binding.selection === 'group'
      ? {
          groupId: binding.groupId,
          activeProfileId: binding.profileId,
          ...(previousGroupSelection || groupMetadata
            ? {
                fallbackProfileId: groupMetadata?.fallbackProfileId ?? previousGroupSelection?.fallbackProfileId,
                generation: groupMetadata?.generation ?? previousGroupSelection?.generation,
              }
            : {}),
        }
      : {}),
    record,
  };

  return await materializeConnectedServiceRuntimeAuthSelectionThroughCatalog(params.input.agentId, {
    ...params,
    baseSelection,
  }) ?? baseSelection;
}
