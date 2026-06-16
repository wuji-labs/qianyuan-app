import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import {
  findConnectedServiceBindingSelectionFromSessionMetadata,
  findConnectedServiceChildSelection,
  type ConnectedServiceRuntimeAuthMetadataSession,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildNativeQuotaProfileId } from '@/daemon/connectedServices/quotas/nativeQuotaProfileId';
import { notifyDaemonConnectedServiceQuotaSnapshot } from '@/daemon/controlClient';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';
import { mapCodexRateLimitSnapshotToQuotaSnapshot } from './mapCodexRateLimitSnapshot';
import {
  readCodexAuthStoreProviderAccountId,
  type CodexAuthStoreProviderAccountIdProof,
} from './readCodexAuthStoreProviderAccountId';

type NotifyQuotaSnapshot = (body: Readonly<{
  sessionId: string;
  serviceId: 'openai-codex';
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>) => Promise<unknown>;

async function resolveCodexNativeQuotaIdentity(env: Pick<NodeJS.ProcessEnv, string>): Promise<Readonly<{
  profileId: string;
  activeAccountId: string | null;
  accountLabel: string | null;
}>> {
  const codexHome = resolveConfiguredCodexHome(env);
  let proof: CodexAuthStoreProviderAccountIdProof;
  try {
    proof = await readCodexAuthStoreProviderAccountId(codexHome);
  } catch {
    proof = { status: 'missing' };
  }
  if (proof.status === 'resolved') {
    return {
      profileId: buildNativeQuotaProfileId({
        kind: 'acct',
        providerId: 'codex',
        material: proof.accountId,
      }),
      activeAccountId: proof.accountId,
      accountLabel: proof.accountEmail ?? null,
    };
  }
  return {
    profileId: buildNativeQuotaProfileId({
      kind: 'native',
      providerId: 'codex',
      material: codexHome,
    }),
    activeAccountId: null,
    accountLabel: null,
  };
}

// Snapshot attribution must follow the CURRENT member identity. After a hot-apply
// group switch the child env still names the pre-switch activeProfileId while the
// materialized auth store and the live app-server already belong to the new member;
// attributing post-switch healthy meters to the exhausted member would falsely
// clear its limiter (F7) and corrupt group selection. Same metadata-first→env
// order as `resolveOpenAiCodexDaemonRefreshSelection` and the classification context.
function resolveSelectedCodexProfileId(input: Readonly<{
  env: Pick<NodeJS.ProcessEnv, string>;
  session?: ConnectedServiceRuntimeAuthMetadataSession | null;
}>): string | null {
  if (input.session) {
    const binding = findConnectedServiceBindingSelectionFromSessionMetadata(input.session, 'openai-codex');
    if (binding?.source === 'connected') {
      if (binding.selection === 'group') {
        if (binding.profileId) return binding.profileId;
      } else {
        return binding.profileId;
      }
    }
  }
  const selection = findConnectedServiceChildSelection(input.env, 'openai-codex');
  if (!selection) return null;
  return selection.kind === 'group' ? selection.activeProfileId : selection.profileId;
}

export async function reportCodexRateLimitSnapshotToDaemon(input: Readonly<{
  env: Pick<NodeJS.ProcessEnv, string>;
  session?: ConnectedServiceRuntimeAuthMetadataSession | null;
  sessionId: string;
  rawSnapshot: unknown;
  // Live provider-account proof supplied by Codex app-server `account/read`.
  // Do not substitute auth-store identity for connected-service sessions.
  activeAccountId?: string | null;
  accountLabel?: string | null;
  nowMs?: number;
  notify?: NotifyQuotaSnapshot;
}>): Promise<void> {
  const selectedProfileId = resolveSelectedCodexProfileId(input);
  const nativeIdentity = await resolveCodexNativeQuotaIdentity(input.env);
  const identity = selectedProfileId
    ? {
        profileId: selectedProfileId,
        activeAccountId: input.activeAccountId ?? null,
        accountLabel: input.accountLabel ?? null,
      }
    : nativeIdentity;

  const snapshot = mapCodexRateLimitSnapshotToQuotaSnapshot({
    serviceId: 'openai-codex',
    profileId: identity.profileId,
    activeAccountId: identity.activeAccountId,
    accountLabel: identity.accountLabel,
    fetchedAt: input.nowMs ?? Date.now(),
    rawSnapshot: input.rawSnapshot,
  });
  await (input.notify ?? notifyDaemonConnectedServiceQuotaSnapshot)({
    sessionId: input.sessionId,
    serviceId: 'openai-codex',
    snapshot,
  });
}
