import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

import { withCodexAppServerControlClient } from '../appServer/control/withCodexAppServerControlClient';
import { readCodexAuthStoreProviderAccountId } from './readCodexAuthStoreProviderAccountId';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

export const materializeCodexConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (params) => {
  if (params.input.serviceId !== 'openai-codex') return params.baseSelection;

  const cwd = typeof params.input.tracked.spawnOptions?.directory === 'string'
    ? params.input.tracked.spawnOptions.directory.trim()
    : '';
  if (!cwd) return params.baseSelection;

  const transport = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.input.sessionId,
  });
  if (!transport.ok) return params.baseSelection;

  const metadata = params.input.tracked.happySessionMetadataFromLocalWebhook ?? null;
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  const codexHome = typeof runtimeDescriptor?.homePath === 'string' && runtimeDescriptor.homePath.trim().length > 0
    ? runtimeDescriptor.homePath.trim()
    : null;
  const controlClientSupported = await withCodexAppServerControlClient({
    cwd,
    metadata,
    accountSettings: params.accountSettings ?? null,
    processEnv: params.processEnv,
    run: async () => undefined,
  });
  if (!controlClientSupported.ok) return params.baseSelection;

  return {
    ...params.baseSelection,
    client: {
      request: async (method: string, request: unknown) => {
        const result = await withCodexAppServerControlClient({
          cwd,
          metadata,
          accountSettings: params.accountSettings ?? null,
          processEnv: params.processEnv,
          run: async (client) => await client.request(method, request),
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        return result.value;
      },
    },
    ...(codexHome
      ? {
          readAuthStoreProviderAccountId: async () => await readCodexAuthStoreProviderAccountId(codexHome),
          // Durable adoption for hot-apply: the session app-server reloads
          // `<codexHome>/auth.json` when its transports are invalidated, so the
          // switched credential must be persisted there or the runtime would
          // resume on the previous account (post-switch verification then
          // rejects the hot apply and forces a restart).
          persistAuthStore: async () => {
            await writeCodexAuthStoreFile({
              codexHome,
              record: params.baseSelection.record as Parameters<typeof writeCodexAuthStoreFile>[0]['record'],
            });
          },
        }
      : {}),
    invalidateTransports: async () => {
      const rawResponse = await callSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
        request: {},
      });
      const parsedResponse = SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success) {
        throw new Error('invalid_connected_service_auth_invalidate_transports_response');
      }
      if (parsedResponse.data.ok !== true) {
        throw new Error(
          typeof parsedResponse.data.errorCode === 'string'
            ? parsedResponse.data.errorCode
            : parsedResponse.data.error,
        );
      }
    },
  };
};
