import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceResolvedSelection } from './materializeConnectedServicesForSpawn';

export type ConnectedServicesMaterializationDiagnostic = Readonly<{
  code: string;
  providerId: CatalogAgentId;
  severity?: 'warning' | 'blocking';
  serviceId?: ConnectedServiceId;
  requestedStateMode?: string;
  effectiveStateMode?: string;
  entryName?: string;
  reason?: string;
}>;

export function isBlockingConnectedServicesMaterializationDiagnostic(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): boolean {
  return diagnostic.severity === 'blocking';
}

export function collectBlockingConnectedServicesMaterializationDiagnostics(
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[] | undefined,
): readonly ConnectedServicesMaterializationDiagnostic[] {
  return (diagnostics ?? []).filter(isBlockingConnectedServicesMaterializationDiagnostic);
}

export type ConnectedServicesMaterializeResult = Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot?: string | null;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

export type ConnectedServicesProviderMaterializerInput = Readonly<{
  agentId: CatalogAgentId;
  activeServerDir: string;
  rootDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  cleanupRoot: () => void;
}>;

export type ConnectedServicesProviderMaterializer = (
  params: ConnectedServicesProviderMaterializerInput,
) => Promise<ConnectedServicesMaterializeResult | null>;
