import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { AgentId as CatalogAgentId } from '@happier-dev/agents';

import type { ConnectedServiceSameAccountFanoutStrategy } from '../quotas/identity/providerFanoutStrategy';

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

export type ConnectedServicePredictiveSoftSwitchLiveSessionRequirement =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'shared_group_auth_surface';
      serviceIds: ReadonlyArray<ConnectedServiceId>;
      authEnvKey: string;
      authEnvSubpath?: ReadonlyArray<string>;
    }>;

/**
 * Every field here must have a production consumer; capability declarations without an enforcing
 * consumer are banned (they rot into false claims — see the removed `refreshTokenRuntimeHandling`,
 * whose `daemon_only` claim was contradicted by every materialization embedding the OAuth refresh
 * token, and `runtimeAuthFailureClassifier`, which no dispatch ever read).
 *
 * Current consumers:
 * - `spawnPreflightOauthRefresh` — `resolveConnectedServiceAuthForSpawn`.
 * - `refreshedCredentialApplication` — `createConnectedServicesAuthUpdatedRestartHandler`.
 * - `predictiveSoftSwitch` — `predictiveSoftSwitchPolicy` (spawn + daemon scheduling).
 * - `sameAccountFanoutStrategy` — `ConnectedServiceQuotasCoordinator` exact same-account fanout.
 */
export type ConnectedServiceCredentialLifecycleDescriptor = Readonly<{
  providerId: CatalogAgentId;
  serviceIds: ReadonlyArray<ConnectedServiceId>;
  spawnPreflightOauthRefresh: Readonly<{
    mode: 'expiry_window' | 'force';
  }>;
  refreshedCredentialApplication: Readonly<{
    mode: 'restart_required' | 'hot_apply' | 'no_restart_required';
  }>;
  predictiveSoftSwitch: Readonly<{
    mode: 'supported' | 'unsupported';
    liveSessionRequirement?: ConnectedServicePredictiveSoftSwitchLiveSessionRequirement;
  }>;
  sameAccountFanoutStrategy: ConnectedServiceSameAccountFanoutStrategy;
}>;

export function buildDefaultConnectedServiceCredentialLifecycleDescriptor(
  providerId: CatalogAgentId,
): ConnectedServiceCredentialLifecycleDescriptor {
  return {
    providerId,
    serviceIds: [],
    spawnPreflightOauthRefresh: { mode: 'expiry_window' },
    refreshedCredentialApplication: { mode: 'no_restart_required' },
    predictiveSoftSwitch: { mode: 'unsupported', liveSessionRequirement: { kind: 'none' } },
    sameAccountFanoutStrategy: 'none',
  };
}
