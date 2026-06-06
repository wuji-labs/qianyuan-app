import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceUxDiagnosticCodeV1Schema,
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  type ConnectedServiceUxDiagnosticV1,
  type SpawnSessionResult,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialize/providerMaterializerTypes';
import { buildConnectedServiceUxDiagnostic } from './connectedServiceUxDiagnostics';

export function buildConnectedServiceDiagnosticSpawnValidationErrorResult(input: Readonly<{
  errorMessage: string;
  uxDiagnostic: ConnectedServiceUxDiagnosticV1;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    errorMessage: input.errorMessage,
    errorDetail: {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: input.uxDiagnostic,
    },
  };
}

export function buildConnectedServiceMaterializationSpawnErrorResult(input: Readonly<{
  agentId: CatalogAgentId;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
}>): Extract<SpawnSessionResult, { type: 'error' }> {
  const primary = input.diagnostics[0] ?? null;
  const parsedCode = ConnectedServiceUxDiagnosticCodeV1Schema.safeParse(primary?.code);
  const code = parsedCode.success
    ? parsedCode.data
    : CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed;
  return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
    errorMessage: code,
    uxDiagnostic: buildConnectedServiceUxDiagnostic({
      code,
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: input.agentId,
      ...(primary?.providerId ? { providerId: primary.providerId } : {}),
      ...(primary?.serviceId ? { serviceId: primary.serviceId } : {}),
      retryable: false,
      diagnostics: {
        reason: primary?.reason ?? null,
        materializationCode: primary?.code ?? null,
        entryName: primary?.entryName ?? null,
      },
    }),
  });
}
