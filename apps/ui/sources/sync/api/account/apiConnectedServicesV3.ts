import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { createConnectedServiceApiError } from './connectedServiceApiError';

import {
  ConnectedServiceCredentialRecordV1Schema,
  StoredJsonContentEnvelopeSchema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export async function registerConnectedServiceCredentialPlain(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
    reconnect?: Readonly<{ allowProviderIdentityChange?: boolean }>;
  }>,
): Promise<void> {
  await backoff(async () => {
    const response = await serverFetch(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: { t: 'plain', v: params.record },
          ...(params.reconnect ? { reconnect: params.reconnect } : {}),
        }),
      },
      { includeAuth: false },
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        const json = await response.json().catch(() => null);
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_credential_request_failed',
        });
      }
      throw new Error(`Failed to connect ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    if (!json || (json as any).success !== true) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
  });
}

export async function deleteConnectedServiceCredentialV3(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string; cleanupGroupReferences?: boolean }>,
): Promise<void> {
  await backoff(async () => {
    const path = `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`
      + (params.cleanupGroupReferences ? '?cleanupGroupReferences=true' : '');
    const response = await serverFetch(
      path,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
        },
      },
      { includeAuth: false },
    );

    // Disconnect should be idempotent: if the credential is already gone, treat it as disconnected.
    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        const json = await response.json().catch(() => null);
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_credential_not_found',
        });
      }
      throw new Error(`Failed to disconnect ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    if (!json || (json as any).success !== true) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
  });
}

export async function getConnectedServiceCredentialPlain(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<Readonly<{ content: Readonly<{ t: 'plain'; v: ConnectedServiceCredentialRecordV1 }> }>> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
      },
      { includeAuth: false },
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        const json = await response.json().catch(() => null);
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_credential_not_found',
        });
      }
      throw new Error(`Failed to load ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    if (!json || typeof json !== 'object') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    const content = (json as { content?: unknown }).content;
    const parsed = StoredJsonContentEnvelopeSchema.safeParse(content);
    if (!parsed.success || parsed.data.t !== 'plain') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    const record = ConnectedServiceCredentialRecordV1Schema.safeParse(parsed.data.v);
    if (!record.success) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    return { content: { t: 'plain', v: record.data } };
  });
}
