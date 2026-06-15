import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
  applyCodexConnectedServiceAuthGeneration,
  evaluateCodexConnectedServiceHotApplyEligibility,
  recoverCodexConnectedServiceRestartResumeOnce,
} from './applyCodexConnectedServiceAuthGeneration';
import { classifyCodexConnectedServiceAuthFailure } from './classifyCodexConnectedServiceAuthFailure';
import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './mapCodexRateLimitSnapshot';
import { readCodexRateLimitsSnapshot } from '../appServer/readCodexRateLimitsSnapshot';
import { refreshCodexChatGptTokensForBridge } from './refreshCodexChatGptTokensForBridge';
import { verifyCodexConnectedServiceActiveAccount } from './verifyCodexConnectedServiceActiveAccount';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readSelectionRecord(input: ConnectedServiceRuntimeAuthTargetInput): Record<string, unknown> | null {
  return readRecord(input.selection);
}

function readCredentialRecord(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceCredentialRecordV1 | null {
  const selection = readSelectionRecord(input);
  const record = readRecord(selection?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function readLoginStartClient(value: unknown): { request: (method: string, params?: unknown) => Promise<unknown> } | null {
  const record = readRecord(value);
  return record && typeof record.request === 'function'
    ? { request: record.request as (method: string, params?: unknown) => Promise<unknown> }
    : null;
}

function readCodexLiveAccountIdentity(value: unknown): Readonly<{
  activeAccountId: string | null;
  accountLabel: string | null;
}> {
  const response = readRecord(value);
  const account = readRecord(response?.account) ?? response;
  return {
    activeAccountId: readString(account?.id ?? account?.accountId ?? account?.account_id ?? account?.chatgptAccountId ?? account?.chatgpt_account_id),
    accountLabel: readString(account?.email ?? account?.accountEmail ?? account?.account_email),
  };
}

function readAsyncCallback(value: unknown): (() => Promise<void>) | null {
  return typeof value === 'function'
    ? async () => { await value(); }
    : null;
}

function readForcedWorkspaceId(input: ConnectedServiceRuntimeAuthTargetInput): string | null {
  return readString(readSelectionRecord(input)?.forcedWorkspaceId);
}

function readRuntimeQuotaSnapshotStore(value: unknown): {
  recordSnapshot(input: Readonly<{
    serviceId: string;
    groupId: string;
    profileId: string;
    snapshot: unknown;
  }>): void;
} | null {
  const record = readRecord(value);
  return record && typeof record.recordSnapshot === 'function'
    ? {
        recordSnapshot: (record.recordSnapshot as (input: Readonly<{
          serviceId: string;
          groupId: string;
          profileId: string;
          snapshot: unknown;
        }>) => void).bind(record),
      }
    : null;
}

export function createCodexConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      const selection = readRecord(input.selection);
      return classifyCodexConnectedServiceAuthFailure({
        providerErrorPath: true,
        error: input.error,
        serviceId: 'openai-codex',
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId: readString(selection?.groupId),
      });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply(input) {
      const record = readCredentialRecord(input);
      if (!record) return { supported: false, reason: 'missing_record' };
      const eligibility = evaluateCodexConnectedServiceHotApplyEligibility({
        candidate: record,
        forcedWorkspaceId: readForcedWorkspaceId(input),
      });
      if (!eligibility.eligible) return { supported: false, reason: eligibility.reason };
      if (typeof readRecord(input.selection)?.invalidateTransports !== 'function') {
        return {
          supported: false,
          reason: 'transport_invalidation_unavailable',
          recovery: 'restart_resume',
        };
      }
      if (typeof readRecord(input.selection)?.persistAuthStore !== 'function') {
        return {
          supported: false,
          reason: 'auth_store_persistence_unavailable',
          recovery: 'restart_resume',
        };
      }
      return { supported: true };
    },
    async hotApply(input) {
      const record = readCredentialRecord(input);
      const client = readLoginStartClient(readRecord(input.selection)?.client);
      if (!record) return { applied: false, reason: 'missing_record' };
      if (!client) return { applied: false, reason: 'missing_client', recovery: 'restart_resume' };
      return await applyCodexConnectedServiceAuthGeneration({
        client,
        candidate: record,
        forcedWorkspaceId: readForcedWorkspaceId(input),
        invalidateTransports: readAsyncCallback(readRecord(input.selection)?.invalidateTransports),
        persistAuthStore: readAsyncCallback(readRecord(input.selection)?.persistAuthStore),
      });
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const restartAndResume = readRecord(input.selection)?.restartAndResume;
      if (typeof restartAndResume !== 'function') {
        return { recovered: false, reason: 'missing_restart_resume' };
      }
      return await recoverCodexConnectedServiceRestartResumeOnce({
        attemptsSoFar: readNonNegativeInteger(readRecord(input.selection)?.attemptsSoFar) ?? 0,
        restartAndResume: async () => {
          await restartAndResume();
          return { resumed: true };
        },
      });
    },
    async verifyActiveAccount(input) {
      return await verifyCodexConnectedServiceActiveAccount(input);
    },
    async probeQuota(input) {
      const selection = readSelectionRecord(input);
      const backendMode = readString(selection?.backendMode ?? readRecord(selection?.provider)?.backendMode);
      if (backendMode && backendMode !== 'appServer') {
        return {
          status: 'unsupported',
          reason: 'codex_quota_probe_unsupported_for_backend_mode',
        };
      }
      const client = readLoginStartClient(selection?.client);
      const record = readCredentialRecord(input);
      if (!record || !client) {
        return { status: 'unsupported' };
      }
      const rawSnapshot = await readCodexRateLimitsSnapshot({
        request: async (_method, params) => await client.request('account/rateLimits/read', params),
      });
      let liveIdentity: Readonly<{ activeAccountId: string | null; accountLabel: string | null }> = {
        activeAccountId: null,
        accountLabel: null,
      };
      try {
        liveIdentity = readCodexLiveAccountIdentity(await client.request('account/read', null));
      } catch {
        liveIdentity = {
          activeAccountId: null,
          accountLabel: null,
        };
      }
      const quotaSnapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
        serviceId: 'openai-codex',
        profileId: record.profileId,
        activeAccountId: liveIdentity.activeAccountId,
        accountLabel: liveIdentity.accountLabel ?? (record.kind === 'oauth' ? readString(record.oauth.providerEmail) : null),
        fetchedAt: Date.now(),
        rawSnapshot,
      });
      const groupId = readString(selection?.groupId);
      const runtimeQuotaSnapshots = readRuntimeQuotaSnapshotStore(selection?.runtimeQuotaSnapshots);
      if (groupId && runtimeQuotaSnapshots) {
        runtimeQuotaSnapshots.recordSnapshot({
          serviceId: 'openai-codex',
          groupId,
          profileId: record.profileId,
          snapshot: quotaSnapshot,
        });
      }
      return {
        status: 'available',
        quotaSnapshot,
      };
    },
    async refreshActiveProfile(input) {
      const record = readCredentialRecord(input);
      if (!record) return { status: 'unsupported', reason: 'missing_record' };
      const chatgptPlanType = readString(readSelectionRecord(input)?.chatgptPlanType);
      return await refreshCodexChatGptTokensForBridge({
        record,
        chatgptPlanType,
        now: Date.now(),
      });
    },
  };
}
