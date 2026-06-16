import {
  inferAgentIdFromSessionMetadata,
  resolveAgentIdFromFlavor,
} from '@happier-dev/agents';
import {
  ConnectedServiceIdSchema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { createConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import { getSessionUsageLimitRecoveryControlAdapter } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { RoutedUsageLimitRecoveryResumePromptTierSources } from './resolveRoutedUsageLimitRecoveryResumePromptMode';
import type { ResolveSessionUsageLimitRecoveryControlAdapter } from './sessionUsageLimitRecoveryControlTypes';

type GroupPolicyApi = Readonly<{
  getConnectedServiceAuthGroup: (params: {
    serviceId: ConnectedServiceId;
    groupId: string;
  }) => Promise<ConnectedServiceAuthGroupV1 | null>;
}>;

export type BuildRoutedResumePromptTierSourcesParams = Readonly<{
  credentials?: Credentials;
  metadata: Record<string, unknown> | null;
  rawSession: RawSessionRecord;
  /** Backend provider id from the request payload (for example "codex"). */
  requestProvider?: string | null;
  /** Boundary seams (HTTP + provider catalog); production callers omit these. */
  resolveAdapter?: ResolveSessionUsageLimitRecoveryControlAdapter;
  createGroupPolicyApi?: (credentials: Credentials) => Promise<GroupPolicyApi>;
  readAccountSettings?: () => unknown;
}>;

function readGroupRefFromIntent(
  metadata: Record<string, unknown> | null,
): { serviceId: ConnectedServiceId; groupId: string } | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata?.[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success || parsed.data.selectedAuth.kind !== 'group') return null;
  return {
    serviceId: parsed.data.selectedAuth.serviceId,
    groupId: parsed.data.selectedAuth.groupId,
  };
}

function readGroupRefFromLatestIssue(
  rawSession: RawSessionRecord,
): { serviceId: ConnectedServiceId; groupId: string } | null {
  const parsed = SessionRuntimeIssueV1Schema.safeParse(
    (rawSession as Readonly<{ lastRuntimeIssue?: unknown }>).lastRuntimeIssue,
  );
  const connectedService = parsed.success ? parsed.data.usageLimit?.connectedService : null;
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(connectedService?.serviceId);
  const groupId = typeof connectedService?.groupId === 'string' ? connectedService.groupId.trim() : '';
  if (!serviceIdParsed.success || groupId.length === 0) return null;
  return { serviceId: serviceIdParsed.data, groupId };
}

/**
 * Builds the lower resume-prompt-mode precedence tiers (account setting,
 * group policy, provider config) for the routed usage-limit recovery owner.
 *
 * Group policy is fetched lazily from the server for the recovery's selected
 * auth group (stored intent first, latest usage-limit issue as fallback);
 * provider config is consulted lazily through the provider's usage-limit
 * recovery control adapter. Loader failures resolve as silent tiers.
 */
export function buildRoutedResumePromptTierSources(
  params: BuildRoutedResumePromptTierSourcesParams,
): RoutedUsageLimitRecoveryResumePromptTierSources {
  const readAccountSettings = params.readAccountSettings
    ?? (() => getActiveAccountSettingsSnapshot()?.settings ?? null);

  return {
    accountSettings: readAccountSettings(),
    loadGroupPolicy: async () => {
      const credentials = params.credentials;
      if (!credentials) return null;
      const groupRef = readGroupRefFromIntent(params.metadata)
        ?? readGroupRefFromLatestIssue(params.rawSession);
      if (!groupRef) return null;
      const api = await (params.createGroupPolicyApi ?? createConnectedServiceCredentialApi)(credentials);
      const group = await api.getConnectedServiceAuthGroup(groupRef);
      return group?.policy ?? null;
    },
    loadProviderConfig: async () => {
      const agentId = resolveAgentIdFromFlavor(params.requestProvider)
        ?? (params.metadata ? inferAgentIdFromSessionMetadata(params.metadata) : null);
      if (!agentId) return null;
      const resolveAdapter = params.resolveAdapter ?? getSessionUsageLimitRecoveryControlAdapter;
      const adapter = await resolveAdapter(agentId);
      return await adapter?.resolveResumePromptConfig?.() ?? null;
    },
  };
}
