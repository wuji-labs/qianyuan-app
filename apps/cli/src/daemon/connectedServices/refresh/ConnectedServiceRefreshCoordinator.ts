import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
  type AccountSettings,
  type ConnectedServiceCredentialHealthV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import {
  resolveCodexChatGptAuthTokensRefreshProfileId,
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';
import { materializeCodexChatGptRefreshBridgeSelection } from '@/backends/codex/connectedServices/materializeCodexChatGptRefreshBridgeSelection';

import { parseConnectedServicesBindings } from '../parseConnectedServicesBindings';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  materializeConnectedServicesForSpawn,
  type ConnectedServiceResolvedSelection,
} from '../materialize/materializeConnectedServicesForSpawn';
import {
  collectBlockingConnectedServicesMaterializationDiagnostics,
  type ConnectedServicesMaterializationDiagnostic,
} from '../materialize/providerMaterializerTypes';
import { resolveMissingClaudeSubscriptionClaudeCodeScopes } from '../descriptors/connectedAccountDescriptors';
import { refreshConnectedAccountOauthTokens } from './serviceRefreshers';
import { ConnectedServiceOauthRefreshError } from './serviceRefreshers';
import type {
  ConnectedServiceRefreshFailureCategory,
  ConnectedServiceRefreshReason,
} from '@/daemon/connectedServices/credentials/lifecycleTypes';
import {
  readConnectedServiceChildSelectionsFromEnv,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';

type BoundProfile = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
type ConnectedServiceCredentialSource =
  | Readonly<{ mode: 'plain'; record: ConnectedServiceCredentialRecordV1 }>
  | Readonly<{
    mode: 'sealed';
    record: ConnectedServiceCredentialRecordV1;
    metadata: { kind: 'oauth' | 'token'; expiresAt?: number | null };
  }>;

export type ConnectedServiceCredentialRefreshStatus =
  | 'refreshed'
  | 'not_needed'
  | 'not_oauth'
  | 'lease_not_acquired'
  | 'credential_missing'
  | 'refresh_failed';

export type ConnectedServiceCredentialRefreshDiagnostic = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  reason: ConnectedServiceRefreshReason;
  status: ConnectedServiceCredentialRefreshStatus;
  category?: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  expiresAt?: number | null;
  expiryAgeMs?: number | null;
  refreshWindowMs: number;
}>;

export type ConnectedServiceCredentialRefreshResult = Readonly<{
  status: ConnectedServiceCredentialRefreshStatus;
  credential: ConnectedServiceCredentialRecordV1 | null;
  diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
}>;

export type ConnectedServiceCredentialHealthNotificationStatus =
  | 'reconnect_required'
  | 'refresh_failed_retryable';

export type ConnectedServiceCredentialHealthNotificationTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  sessionId: string;
}>;

type SpawnTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  sessionId: string | null;
  materializationKey: string;
  bindings: ReadonlyArray<BoundProfile>;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection>;
}>;

function bindingKey(binding: BoundProfile): string {
  return `${binding.serviceId}/${binding.profileId}`;
}

/**
 * A forced caller may adopt an already-in-flight refresh only when that refresh actually
 * exercised (or attempted) a rotation. A `not_needed` early-return performed no rotation, so a
 * forced caller must still run its own refresh; every other outcome is either a real rotation or a
 * terminal condition that a duplicate concurrent refresh would not improve.
 */
function inFlightResultSatisfiesCaller(
  result: ConnectedServiceCredentialRefreshResult,
  caller: Readonly<{ force: boolean }>,
): boolean {
  if (!caller.force) return true;
  return result.status !== 'not_needed';
}

function isReauthRequiredFailure(category: ConnectedServiceRefreshFailureCategory): boolean {
  return category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function isReconnectRequiredProfileStatus(status: unknown): boolean {
  return status === 'needs_reauth';
}

function shouldBlockRefreshForCredentialHealth(reason: ConnectedServiceRefreshReason): boolean {
  return reason === 'scheduled'
    || reason === 'spawn_preflight'
    || reason === 'runtime_auth_failure'
    || reason === 'quota_bridge';
}

function providerHttpStatusForHealth(status: number | null | undefined): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

function providerErrorCodeForHealth(code: string | null | undefined): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed.length > 0 ? trimmed.slice(0, 128) : undefined;
}

async function defaultSleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, Math.trunc(ms)));
    (timeout as unknown as { unref?: () => void }).unref?.();
  });
}

function selectionToBoundProfile(selection: ConnectedServiceChildSelection): BoundProfile {
  return {
    serviceId: selection.serviceId,
    profileId: selection.kind === 'group' ? selection.activeProfileId : selection.profileId,
  };
}

function buildSelectionsByServiceId(env: Pick<NodeJS.ProcessEnv, string> | undefined): ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection> {
  const selections = readConnectedServiceChildSelectionsFromEnv(env ?? {});
  return new Map(selections.map((selection) => [selection.serviceId, selection]));
}

function buildRefreshDiagnostic(params: Readonly<{
  binding: BoundProfile;
  reason: ConnectedServiceRefreshReason;
  status: ConnectedServiceCredentialRefreshStatus;
  category?: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  expiresAt?: number | null;
  now: number;
  refreshWindowMs: number;
}>): ConnectedServiceCredentialRefreshDiagnostic {
  const expiresAt = params.expiresAt ?? null;
  return {
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    reason: params.reason,
    status: params.status,
    ...(params.category ? { category: params.category } : {}),
    ...(params.providerStatus !== undefined ? { providerStatus: params.providerStatus } : {}),
    ...(params.providerErrorCode !== undefined ? { providerErrorCode: params.providerErrorCode } : {}),
    expiresAt,
    expiryAgeMs: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? params.now - expiresAt : null,
    refreshWindowMs: params.refreshWindowMs,
  };
}

export class ConnectedServiceCredentialRefreshError extends Error {
  readonly diagnostic: ConnectedServiceCredentialRefreshDiagnostic;

  constructor(diagnostic: ConnectedServiceCredentialRefreshDiagnostic) {
    super(`Connected service credential refresh failed: ${diagnostic.serviceId}/${diagnostic.profileId} ${diagnostic.category ?? 'unknown'}`);
    this.name = 'ConnectedServiceCredentialRefreshError';
    this.diagnostic = diagnostic;
  }
}

function buildResolvedSelectionsForTarget(
  target: SpawnTarget,
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>,
): ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection> {
  const selectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceResolvedSelection>();
  for (const selection of target.selectionsByServiceId.values()) {
    const record = recordsByServiceId.get(selection.serviceId);
    if (!record) continue;
    if (selection.kind === 'group') {
      selectionsByServiceId.set(selection.serviceId, {
        kind: 'group',
        serviceId: selection.serviceId,
        groupId: selection.groupId,
        activeProfileId: selection.activeProfileId,
        fallbackProfileId: selection.fallbackProfileId,
        generation: selection.generation,
        record,
        policy: null,
      });
      continue;
    }
    selectionsByServiceId.set(selection.serviceId, {
      kind: 'profile',
      serviceId: selection.serviceId,
      profileId: selection.profileId,
      record,
    });
  }
  return selectionsByServiceId;
}

function openConnectedServiceRecord(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): ConnectedServiceCredentialRecordV1 {
  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: params.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error('Failed to decrypt connected service credential');
  }
  return ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
}

function buildUpdatedOauthRecord(params: Readonly<{
  now: number;
  record: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' };
  next: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    scope?: string | null;
    tokenType?: string | null;
    providerAccountId?: string | null;
    providerEmail?: string | null;
    expiresAt: number | null;
  }>;
}>): ConnectedServiceCredentialRecordV1 {
  return ConnectedServiceCredentialRecordV1Schema.parse({
    ...params.record,
    updatedAt: params.now,
    expiresAt: params.next.expiresAt,
    oauth: {
      ...params.record.oauth,
      accessToken: params.next.accessToken,
      refreshToken: params.next.refreshToken,
      idToken: params.next.idToken,
      scope: params.next.scope ?? params.record.oauth.scope,
      tokenType: params.next.tokenType ?? params.record.oauth.tokenType,
      providerAccountId: params.next.providerAccountId ?? params.record.oauth.providerAccountId,
      providerEmail: params.next.providerEmail ?? params.record.oauth.providerEmail,
    },
  });
}

function hasObservedOauthCredentialChanged(
  before: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
  after: ConnectedServiceCredentialRecordV1 & { kind: 'oauth' },
): boolean {
  return before.updatedAt !== after.updatedAt
    || before.expiresAt !== after.expiresAt
    || before.oauth.accessToken !== after.oauth.accessToken
    || before.oauth.refreshToken !== after.oauth.refreshToken
    || before.oauth.idToken !== after.oauth.idToken
    || before.oauth.scope !== after.oauth.scope
    || before.oauth.tokenType !== after.oauth.tokenType;
}

export class ConnectedServiceRefreshCoordinator {
  private readonly targetsByPid = new Map<number, SpawnTarget>();
  private readonly inFlightRefreshes = new Map<string, Promise<ConnectedServiceCredentialRefreshResult>>();

  constructor(private readonly params: Readonly<{
    api: ApiClient;
    credentials: Credentials;
    machineIdProvider: () => string;
    ownerIdProvider?: () => string | null | undefined;
    activeServerDir: string;
    baseDir: string;
    refreshWindowMs: number;
    refreshLeaseMs: number;
    leaseContentionWaitMaxMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
    now: () => number;
    accountSettingsProvider?: () => AccountSettings | Readonly<Record<string, unknown>> | null | undefined;
    processEnv?: NodeJS.ProcessEnv;
    onAuthUpdated?: (event: Readonly<{
      binding: BoundProfile;
      affectedTargets: ReadonlyArray<SpawnTarget>;
      trigger: 'refresh_triggered_restart' | 'reconnect_propagation';
    }>) => void | Promise<void>;
    onCredentialHealthNotification?: (event: Readonly<{
      diagnostic: ConnectedServiceCredentialRefreshDiagnostic;
      healthStatus: ConnectedServiceCredentialHealthNotificationStatus;
      affectedTargets: ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget>;
    }>) => void | Promise<void>;
    logRefreshDiagnostic?: (diagnostic: ConnectedServiceCredentialRefreshDiagnostic) => void;
  }>) {}

  registerSpawnTarget(params: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    sessionId?: string | null;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string>;
  }>): void {
    const selectionsByServiceId = buildSelectionsByServiceId(params.connectedServiceSelectionsEnv);
    const bindings = selectionsByServiceId.size > 0
      ? Array.from(selectionsByServiceId.values()).map(selectionToBoundProfile)
      : parseConnectedServicesBindings(params.connectedServicesBindingsRaw);
    if (bindings.length === 0) return;
    this.targetsByPid.set(params.pid, {
      pid: params.pid,
      agentId: params.agentId,
      sessionId: typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : null,
      materializationKey: params.materializationKey,
      bindings,
      selectionsByServiceId,
    });
  }

  unregisterPid(pid: number): void {
    this.targetsByPid.delete(pid);
  }

  transferPid(fromPid: number, toPid: number): void {
    const target = this.targetsByPid.get(fromPid);
    if (!target) return;
    this.targetsByPid.delete(fromPid);
    this.targetsByPid.set(toPid, {
      ...target,
      pid: toPid,
    });
  }

  async tickOnce(): Promise<void> {
    const now = this.params.now();
    const unique = new Map<string, BoundProfile>();
    const errors: unknown[] = [];

    for (const target of this.targetsByPid.values()) {
      for (const binding of target.bindings) {
        unique.set(bindingKey(binding), binding);
      }
    }

    for (const binding of unique.values()) {
      try {
        await this.maybeRefreshBinding(binding, now);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Connected services refresh tick failed');
    }
  }

  async refreshOpenAiCodexChatGptTokensForBridge(input: Readonly<{
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
  }>): Promise<CodexChatGptAuthTokensRefreshResponse> {
    const profileId = resolveCodexChatGptAuthTokensRefreshProfileId(input.selection);
    const updated = await this.refreshOauthBinding(
      { serviceId: 'openai-codex', profileId },
      this.params.now(),
      { force: true, reason: 'provider_auth_bridge' },
    );
    if (updated.status !== 'refreshed' || updated.credential?.kind !== 'oauth') {
      throw new Error('connected_service_chatgpt_refresh_unavailable');
    }

    await materializeCodexChatGptRefreshBridgeSelection({
      selection: input.selection,
      record: updated.credential,
      activeServerDir: this.params.activeServerDir,
      baseDir: this.params.baseDir,
      accountSettings: this.params.accountSettingsProvider?.() ?? null,
      processEnv: this.params.processEnv ?? process.env,
    });

    return {
      accessToken: updated.credential.oauth.accessToken,
      chatgptAccountId: updated.credential.oauth.providerAccountId,
      chatgptPlanType: input.chatgptPlanType,
    };
  }

  async refreshConnectedServiceCredentialForQuota(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force: boolean;
  }>): Promise<ConnectedServiceCredentialRecordV1 | null> {
    const result = await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: input.force, reason: 'quota_bridge' },
    );
    return result.status === 'refreshed' ? result.credential : null;
  }

  async refreshConnectedServiceCredentialForSpawnPreflight(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force?: boolean;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    return await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: input.force === true, reason: 'spawn_preflight' },
    );
  }

  async refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ConnectedServiceCredentialRefreshResult> {
    return await this.refreshOauthBinding(
      { serviceId: input.serviceId, profileId: input.profileId },
      this.params.now(),
      { force: true, reason: 'runtime_auth_failure' },
    );
  }

  async handleExternalCredentialUpdate(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<void> {
    const profileId = String(input.profileId ?? '').trim();
    if (!profileId) return;
    const binding = { serviceId: input.serviceId, profileId } satisfies BoundProfile;
    const affectedTargets = await this.rematerializeTargetsForBinding(binding);
    if (affectedTargets.length === 0) return;
    await this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'reconnect_propagation',
    });
  }

  private async maybeRefreshBinding(binding: BoundProfile, now: number): Promise<void> {
    const result = await this.refreshOauthBinding(binding, now, { force: false, reason: 'scheduled' });
    if (result.status === 'refresh_failed') {
      throw new ConnectedServiceCredentialRefreshError(result.diagnostic);
    }
    if (result.status !== 'refreshed') return;

    const affectedTargets = await this.rematerializeTargetsForBinding(binding);
    if (affectedTargets.length === 0) return;
    await this.params.onAuthUpdated?.({
      binding,
      affectedTargets,
      trigger: 'refresh_triggered_restart',
    });
  }

  private async isRefreshBlockedByCredentialHealth(binding: BoundProfile): Promise<boolean> {
    const listProfiles = this.params.api.listConnectedServiceProfiles;
    if (typeof listProfiles !== 'function') return false;
    try {
      const result = await listProfiles.call(this.params.api, { serviceId: binding.serviceId });
      const profile = result.profiles.find((candidate) => candidate.profileId === binding.profileId);
      return isReconnectRequiredProfileStatus(profile?.status);
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to read connected-service profile health before refresh', {
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        error: serializeAxiosErrorForLog(error),
      });
      return false;
    }
  }

  private async readCredentialForRefresh(binding: BoundProfile): Promise<ConnectedServiceCredentialSource | null> {
    const accountMode = await resolveConnectedServiceAccountMode(this.params.api);
    if (accountMode !== 'e2ee' && typeof this.params.api.getConnectedServiceCredentialPlain === 'function') {
      const plain = accountMode === 'unknown'
        ? await this.params.api.getConnectedServiceCredentialPlain({
            serviceId: binding.serviceId,
            profileId: binding.profileId,
          }).catch(() => null)
        : await this.params.api.getConnectedServiceCredentialPlain({
            serviceId: binding.serviceId,
            profileId: binding.profileId,
          });
      if (plain) {
        return { mode: 'plain', record: ConnectedServiceCredentialRecordV1Schema.parse(plain.content.v) };
      }
      if (accountMode === 'plain') return null;
    }

    const sealed = await this.params.api.getConnectedServiceCredentialSealed({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
    });
    if (!sealed) return null;
    const record = openConnectedServiceRecord({
      credentials: this.params.credentials,
      ciphertext: sealed.sealed.ciphertext,
    });
    return { mode: 'sealed', record, metadata: sealed.metadata };
  }

  private async persistRefreshedCredential(
    binding: BoundProfile,
    source: ConnectedServiceCredentialSource,
    updated: ConnectedServiceCredentialRecordV1,
  ): Promise<void> {
    if (source.mode === 'plain') {
      await this.params.api.registerConnectedServiceCredentialPlain({
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        content: { t: 'plain', v: updated },
      });
      return;
    }

    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material:
        this.params.credentials.encryption.type === 'legacy'
          ? { type: 'legacy', secret: this.params.credentials.encryption.secret }
          : { type: 'dataKey', machineKey: this.params.credentials.encryption.machineKey },
      payload: updated,
      randomBytes: (length) => randomBytes(length),
    });

    await this.params.api.registerConnectedServiceCredentialSealed({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
      metadata: {
        kind: updated.kind,
        providerEmail: updated.kind === 'oauth' ? updated.oauth.providerEmail : null,
        providerAccountId: updated.kind === 'oauth' ? updated.oauth.providerAccountId : null,
        expiresAt: updated.expiresAt,
      },
    });
  }

  private async refreshOauthBinding(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    // Coalesce + serialize per `{serviceId, profileId}` binding (NOT split on `force`). A rotation
    // consumes the refresh token server-side, so two concurrent refreshes for one binding could each
    // present the same record and mint a superseded (401-bound) token. Any caller that arrives while a
    // refresh is in flight awaits it; a forced caller adopts that result when it rotated, otherwise it
    // runs its own refresh chained strictly after (never concurrently) so it reads the freshly persisted
    // record.
    const key = bindingKey(binding);
    const existing = this.inFlightRefreshes.get(key);
    if (existing) {
      // A rejecting in-flight refresh represents an attempt that re-running concurrently would not
      // improve; every joiner adopts the same rejection rather than firing a duplicate refresh.
      const observed = await existing;
      if (inFlightResultSatisfiesCaller(observed, options)) {
        return observed;
      }
      // Forced caller behind a non-rotating `not_needed`: run a fresh refresh, serialized after it.
    }

    const previous = this.inFlightRefreshes.get(key);
    const promise = (async () => {
      if (previous) {
        // Serialize behind any refresh already running for this binding before reading/rotating so a
        // chained refresh reads the freshly persisted (rotated) record instead of racing it.
        await previous.catch(() => undefined);
      }
      return await this.finalizeRefreshResult(
        await this.refreshOauthBindingUnserialized(binding, now, options),
      );
    })();
    this.inFlightRefreshes.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightRefreshes.get(key) === promise) {
        this.inFlightRefreshes.delete(key);
      }
    }
  }

  private async finalizeRefreshResult(
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    this.logRefreshDiagnostic(result.diagnostic);
    await this.persistCredentialHealthForRefreshResult(result);
    await this.notifyCredentialHealthForRefreshResult(result);
    return result;
  }

  private logRefreshDiagnostic(diagnostic: ConnectedServiceCredentialRefreshDiagnostic): void {
    if (this.params.logRefreshDiagnostic) {
      this.params.logRefreshDiagnostic(diagnostic);
      return;
    }
    logger.debug('[DAEMON RUN] Connected-service credential refresh diagnostic', diagnostic);
  }

  private async persistCredentialHealthForRefreshResult(
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<void> {
    if (result.status !== 'refreshed' && result.status !== 'refresh_failed') return;
    const updateHealth = this.params.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return;

    const diagnostic = result.diagnostic;
    const now = this.params.now();
    const health = result.status === 'refreshed'
      ? this.buildSuccessCredentialHealth(result, now)
      : this.buildFailureCredentialHealth(diagnostic, now);

    try {
      await updateHealth.call(this.params.api, {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        health,
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to update connected-service credential health after refresh', {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
  }

  private async notifyCredentialHealthForRefreshResult(
    result: ConnectedServiceCredentialRefreshResult,
  ): Promise<void> {
    if (result.status !== 'refresh_failed') return;
    const notify = this.params.onCredentialHealthNotification;
    if (!notify) return;

    const diagnostic = result.diagnostic;
    const binding = {
      serviceId: diagnostic.serviceId,
      profileId: diagnostic.profileId,
    };
    const category = diagnostic.category ?? 'unknown';
    const healthStatus: ConnectedServiceCredentialHealthNotificationStatus = isReauthRequiredFailure(category)
      ? 'reconnect_required'
      : 'refresh_failed_retryable';
    const affectedTargets = this.resolveNotificationTargetsForBinding(binding);

    try {
      await notify({
        diagnostic,
        healthStatus,
        affectedTargets,
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to dispatch connected-service credential health notification', {
        serviceId: diagnostic.serviceId,
        profileId: diagnostic.profileId,
        status: diagnostic.status,
        category: diagnostic.category ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
  }

  private resolveNotificationTargetsForBinding(
    binding: BoundProfile,
  ): ReadonlyArray<ConnectedServiceCredentialHealthNotificationTarget> {
    return Array.from(this.targetsByPid.values())
      .filter((target) => target.bindings.some((b) => b.serviceId === binding.serviceId && b.profileId === binding.profileId))
      .map((target) => ({
        pid: target.pid,
        agentId: target.agentId,
        sessionId: target.sessionId ?? target.materializationKey,
      }));
  }

  private buildFailureCredentialHealth(
    diagnostic: ConnectedServiceCredentialRefreshDiagnostic,
    now: number,
  ): ConnectedServiceCredentialHealthV1 {
    const category = diagnostic.category ?? 'unknown';
    return {
      v: 1,
      status: isReauthRequiredFailure(category) ? 'needs_reauth' : 'refresh_failed_retryable',
      reconnectRequired: isReauthRequiredFailure(category),
      lastRefreshAttemptAt: now,
      lastRefreshFailureAt: now,
      lastRefreshFailureKind: category,
      ...(providerHttpStatusForHealth(diagnostic.providerStatus) !== undefined
        ? { providerHttpStatus: providerHttpStatusForHealth(diagnostic.providerStatus) }
        : {}),
      ...(providerErrorCodeForHealth(diagnostic.providerErrorCode) !== undefined
        ? { providerErrorCode: providerErrorCodeForHealth(diagnostic.providerErrorCode) }
        : {}),
    };
  }

  private async persistCredentialHealthForMaterializationFailure(
    binding: BoundProfile,
    diagnostic: ConnectedServicesMaterializationDiagnostic,
  ): Promise<void> {
    const updateHealth = this.params.api.updateConnectedServiceCredentialHealth;
    if (typeof updateHealth !== 'function') return;

    const now = this.params.now();
    const providerErrorCode = providerErrorCodeForHealth(diagnostic.code);
    const health: ConnectedServiceCredentialHealthV1 = {
      v: 1,
      status: 'needs_reauth',
      reconnectRequired: true,
      lastRefreshAttemptAt: now,
      lastRefreshFailureAt: now,
      lastRefreshFailureKind: 'provider_403',
      providerHttpStatus: 403,
      ...(providerErrorCode ? { providerErrorCode } : {}),
    };

    try {
      await updateHealth.call(this.params.api, {
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        health,
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Failed to update connected-service credential health after materialization failure', {
        serviceId: binding.serviceId,
        profileId: binding.profileId,
        materializationCode: diagnostic.code,
        reason: diagnostic.reason ?? null,
        error: serializeAxiosErrorForLog(error),
      });
    }
  }

  private buildSuccessCredentialHealth(
    result: ConnectedServiceCredentialRefreshResult,
    now: number,
  ): ConnectedServiceCredentialHealthV1 {
    const credential = result.credential;
    if (
      credential?.serviceId === 'claude-subscription'
      && credential.kind === 'oauth'
      && resolveMissingClaudeSubscriptionClaudeCodeScopes(credential.oauth.scope).length > 0
    ) {
      return {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'missing_claude_code_scope',
      };
    }

    return {
      v: 1,
      status: 'connected',
      reconnectRequired: false,
      lastRefreshAttemptAt: now,
      lastRefreshSuccessAt: now,
    };
  }

  private async refreshOauthBindingUnserialized(
    binding: BoundProfile,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult> {
    const source = await this.readCredentialForRefresh(binding);
    if (!source) {
      return {
        status: 'credential_missing',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'credential_missing',
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const record = source.record;
    if (record.kind !== 'oauth') {
      return {
        status: 'not_oauth',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'not_oauth',
          expiresAt: record.expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const expiresAt = source.mode === 'plain' ? record.expiresAt : source.metadata.expiresAt ?? record.expiresAt;
    if (
      shouldBlockRefreshForCredentialHealth(options.reason)
      && await this.isRefreshBlockedByCredentialHealth(binding)
    ) {
      return {
        status: options.reason === 'spawn_preflight' || options.reason === 'runtime_auth_failure'
          ? 'refresh_failed'
          : 'not_needed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: options.reason === 'spawn_preflight' || options.reason === 'runtime_auth_failure'
            ? 'refresh_failed'
            : 'not_needed',
          ...(options.reason === 'spawn_preflight' || options.reason === 'runtime_auth_failure'
            ? { category: 'invalid_grant' as const }
            : {}),
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    if (!options.force) {
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
        return {
          status: 'not_needed',
          credential: null,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'not_needed',
            expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
      if (expiresAt - now > this.params.refreshWindowMs) {
        return {
          status: 'not_needed',
          credential: null,
          diagnostic: buildRefreshDiagnostic({
            binding,
            reason: options.reason,
            status: 'not_needed',
            expiresAt,
            now,
            refreshWindowMs: this.params.refreshWindowMs,
          }),
        };
      }
    }

    const machineId = this.params.machineIdProvider();
    if (!machineId) {
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    const ownerId = this.params.ownerIdProvider?.()?.trim();
    const lease = await this.params.api.acquireConnectedServiceRefreshLease({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      machineId,
      ...(ownerId ? { ownerId } : {}),
      leaseMs: this.params.refreshLeaseMs,
    });
    if (!lease.acquired) {
      const observed = await this.waitForContendedRefresh(binding, source, lease.leaseUntil, now, options);
      if (observed) return observed;
      return {
        status: 'lease_not_acquired',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'lease_not_acquired',
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    if (!record.oauth.refreshToken.trim()) {
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: 'missing_refresh_token',
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }

    let refreshed;
    try {
      refreshed = await refreshConnectedAccountOauthTokens({
        serviceId: binding.serviceId,
        refreshToken: record.oauth.refreshToken,
        now,
      });
    } catch (error) {
      const refreshError = error instanceof ConnectedServiceOauthRefreshError ? error : null;
      return {
        status: 'refresh_failed',
        credential: null,
        diagnostic: buildRefreshDiagnostic({
          binding,
          reason: options.reason,
          status: 'refresh_failed',
          category: refreshError?.category ?? 'unknown',
          providerStatus: refreshError?.status,
          providerErrorCode: refreshError?.providerErrorCode,
          expiresAt,
          now,
          refreshWindowMs: this.params.refreshWindowMs,
        }),
      };
    }
    const next = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken: refreshed.idToken,
      scope: refreshed.scope,
      tokenType: refreshed.tokenType,
      providerAccountId: refreshed.providerAccountId,
      providerEmail: refreshed.providerEmail,
      expiresAt: refreshed.expiresAt,
    };

    const updated = buildUpdatedOauthRecord({
      now,
      record,
      next,
    });

    await this.persistRefreshedCredential(binding, source, updated);
    return {
      status: 'refreshed',
      credential: updated,
      diagnostic: buildRefreshDiagnostic({
        binding,
        reason: options.reason,
        status: 'refreshed',
        expiresAt: updated.expiresAt,
        now,
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async waitForContendedRefresh(
    binding: BoundProfile,
    source: ConnectedServiceCredentialSource,
    leaseUntil: number,
    now: number,
    options: Readonly<{ force: boolean; reason: ConnectedServiceRefreshReason }>,
  ): Promise<ConnectedServiceCredentialRefreshResult | null> {
    if (options.reason === 'scheduled') return null;
    if (source.record.kind !== 'oauth') return null;
    const waitMaxMs = typeof this.params.leaseContentionWaitMaxMs === 'number'
      && Number.isFinite(this.params.leaseContentionWaitMaxMs)
      ? Math.max(0, Math.trunc(this.params.leaseContentionWaitMaxMs))
      : 0;
    if (waitMaxMs <= 0) return null;

    const currentNow = this.params.now();
    const waitMs = Math.min(waitMaxMs, Math.max(0, Math.trunc(leaseUntil - currentNow)));
    if (waitMs > 0) {
      await (this.params.sleepMs ?? defaultSleepMs)(waitMs);
    }

    const observedSource = await this.readCredentialForRefresh(binding);
    if (!observedSource || observedSource.record.kind !== 'oauth') return null;
    if (!hasObservedOauthCredentialChanged(source.record, observedSource.record)) return null;

    const observedExpiresAt = observedSource.mode === 'plain'
      ? observedSource.record.expiresAt
      : observedSource.metadata.expiresAt ?? observedSource.record.expiresAt;
    return {
      status: 'refreshed',
      credential: observedSource.record,
      diagnostic: buildRefreshDiagnostic({
        binding,
        reason: options.reason,
        status: 'refreshed',
        expiresAt: observedExpiresAt,
        now: this.params.now(),
        refreshWindowMs: this.params.refreshWindowMs,
      }),
    };
  }

  private async rematerializeTargetsForBinding(binding: BoundProfile): Promise<ReadonlyArray<SpawnTarget>> {
    const affected = Array.from(this.targetsByPid.values()).filter((target) =>
      target.bindings.some((b) => b.serviceId === binding.serviceId && b.profileId === binding.profileId),
    );
    const rematerialized: SpawnTarget[] = [];
    for (const target of affected) {
      const records = await resolveConnectedServiceCredentials({
        credentials: this.params.credentials,
        api: this.params.api,
        bindings: target.bindings,
      });
      const materialized = await materializeConnectedServicesForSpawn({
        agentId: target.agentId,
        materializationKey: target.materializationKey,
        activeServerDir: this.params.activeServerDir,
        baseDir: this.params.baseDir,
        recordsByServiceId: records,
        accountSettings: this.params.accountSettingsProvider?.() ?? null,
        processEnv: this.params.processEnv ?? process.env,
        ...(target.selectionsByServiceId.size > 0
          ? { selectionsByServiceId: buildResolvedSelectionsForTarget(target, records) }
          : {}),
      });
      const blockingDiagnostics = collectBlockingConnectedServicesMaterializationDiagnostics(materialized?.diagnostics);
      if (blockingDiagnostics.length > 0) {
        const primaryDiagnostic = blockingDiagnostics[0]!;
        const affectedBinding = target.bindings.find((candidate) => candidate.serviceId === primaryDiagnostic.serviceId)
          ?? target.bindings.find((candidate) => candidate.serviceId === binding.serviceId)
          ?? binding;
        await this.persistCredentialHealthForMaterializationFailure(affectedBinding, primaryDiagnostic);
        logger.warn('[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart', {
          serviceId: affectedBinding.serviceId,
          profileId: affectedBinding.profileId,
          agentId: target.agentId,
          materializationCode: primaryDiagnostic.code,
          reason: primaryDiagnostic.reason ?? null,
        });
        continue;
      }
      rematerialized.push(target);
    }
    return rematerialized;
  }
}
