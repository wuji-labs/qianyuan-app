import {
  SessionGoalClearRequestV1Schema,
  SessionGoalGetRequestV1Schema,
  SessionGoalSetRequestV1Schema,
  SessionSkillCatalogListRequestV1Schema,
  SessionVendorPluginCatalogListRequestV1Schema,
  SessionWorkStateGetRequestV1Schema,
  SessionWorkStateV1Schema,
  readDisplayableSessionWorkStateV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Metadata } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

type SessionRuntimeControlErrorResult = Readonly<{ ok: false; errorCode?: string; error: string }>;
type SessionRuntimeControlResult = void | SessionRuntimeControlErrorResult;

export type SessionRuntimeControls = {
  refreshGoal?: () => Promise<SessionRuntimeControlResult>;
  setGoal?: (
    objective: string,
    options?: Readonly<{
      status?: string;
      tokenBudget?: number | null;
    }>,
  ) => Promise<SessionRuntimeControlResult>;
  clearGoal?: () => Promise<SessionRuntimeControlResult>;
  listVendorPlugins?: () => Promise<unknown>;
  listSkills?: () => Promise<unknown>;
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

function goalObjectiveRequired(): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode: 'goal_objective_required', error: 'goal_objective_required' };
}

function readWorkState(getSessionMetadata?: (() => Metadata | null) | null): unknown {
  const metadata = getSessionMetadata?.();
  if (!metadata || typeof metadata !== 'object') return null;
  return readDisplayableSessionWorkStateV1((metadata as Record<string, unknown>).sessionWorkStateV1);
}

function readRuntimeControlErrorResult(value: SessionRuntimeControlResult): Readonly<{ ok: false; errorCode: string; error: string }> | null {
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

export function registerSessionControlHandlers(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    getSessionMetadata?: (() => Metadata | null) | null;
    sessionRuntimeControls?: SessionRuntimeControls | null;
  }>,
): void {
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
    const objective = parsed.data.objective ?? readCurrentGoalObjective(opts.getSessionMetadata);
    if (!objective) return goalObjectiveRequired();
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

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST, async (raw: unknown) => {
    const parsed = SessionVendorPluginCatalogListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.listVendorPlugins !== 'function') {
      return { unsupported: true, vendorPlugins: [] };
    }
    return await opts.sessionRuntimeControls.listVendorPlugins();
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST, async (raw: unknown) => {
    const parsed = SessionSkillCatalogListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.listSkills !== 'function') {
      return { unsupported: true, skills: [] };
    }
    return await opts.sessionRuntimeControls.listSkills();
  });
}
