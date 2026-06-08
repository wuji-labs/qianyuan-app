import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { AgentId as CatalogAgentId } from '@happier-dev/agents';

export type ConnectedServiceRefreshReason =
  | 'scheduled'
  | 'spawn_preflight'
  | 'runtime_auth_failure'
  | 'manual_reconnect'
  | 'provider_auth_bridge'
  | 'quota_bridge';

export type ConnectedServiceRefreshFailureCategory =
  | 'invalid_grant'
  | 'invalid_client'
  | 'provider_401'
  | 'provider_403'
  | 'network_error'
  | 'malformed_response'
  | 'missing_access_token'
  | 'missing_refresh_token'
  | 'unknown';

export type ConnectedServiceCredentialLifecycleDescriptor = Readonly<{
  providerId: CatalogAgentId;
  serviceIds: ReadonlyArray<ConnectedServiceId>;
  spawnPreflightOauthRefresh: Readonly<{
    mode: 'expiry_window' | 'force';
  }>;
  refreshTokenRuntimeHandling:
    | 'not_applicable'
    | 'daemon_only'
    | 'runtime_provider_self_refresh_allowed';
  refreshedCredentialApplication: Readonly<{
    mode: 'restart_required' | 'hot_apply' | 'no_restart_required';
  }>;
  runtimeAuthFailureClassifier: Readonly<{
    available: boolean;
  }>;
}>;

export function buildDefaultConnectedServiceCredentialLifecycleDescriptor(
  providerId: CatalogAgentId,
): ConnectedServiceCredentialLifecycleDescriptor {
  return {
    providerId,
    serviceIds: [],
    spawnPreflightOauthRefresh: { mode: 'expiry_window' },
    refreshTokenRuntimeHandling: 'not_applicable',
    refreshedCredentialApplication: { mode: 'no_restart_required' },
    runtimeAuthFailureClassifier: { available: false },
  };
}
