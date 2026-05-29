import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';
import type { Credentials } from '@/persistence';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

describe('rpcHandlers.sessionGoals', () => {
  const credentials: Credentials = {
    token: 'token-1',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };

  let handlers: Map<string, (raw: unknown) => Promise<unknown>>;
  let sessionGoalSet: ReturnType<typeof vi.fn>;
  let sessionGoalClear: ReturnType<typeof vi.fn>;
  let sessionGoalGet: ReturnType<typeof vi.fn>;
  let sessionVendorPluginCatalogList: ReturnType<typeof vi.fn>;
  let sessionSkillCatalogList: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeEnable: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeCancel: ReturnType<typeof vi.fn>;
  let sessionUsageLimitCheckNow: ReturnType<typeof vi.fn>;
  let sessionUsageLimitSwitchAccountNow: ReturnType<typeof vi.fn>;
  let createCliActionDepsParams: unknown[];

  beforeEach(() => {
    handlers = new Map();
    sessionGoalSet = vi.fn(async () => ({ ok: true }));
    sessionGoalClear = vi.fn(async () => ({ ok: true }));
    sessionGoalGet = vi.fn(async () => ({ workState: null }));
    sessionVendorPluginCatalogList = vi.fn(async () => ({ vendorPlugins: [] }));
    sessionSkillCatalogList = vi.fn(async () => ({ skills: [] }));
    sessionUsageLimitWaitResumeEnable = vi.fn(async () => ({ ok: true }));
    sessionUsageLimitWaitResumeCancel = vi.fn(async () => ({ ok: true }));
    sessionUsageLimitCheckNow = vi.fn(async () => ({ ok: true }));
    sessionUsageLimitSwitchAccountNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    createCliActionDepsParams = [];
  });

  function registerWithTransport(options: Readonly<{
    resumeInactiveSessionWhenUsageLimitReady?: (input: unknown) => Promise<boolean> | boolean;
    scheduleInactiveSessionUsageLimitRecoveryCheck?: (input: unknown) => void;
    cancelInactiveSessionUsageLimitRecoveryCheck?: (input: unknown) => void;
  }> = {}) {
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'plain',
    });
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        readCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: true,
          sessionId: 'resolved-session',
          rawSession,
          ctx: {
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
          },
          mode: 'plain',
        }),
        ...(options.resumeInactiveSessionWhenUsageLimitReady
          ? { resumeInactiveSessionWhenUsageLimitReady: options.resumeInactiveSessionWhenUsageLimitReady }
          : {}),
        ...(options.scheduleInactiveSessionUsageLimitRecoveryCheck
          ? { scheduleInactiveSessionUsageLimitRecoveryCheck: options.scheduleInactiveSessionUsageLimitRecoveryCheck }
          : {}),
        ...(options.cancelInactiveSessionUsageLimitRecoveryCheck
          ? { cancelInactiveSessionUsageLimitRecoveryCheck: options.cancelInactiveSessionUsageLimitRecoveryCheck }
          : {}),
        createCliActionDeps: (params) => {
          createCliActionDepsParams.push(params);
          return {
            sessionGoalSet,
            sessionGoalClear,
            sessionGoalGet,
            sessionVendorPluginCatalogList,
            sessionSkillCatalogList,
            sessionUsageLimitWaitResumeEnable,
            sessionUsageLimitWaitResumeCancel,
            sessionUsageLimitCheckNow,
            sessionUsageLimitSwitchAccountNow,
          };
        },
      },
    });
  }

  it('routes inactive-session goal set controls through CLI action deps', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({
      sessionId: 'session-prefix',
      status: 'paused',
    });

    expect(result).toEqual({ ok: true });
    expect(sessionGoalSet).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      status: 'paused',
    });
  });

  it('routes inactive-session goal clear controls through CLI action deps', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({ ok: true });
    expect(sessionGoalClear).toHaveBeenCalledWith({ sessionId: 'resolved-session' });
  });

  it('routes inactive-session goal get controls through CLI action deps', async () => {
    sessionGoalGet.mockResolvedValueOnce({ workState: { v: 1, items: [] } });
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_GET)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({ workState: { v: 1, items: [] } });
    expect(sessionGoalGet).toHaveBeenCalledWith({ sessionId: 'resolved-session' });
  });

  it('returns stable invalid-parameter errors before dispatching malformed controls', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionGoalSet).not.toHaveBeenCalled();

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'session-prefix',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
    expect(sessionUsageLimitWaitResumeCancel).not.toHaveBeenCalled();
  });

  it('rejects non-boolean rememberPreference values before dispatching usage-limit enable controls', async () => {
    registerWithTransport();

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      rememberPreference: 'yes',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
  });

  it('routes inactive-session catalog list controls through CLI action deps', async () => {
    sessionVendorPluginCatalogList.mockResolvedValueOnce({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    sessionSkillCatalogList.mockResolvedValueOnce({
      skills: [{ name: 'review', origin: 'codex_native' }],
    });
    registerWithTransport();

    await expect(handlers.get('daemon.sessionVendorPluginCatalog.list')?.({
      sessionId: 'session-prefix',
      cwd: '/repo',
    })).resolves.toEqual({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    await expect(handlers.get('daemon.sessionSkillCatalog.list')?.({
      sessionId: 'session-prefix',
      cwd: '/repo',
    })).resolves.toEqual({
      skills: [{ name: 'review', origin: 'codex_native' }],
    });

    expect(sessionVendorPluginCatalogList).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      cwd: '/repo',
    });
    expect(sessionSkillCatalogList).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      cwd: '/repo',
    });
  });

  it('routes inactive-session usage-limit recovery controls through CLI action deps', async () => {
    registerWithTransport();

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      rememberPreference: true,
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'session-prefix',
      issueFingerprint: null,
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      provider: ' codex ',
      operation: 'switch_account_now',
    })).resolves.toEqual({ ok: true, status: 'waiting' });

    expect(sessionUsageLimitWaitResumeEnable).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      remember: true,
    });
    expect(sessionUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      issueFingerprint: null,
    });
    expect(sessionUsageLimitCheckNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
    });
    expect(sessionUsageLimitSwitchAccountNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      provider: 'codex',
    });
  });

  it('passes the daemon usage-limit resume callback into CLI action deps', async () => {
    const resumeInactiveSessionWhenUsageLimitReady = vi.fn(async () => true);
    registerWithTransport({ resumeInactiveSessionWhenUsageLimitReady });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({ ok: true });

    expect(createCliActionDepsParams.at(-1)).toMatchObject({
      resumeInactiveSessionWhenUsageLimitReady,
    });
  });

  it('passes daemon usage-limit scheduling callbacks into CLI action deps', async () => {
    const scheduleInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    const cancelInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    registerWithTransport({
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
    })).resolves.toEqual({ ok: true });

    expect(createCliActionDepsParams.at(-1)).toMatchObject({
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    });
  });
});
