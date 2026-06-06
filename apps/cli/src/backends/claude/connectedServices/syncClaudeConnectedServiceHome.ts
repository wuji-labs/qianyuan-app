import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
  type ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
  readConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServiceSessionFileImportDetail } from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';

import { claudeConnectedServiceStateSharingDescriptor } from './claudeConnectedServiceStateSharingDescriptor';
import { materializeClaudeWorkspaceTrust } from './materializeClaudeWorkspaceTrust';

const CLAUDE_CREDENTIAL_HOME_ENTRIES = Object.freeze([
  '.claude.json',
  '.credentials.json',
  'credentials.json',
  'auth.json',
  'accounts',
] as const);

type ClaudeStateMode = 'shared' | 'isolated';

export type SyncClaudeConnectedServiceHomeResult = Readonly<{
  providerId: 'claude';
  requestedStateMode: ClaudeStateMode;
  effectiveStateMode: ClaudeStateMode;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

function resolveClaudeHomeSharingSettings(
  settingsLike: AccountSettings | Readonly<Record<string, unknown>> | null | undefined,
): ConnectedServicesProviderStateSharingPolicyV1 {
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    settingsLike?.connectedServicesProviderStateSharingSettingsV1,
    'claude',
  );
}

function resolveVendorResumeIdFromImportedClaudeSession(
  detail: ConnectedServiceSessionFileImportDetail,
): string | null {
  for (const path of [detail.relativePath, detail.sourcePath, detail.destinationPath]) {
    const fileName = basename(path);
    if (!fileName.toLowerCase().endsWith('.jsonl')) continue;
    const candidate = fileName.replace(/\.jsonl$/i, '').trim();
    if (!candidate || candidate.includes('/') || candidate.includes('\\')) continue;
    return candidate;
  }
  return null;
}

async function removeClaudeCredentialEntries(
  targetDir: string,
  opts?: Readonly<{ preserveNativeCredentialFile?: boolean }>,
): Promise<void> {
  for (const entry of CLAUDE_CREDENTIAL_HOME_ENTRIES) {
    if (opts?.preserveNativeCredentialFile === true && entry === '.credentials.json') continue;
    await rm(join(targetDir, entry), { recursive: true, force: true });
  }
}

export async function syncClaudeConnectedServiceHome(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  preserveNativeCredentialFile?: boolean | undefined;
}>): Promise<SyncClaudeConnectedServiceHomeResult> {
  return await withConnectedServiceStateSharingDestinationLock(params.targetDir, async () => {
    const settings = resolveClaudeHomeSharingSettings(params.accountSettings ?? null);
    const sourceDir = resolveConfiguredClaudeConfigDir({ env: params.sourceEnv });
    await mkdir(params.targetDir, { recursive: true });

    if (resolve(sourceDir) === resolve(params.targetDir)) {
      return {
        providerId: 'claude',
        requestedStateMode: settings.stateMode,
        effectiveStateMode: settings.stateMode,
        diagnostics: [],
      };
    }

    const removeCredentialEntriesOptions = {
      preserveNativeCredentialFile: params.preserveNativeCredentialFile === true,
    };
    await removeClaudeCredentialEntries(params.targetDir, removeCredentialEntriesOptions);

    const existingManifest = await readConnectedServiceStateSharingManifest(params.targetDir);
    const applyResult = await applyConnectedServiceStateSharingDescriptor({
      descriptor: claudeConnectedServiceStateSharingDescriptor,
      nativeSourceContext: {
        sourceRoot: sourceDir,
        sourceEnv: params.sourceEnv as Record<string, string>,
      },
      target: {
        targetMaterializedRoot: params.targetDir,
        targetMaterializedEnv: {
          CLAUDE_CONFIG_DIR: params.targetDir,
        },
      },
      configMode: settings.configMode,
      requestedStateMode: settings.stateMode,
      effectiveStateMode: settings.stateMode,
      cwd: params.sessionDirectory ?? process.cwd(),
      existingManifest,
      sessionImportRoots: settings.stateMode === 'shared'
        ? [{
            sourceRoot: join(params.targetDir, 'projects'),
            destinationRoot: join(sourceDir, 'projects'),
            includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
          }]
        : [],
      resolveVendorResumeIdFromImportedFile: resolveVendorResumeIdFromImportedClaudeSession,
      providerLabel: 'Claude',
    });

    await removeClaudeCredentialEntries(params.targetDir, removeCredentialEntriesOptions);
    await materializeClaudeWorkspaceTrust({
      sourceEnv: params.sourceEnv,
      targetDir: params.targetDir,
      sessionDirectory: params.sessionDirectory ?? process.cwd(),
    });
    await writeConnectedServiceStateSharingManifest(params.targetDir, applyResult.manifest);

    return {
      providerId: 'claude',
      requestedStateMode: settings.stateMode,
      effectiveStateMode: applyResult.manifest.effectiveStateMode,
      diagnostics: applyResult.diagnostics,
    };
  }, { providerId: 'claude' });
}
