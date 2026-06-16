import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import { mapClaudeRateLimitEventToUsageDetails } from './mapClaudeRateLimitEventToUsageDetails';
import { resolveClaudeConnectedServiceRuntimeAuthSwitchPlan } from './claudeConnectedServiceRuntimeAuthSwitchPlan';
import { classifyClaudeCodeCredentialHealth } from './nativeAuth/claudeCodeCredentialHealth';
import { verifyClaudeCodeNativeAuth } from './nativeAuth/verifyClaudeCodeNativeAuth';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readCredentialRecord(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceCredentialRecordV1 | null {
  const selection = readRecord(input.selection);
  const record = readRecord(selection?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function readClaudeConfigDir(input: ConnectedServiceRuntimeAuthTargetInput): string | null {
  const selection = readRecord(input.selection);
  const env = readRecord(selection?.targetMaterializedEnv)
    ?? readRecord(selection?.materializedEnv)
    ?? readRecord(selection?.env);
  return readString(env?.CLAUDE_CONFIG_DIR);
}

export function createClaudeConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      const authClassification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        error: input.error,
        selection: input.selection,
      });
      if (authClassification) return authClassification;

      const details = mapClaudeRateLimitEventToUsageDetails(input.error);
      // The raw payload rides along even when details mapped, so the classifier can recover reset
      // timing the mapper could not place in the details (INC-4).
      return classifyClaudeConnectedServiceRuntimeAuthFailure({
        ...(details ? { details } : {}),
        error: input.error,
        selection: input.selection,
      });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply() {
      return { applied: false, reason: 'hot_apply_unsupported', recovery: 'restart_rematerialize' };
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const record = readCredentialRecord(input);
      return {
        recovered: false,
        recovery: 'restart_rematerialize',
        ...(record ? { plan: resolveClaudeConnectedServiceRuntimeAuthSwitchPlan(record) } : {}),
      };
    },
    async verifyActiveAccount(input) {
      const record = readCredentialRecord(input);
      if (!record) {
        return {
          status: 'unavailable',
          retryable: true,
          reason: 'missing_connected_service_record',
        };
      }
      if (record.serviceId === 'anthropic') {
        return {
          status: 'verified',
          providerAccountId: record.kind === 'token' ? record.token.providerAccountId : record.oauth.providerAccountId,
          reason: 'anthropic_api_key_materialized',
        };
      }
      const recordHealth = classifyClaudeCodeCredentialHealth(record);
      if (recordHealth.status !== 'ok') {
        return {
          status: 'unavailable',
          retryable: false,
          reason: recordHealth.status,
          errorClassification: {
            missingScopes: [...recordHealth.missingScopes],
          },
        };
      }
      const claudeConfigDir = readClaudeConfigDir(input);
      if (!claudeConfigDir) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_materialized_claude_config_dir',
          errorClassification: {
            missingScopes: [],
          },
        };
      }
      const nativeAuth = await verifyClaudeCodeNativeAuth({ claudeConfigDir });
      if (nativeAuth.status !== 'ok') {
        return {
          status: 'unavailable',
          // An expired materialized credential is recoverable via a fresh credential
          // refresh + rematerialize; shape/scope defects are not.
          retryable: nativeAuth.status === 'expired',
          reason: nativeAuth.status,
          errorClassification: {
            missingScopes: [...nativeAuth.missingScopes],
          },
        };
      }
      return {
        status: 'unavailable',
        retryable: true,
        reason: 'claude_code_runtime_account_adoption_unproven',
        errorClassification: {
          missingScopes: [],
        },
      };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
