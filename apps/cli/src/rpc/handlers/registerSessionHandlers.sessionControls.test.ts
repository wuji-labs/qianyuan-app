import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('registerSessionHandlers session controls', () => {
  it('routes goal RPCs to runtime goal controls and returns current work state', async () => {
    const { handlers, registrar } = createRegistrar();
    const refreshGoal = vi.fn(async () => {});
    const setGoal = vi.fn(async () => {});
    const clearGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };
    const metadata: Metadata & { sessionWorkStateV1: typeof workState } = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: workState,
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      sessionRuntimeControls: {
        refreshGoal,
        setGoal,
        clearGoal,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual({ workState });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
        objective: '  Ship native goal  ',
        status: 'paused',
        tokenBudget: 1200,
      }),
    ).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual({ workState });

    expect(refreshGoal).toHaveBeenCalledTimes(1);
    expect(setGoal).toHaveBeenCalledWith('Ship native goal', {
      status: 'paused',
      tokenBudget: 1200,
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });

  it('routes catalog RPCs to runtime catalog controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const listVendorPlugins = vi.fn(async () => ({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    }));
    const listSkills = vi.fn(async () => ({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        listVendorPlugins,
        listSkills,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({})).resolves.toEqual({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)?.({})).resolves.toEqual({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    });
  });

  it('uses the current goal objective for status-only goal updates', async () => {
    const { handlers, registrar } = createRegistrar();
    const setGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
        sessionWorkStateV1: workState,
      } as Metadata & { sessionWorkStateV1: typeof workState }),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual({ workState });

    expect(setGoal).toHaveBeenCalledWith('Ship goal controls', { status: 'paused' });
  });

  it('rejects status-only goal updates when there is no current goal objective', async () => {
    const { handlers, registrar } = createRegistrar();
    const setGoal = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
      } as Metadata),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'goal_objective_required',
      error: 'goal_objective_required',
    });

    expect(setGoal).not.toHaveBeenCalled();
  });

  it('returns displayable work-state items when metadata preserves future items', async () => {
    const { handlers, registrar } = createRegistrar();
    const metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'future:1',
            kind: 'milestone',
            origin: 'future',
            status: 'waiting',
            title: 'Future item',
            updatedAt: 1,
          },
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    } as Metadata;

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET)?.({})).resolves.toEqual({
      workState: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    });
  });

  it('passes through stable unsupported results from runtime goal controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const unsupportedSet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.set',
    };
    const unsupportedGet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.get',
    };
    const unsupportedClear = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.clear',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        refreshGoal: vi.fn(async () => unsupportedGet),
        setGoal: vi.fn(async () => unsupportedSet),
        clearGoal: vi.fn(async () => unsupportedClear),
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual(unsupportedGet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
      objective: 'Unsupported native goal',
    })).resolves.toEqual(unsupportedSet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual(unsupportedClear);
  });
});
