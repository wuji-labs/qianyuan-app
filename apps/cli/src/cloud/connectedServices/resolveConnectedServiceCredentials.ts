/**
 * Connected service credential resolver (client-side)
 *
 * Fetches sealed ciphertext from Happier Cloud and decrypts it locally using account-scoped crypto
 * material. The server never decrypts these payloads.
 */

import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

function parseConnectedServiceCredentialRecord(params: Readonly<{
  binding: { serviceId: ConnectedServiceId; profileId: string };
  value: unknown;
}>): ConnectedServiceCredentialRecordV1 {
  const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(params.value);
  if (!parsed.success) {
    throw new Error(`Invalid connected service credential payload (${params.binding.serviceId}/${params.binding.profileId})`);
  }
  return parsed.data;
}

async function readPlainConnectedServiceCredential(params: Readonly<{
  api: ConnectedServiceCredentialApi;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
  if (typeof params.api.getConnectedServiceCredentialPlain !== 'function') return null;
  const plain = await params.api.getConnectedServiceCredentialPlain({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!plain) return null;
  return parseConnectedServiceCredentialRecord({
    binding: params.binding,
    value: plain.content.v,
  });
}

async function readPlainConnectedServiceCredentialBestEffort(params: Readonly<{
  api: ConnectedServiceCredentialApi;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
  try {
    return await readPlainConnectedServiceCredential(params);
  } catch {
    return null;
  }
}

async function readSealedConnectedServiceCredential(params: Readonly<{
  api: ConnectedServiceCredentialApi;
  credentials: Credentials;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!sealed) return null;

  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: sealed.sealed.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error(`Failed to decrypt connected service credential (${params.binding.serviceId}/${params.binding.profileId})`);
  }

  return parseConnectedServiceCredentialRecord({
    binding: params.binding,
    value: opened.value,
  });
}

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: Credentials;
  api: ConnectedServiceCredentialApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const out = new Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>();
  const accountMode = await resolveConnectedServiceAccountMode(params.api);

  for (const binding of params.bindings) {
    if (accountMode !== 'e2ee') {
      const plain = accountMode === 'unknown'
        ? await readPlainConnectedServiceCredentialBestEffort({
            api: params.api,
            binding,
          })
        : await readPlainConnectedServiceCredential({
            api: params.api,
            binding,
          });
      if (plain) {
        out.set(binding.serviceId, plain);
        continue;
      }
      if (accountMode === 'plain') {
        throw new Error(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
      }
    }

    const sealed = await readSealedConnectedServiceCredential({
      api: params.api,
      credentials: params.credentials,
      binding,
    });
    if (!sealed) {
      throw new Error(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
    }
    out.set(binding.serviceId, sealed);
  }

  return out;
}
