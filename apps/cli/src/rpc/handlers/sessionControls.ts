import {
  SessionGoalClearRequestV1Schema,
  SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema,
  SessionGoalGetRequestV1Schema,
  SessionGoalSetRequestV1Schema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  ReviewStartInputSchema,
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitRecoveryOperationResultV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
  SessionSkillCatalogListRequestV1Schema,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryV1,
  type SessionUsageLimitRecoveryOperationResultV1,
  SessionUsageLimitRecoveryV1Schema,
  SessionVendorPluginCatalogListRequestV1Schema,
  SessionWorkStateGetRequestV1Schema,
  SessionWorkStateV1Schema,
  readDisplayableSessionWorkStateV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  resolveUsageLimitRecoveryFeatureEnabled,
  usageLimitRecoveryFeatureDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';

import type { Metadata } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

export type SessionRuntimeControls = {
  refreshGoal?: () => unknown;
  setGoal?: (
    objective: string | undefined,
    options?: Readonly<{
      status?: string;
      tokenBudget?: number | null;
    }>,
  ) => unknown;
  clearGoal?: () => unknown;
  listVendorPlugins?: (options?: Readonly<{ cwd?: string }>) => Promise<unknown>;
  listSkills?: (options?: Readonly<{ cwd?: string }>) => Promise<unknown>;
  startInlineReview?: (input: unknown) => Promise<unknown> | unknown;
  invalidateConnectedServiceAuthTransports?: () => Promise<unknown> | unknown;
  enableUsageLimitWaitResume?: (request: Readonly<{
    sessionId: string;
    issueFingerprint?: string;
    rememberPreference?: boolean;
  }>) => Promise<unknown> | unknown;
  cancelUsageLimitWaitResume?: (request: Readonly<{
    sessionId: string;
    issueFingerprint?: string | null;
  }>) => Promise<unknown> | unknown;
  checkUsageLimitRecoveryNow?: (request: Readonly<{
    sessionId: string;
    provider?: string;
    operation?: 'check_now' | 'switch_account_now';
  }>) => Promise<unknown> | unknown;
  handleUserMessage?: (
    request: Readonly<{
      text: string;
      localId?: string;
      meta: Record<string, unknown>;
    }>,
  ) => Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }>>
    | Readonly<{ handled: false }>
    | Readonly<{ handled: true; result: unknown }>;
};

function unsupported(method: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return {
    ok: false,
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  };
}

function invalidInput(): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
}

function readWorkState(getSessionMetadata?: (() => Metadata | null) | null): unknown {
  const metadata = getSessionMetadata?.();
  if (!metadata || typeof metadata !== 'object') return null;
  return readDisplayableSessionWorkStateV1((metadata as Record<string, unknown>).sessionWorkStateV1);
}

function readRuntimeControlErrorResult(value: unknown): Readonly<{ ok: false; errorCode: string; error: string }> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== 'string') return null;
  return {
    ok: false,
    error: record.error,
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : 'runtime_control_failed',
  };
}

function readCurrentGoalObjective(getSessionMetadata?: (() => Metadata | null) | null): string | null {
  const workState = readWorkState(getSessionMetadata);
  const parsed = SessionWorkStateV1Schema.safeParse(workState);
  if (!parsed.success) return null;

  const primary = parsed.data.primaryItemId
    ? parsed.data.items.find((item) => item.id === parsed.data.primaryItemId && item.kind === 'goal')
    : null;
  const goal = primary ?? parsed.data.items.find((item) => item.kind === 'goal') ?? null;
  const title = goal?.title.trim();
  return title ? title : null;
}

function readCatalogRuntimeOptions(rawCwd: string | undefined): Readonly<{ cwd?: string }> {
  const cwd = typeof rawCwd === 'string' ? rawCwd.trim() : '';
  return cwd.length > 0 ? { cwd } : {};
}

function buildUsageLimitRecoveryIntent(input: Readonly<{
  issueFingerprint?: string;
  nowMs: number;
}>): SessionUsageLimitRecoveryV1 {
  return SessionUsageLimitRecoveryV1Schema.parse({
    v: 1,
    status: 'waiting',
    issueFingerprint: input.issueFingerprint ?? `usage-limit:${input.nowMs}`,
    armedAtMs: input.nowMs,
    resetAtMs: null,
    nextCheckAtMs: null,
    attemptCount: 0,
    maxAttempts: 0,
    lastProbeError: null,
    selectedAuth: { kind: 'native' },
  });
}

function readCurrentUsageLimitRecoveryIntent(metadata: Metadata): unknown {
  return (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
}

function writeUsageLimitRecoveryIntent(
  metadata: Metadata,
  intent: unknown,
): Metadata {
  const next: Record<string, unknown> = {
    ...metadata,
  };
  next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] = intent;
  return next as Metadata;
}

function normalizeUsageLimitRecoveryOperationResult(
  result: unknown,
  sessionId: string,
): SessionUsageLimitRecoveryOperationResultV1 {
  const normalized = normalizeSessionUsageLimitRecoveryOperationResultV1(result, { sessionId });
  if (normalized.ok) {
    return SessionUsageLimitRecoveryOperationResultV1Schema.parse(normalized);
  }
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ...normalized,
    sessionId: normalized.sessionId ?? sessionId,
  });
}

export function registerSessionControlHandlers(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    getSessionMetadata?: (() => Metadata | null) | null;
    updateSessionMetadata?: ((handler: (metadata: Metadata) => Metadata) => Promise<void> | void) | null;
    sessionRuntimeControls?: SessionRuntimeControls | null;
  }>,
): void {
  let usageLimitRecoveryFeatureEnabledPromise: Promise<boolean> | null = null;
  const usageLimitRecoveryFeatureEnabled = async (): Promise<boolean> => {
    usageLimitRecoveryFeatureEnabledPromise ??= resolveUsageLimitRecoveryFeatureEnabled();
    return await usageLimitRecoveryFeatureEnabledPromise;
  };

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, async (raw: unknown) => {
    const parsed = SessionWorkStateGetRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_GET, async (raw: unknown) => {
    const parsed = SessionGoalGetRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.refreshGoal !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_GOAL_GET);
    }
    const result = readRuntimeControlErrorResult(await opts.sessionRuntimeControls.refreshGoal());
    if (result) return result;
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_SET, async (raw: unknown) => {
    const parsed = SessionGoalSetRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.setGoal !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_GOAL_SET);
    }
    const objective = parsed.data.objective ?? readCurrentGoalObjective(opts.getSessionMetadata) ?? undefined;
    const result = readRuntimeControlErrorResult(await opts.sessionRuntimeControls.setGoal(objective, {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, 'tokenBudget')
        ? { tokenBudget: parsed.data.tokenBudget ?? null }
        : {}),
    }));
    if (result) return result;
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR, async (raw: unknown) => {
    const parsed = SessionGoalClearRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.clearGoal !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR);
    }
    const result = readRuntimeControlErrorResult(await opts.sessionRuntimeControls.clearGoal());
    if (result) return result;
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE, async (raw: unknown) => {
    const parsed = ReviewStartInputSchema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.startInlineReview !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE);
    }
    return await opts.sessionRuntimeControls.startInlineReview(raw);
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS, async (raw: unknown) => {
    const parsed = SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.invalidateConnectedServiceAuthTransports !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS);
    }
    const result = readRuntimeControlErrorResult(
      await opts.sessionRuntimeControls.invalidateConnectedServiceAuthTransports(),
    );
    if (result) return result;
    return { ok: true };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, async (raw: unknown) => {
    const parsed = SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    const request = {
      sessionId: parsed.data.sessionId,
      ...(typeof parsed.data.issueFingerprint === 'string' ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
      ...((parsed.data.remember === true || parsed.data.rememberPreference === true) ? { rememberPreference: true } : {}),
    };
    if (!await usageLimitRecoveryFeatureEnabled()) {
      return usageLimitRecoveryFeatureDisabledResult({ sessionId: request.sessionId });
    }
    if (typeof opts.sessionRuntimeControls?.enableUsageLimitWaitResume !== 'function') {
      if (typeof opts.updateSessionMetadata !== 'function') {
        return normalizeUsageLimitRecoveryOperationResult(
          unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE),
          request.sessionId,
        );
      }
      const intent = buildUsageLimitRecoveryIntent({
        issueFingerprint: request.issueFingerprint,
        nowMs: Date.now(),
      });
      await opts.updateSessionMetadata((metadata) => writeUsageLimitRecoveryIntent(metadata, intent));
      return normalizeUsageLimitRecoveryOperationResult({
        ok: true,
        status: 'waiting',
        issueFingerprint: intent.issueFingerprint,
      }, request.sessionId);
    }
    return normalizeUsageLimitRecoveryOperationResult(
      await opts.sessionRuntimeControls.enableUsageLimitWaitResume(request),
      request.sessionId,
    );
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, async (raw: unknown) => {
    const parsed = SessionUsageLimitWaitResumeCancelRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    const request = {
      sessionId: parsed.data.sessionId,
      ...(Object.prototype.hasOwnProperty.call(parsed.data, 'issueFingerprint')
        ? { issueFingerprint: parsed.data.issueFingerprint }
        : {}),
    };
    if (!await usageLimitRecoveryFeatureEnabled()) {
      return usageLimitRecoveryFeatureDisabledResult({ sessionId: request.sessionId });
    }
    if (typeof opts.sessionRuntimeControls?.cancelUsageLimitWaitResume !== 'function') {
      if (typeof opts.updateSessionMetadata !== 'function') {
        return normalizeUsageLimitRecoveryOperationResult(
          unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL),
          request.sessionId,
        );
      }
      let cancelledIssueFingerprint: string | undefined;
      await opts.updateSessionMetadata((metadata) => {
        const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(readCurrentUsageLimitRecoveryIntent(metadata));
        const current = parsed.success
          ? parsed.data
          : buildUsageLimitRecoveryIntent({ nowMs: Date.now() });
        cancelledIssueFingerprint = current.issueFingerprint;
        return writeUsageLimitRecoveryIntent(metadata, {
          ...current,
          status: 'cancelled',
        });
      });
      return normalizeUsageLimitRecoveryOperationResult({
        ok: true,
        status: 'cancelled',
        ...(cancelledIssueFingerprint ? { issueFingerprint: cancelledIssueFingerprint } : {}),
      }, request.sessionId);
    }
    return normalizeUsageLimitRecoveryOperationResult(
      await opts.sessionRuntimeControls.cancelUsageLimitWaitResume(request),
      request.sessionId,
    );
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, async (raw: unknown) => {
    const parsed = SessionUsageLimitCheckNowRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (!await usageLimitRecoveryFeatureEnabled()) {
      return usageLimitRecoveryFeatureDisabledResult({ sessionId: parsed.data.sessionId });
    }
    if (typeof opts.sessionRuntimeControls?.checkUsageLimitRecoveryNow !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW),
        parsed.data.sessionId,
      );
    }
    return normalizeUsageLimitRecoveryOperationResult(await opts.sessionRuntimeControls.checkUsageLimitRecoveryNow({
      sessionId: parsed.data.sessionId,
      ...(typeof parsed.data.provider === 'string' ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.operation ? { operation: parsed.data.operation } : {}),
    }), parsed.data.sessionId);
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST, async (raw: unknown) => {
    const parsed = SessionVendorPluginCatalogListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.listVendorPlugins !== 'function') {
      return { unsupported: true, vendorPlugins: [] };
    }
    return await opts.sessionRuntimeControls.listVendorPlugins(readCatalogRuntimeOptions(parsed.data.cwd));
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST, async (raw: unknown) => {
    const parsed = SessionSkillCatalogListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.listSkills !== 'function') {
      return { unsupported: true, skills: [] };
    }
    return await opts.sessionRuntimeControls.listSkills(readCatalogRuntimeOptions(parsed.data.cwd));
  });
}
