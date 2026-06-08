import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';

import { syncClaudeConnectedServiceHome } from '../syncClaudeConnectedServiceHome';
import {
  buildClaudeConnectedServiceHomeProvenance,
  writeClaudeConnectedServiceHomeProvenance,
} from '../claudeConnectedServiceHomeProvenance';
import { sanitizeClaudeRootConfigFile } from '../claudeRootConfig';
import { buildClaudeCodeCredentialPayload, writeClaudeCodeCredentialsFile } from './claudeCodeCredentialFile';
import { writeClaudeCodeMacOsKeychainCredential } from './claudeCodeMacOsKeychain';
import {
  classifyClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealthStatus,
} from './claudeCodeCredentialHealth';

export type ClaudeCodeNativeAuthMaterializationResult =
  | Readonly<{
      status: 'materialized';
      env: Record<string, string>;
      diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
      credentialPath: string;
    }>
  | Readonly<{
      status: 'diagnostic';
      env: Record<string, string>;
      diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
    }>;

export type ClaudeSubscriptionNativeAuthSelectionDescriptor =
  | Readonly<{
      kind: 'profile';
      serviceId: 'claude-subscription';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: 'claude-subscription';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
    }>;

export type ClaudeSubscriptionNativeAuthIdentityDiagnostic = Readonly<{
  serviceId: 'claude-subscription';
  selectionKind: 'profile' | 'group';
  profileId?: string;
  groupId?: string;
  activeProfileId?: string;
  targetRootKind: 'profile_home' | 'group_home';
  credentialHealthStatus: ClaudeCodeCredentialHealthStatus;
  hasProviderAccountId: boolean;
  hasProviderEmail: boolean;
}>;

export type ClaudeSubscriptionNativeAuthHomeMaterializationResult =
  ClaudeCodeNativeAuthMaterializationResult & Readonly<{
    identityDiagnostic: ClaudeSubscriptionNativeAuthIdentityDiagnostic;
  }>;

function diagnosticCodeForHealth(health: ClaudeCodeCredentialHealth): string {
  switch (health.status) {
    case 'missing_required_scope':
      return 'claude_subscription_missing_claude_code_scope';
    case 'unsupported_credential_kind':
      return 'claude_subscription_setup_token_not_supported_for_unified';
    case 'missing_access_token':
    case 'missing_refresh_token':
    case 'unsupported_service':
    case 'ok':
      return 'claude_subscription_native_auth_materialization_failed';
  }
}

function diagnosticForHealth(health: ClaudeCodeCredentialHealth): ConnectedServicesMaterializationDiagnostic {
  return {
    code: diagnosticCodeForHealth(health),
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: health.status,
    ...(health.missingScopes.length > 0 ? { entryName: health.missingScopes.join(' ') } : {}),
  };
}

function diagnosticForCredentialFileWriteFailure(): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_subscription_native_auth_materialization_failed',
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: 'credential_file_write_failed',
  };
}

function diagnosticForKeychainWriteFailure(): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_subscription_native_auth_keychain_write_failed',
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: 'keychain_write_failed',
  };
}

export function diagnoseClaudeCodeNativeAuthMaterialization(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}>): readonly ConnectedServicesMaterializationDiagnostic[] {
  const built = buildClaudeCodeCredentialPayload(params.record);
  return built.status === 'ok' ? [] : [diagnosticForHealth(built.health)];
}

export async function materializeClaudeCodeNativeAuth(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  claudeConfigDir: string;
}>): Promise<ClaudeCodeNativeAuthMaterializationResult> {
  const built = buildClaudeCodeCredentialPayload(params.record);
  if (built.status !== 'ok') {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      diagnostics: [diagnosticForHealth(built.health)],
    };
  }
  let credentialPath: string;
  try {
    credentialPath = await writeClaudeCodeCredentialsFile({
      claudeConfigDir: params.claudeConfigDir,
      payload: built.payload,
    });
  } catch {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      diagnostics: [diagnosticForCredentialFileWriteFailure()],
    };
  }
  return {
    status: 'materialized',
    env: {
      CLAUDE_CONFIG_DIR: params.claudeConfigDir,
    },
    diagnostics: [],
    credentialPath,
  };
}

function hasNonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildClaudeSubscriptionNativeAuthIdentityDiagnostic(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  credentialHealthStatus: ClaudeCodeCredentialHealthStatus;
}>): ClaudeSubscriptionNativeAuthIdentityDiagnostic {
  const recordOauth = params.record.kind === 'oauth' ? params.record.oauth : null;
  const base = {
    serviceId: 'claude-subscription' as const,
    credentialHealthStatus: params.credentialHealthStatus,
    hasProviderAccountId: hasNonBlankString(recordOauth?.providerAccountId),
    hasProviderEmail: hasNonBlankString(recordOauth?.providerEmail),
  };
  if (params.selectionDescriptor.kind === 'group') {
    return {
      ...base,
      selectionKind: 'group',
      groupId: params.selectionDescriptor.groupId,
      activeProfileId: params.selectionDescriptor.activeProfileId,
      targetRootKind: 'group_home',
    };
  }
  return {
    ...base,
    selectionKind: 'profile',
    profileId: params.selectionDescriptor.profileId,
    targetRootKind: 'profile_home',
  };
}

export async function materializeClaudeSubscriptionNativeAuthHome(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  targetClaudeConfigDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
}>): Promise<ClaudeSubscriptionNativeAuthHomeMaterializationResult> {
  const health = classifyClaudeCodeCredentialHealth(params.record);
  const builtCredentialPayload = buildClaudeCodeCredentialPayload(params.record);
  const identityDiagnostic = buildClaudeSubscriptionNativeAuthIdentityDiagnostic({
    record: params.record,
    selectionDescriptor: params.selectionDescriptor,
    credentialHealthStatus: health.status,
  });
  if (health.status !== 'ok') {
    const materialized = await materializeClaudeCodeNativeAuth({
      record: params.record,
      claudeConfigDir: params.targetClaudeConfigDir,
    });
    return {
      ...materialized,
      identityDiagnostic,
    };
  }
  if (builtCredentialPayload.status !== 'ok') {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
      diagnostics: [diagnosticForHealth(builtCredentialPayload.health)],
      identityDiagnostic,
    };
  }

  await mkdir(dirname(params.targetClaudeConfigDir), { recursive: true });
  const stagedClaudeConfigDir = await mkdtemp(join(dirname(params.targetClaudeConfigDir), '.happier-claude-config-'));
  try {
    const syncResult = await syncClaudeConnectedServiceHome({
      sourceEnv: params.sourceEnv,
      targetDir: stagedClaudeConfigDir,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      preserveNativeCredentialFile: true,
      sharingPolicyOverride: {
        configMode: 'copied',
        stateMode: 'isolated',
      },
      importSessionFilesFromSourceProjects: true,
    });
    await sanitizeClaudeRootConfigFile(join(stagedClaudeConfigDir, '.claude.json'));
    const materialized = await materializeClaudeCodeNativeAuth({
      record: params.record,
      claudeConfigDir: stagedClaudeConfigDir,
    });
    if (materialized.status !== 'materialized') {
      return {
        ...materialized,
        env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
        diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
        identityDiagnostic,
      };
    }
    await writeClaudeConnectedServiceHomeProvenance({
      claudeConfigDir: stagedClaudeConfigDir,
      provenance: buildClaudeConnectedServiceHomeProvenance({
        record: params.record,
        selectionDescriptor: params.selectionDescriptor,
      }),
    });
    await replaceDirectoryAtomically({
      stagedDir: stagedClaudeConfigDir,
      targetDir: params.targetClaudeConfigDir,
    });
    if (process.platform === 'darwin') {
      try {
        await writeClaudeCodeMacOsKeychainCredential({
          claudeConfigDir: params.targetClaudeConfigDir,
          homeDir: params.sourceEnv.HOME,
          username: params.sourceEnv.USER,
          payload: builtCredentialPayload.payload,
        });
      } catch {
        return {
          status: 'diagnostic',
          env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
          diagnostics: [...syncResult.diagnostics, diagnosticForKeychainWriteFailure()],
          identityDiagnostic,
        };
      }
    }
    return {
      ...materialized,
      env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
      credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
      diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
      identityDiagnostic,
    };
  } finally {
    await rm(stagedClaudeConfigDir, { recursive: true, force: true }).catch(() => {});
  }
}
