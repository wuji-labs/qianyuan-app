import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const mocks = vi.hoisted(() => ({
  callSessionRpc: vi.fn(async () => ({ ok: true })),
  getSessionGoalControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  getSessionEvents: vi.fn(async () => ({ ok: true, sessionId: 'sess_1', items: [], nextCursor: null, hasMore: false })),
  getSessionTranscript: vi.fn(async () => ({ ok: true, sessionId: 'sess_1', items: [], nextCursor: null, hasMore: false })),
  listSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
  readSettings: vi.fn(async () => ({ machineId: 'machine-local' })),
  resolveSessionTransportContext: vi.fn(async (): Promise<unknown> => ({
    ok: true as const,
    sessionId: 'sess_1',
    rawSession: { active: true },
    ctx: {
      encryptionKey: new Uint8Array(32).fill(3),
      encryptionVariant: 'legacy' as const,
    },
    mode: 'plain' as const,
  })),
  sendSessionMessage: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('@/backends/catalog', () => ({ getSessionGoalControlAdapter: mocks.getSessionGoalControlAdapter }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readSettings: mocks.readSettings,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: mocks.callSessionRpc }));
vi.mock('@/session/services/getSessionEvents', () => ({ getSessionEvents: mocks.getSessionEvents }));
vi.mock('@/session/services/getSessionTranscript', () => ({ getSessionTranscript: mocks.getSessionTranscript }));
vi.mock('@/session/services/listSessions', () => ({ listSessions: mocks.listSessions }));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/session/services/sendSessionMessage', () => ({ sendSessionMessage: mocks.sendSessionMessage }));

import { createCliActionDeps } from './createCliActionDeps';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

describe('createCliActionDeps session controls', () => {
  beforeEach(() => {
    mocks.callSessionRpc.mockReset();
    mocks.callSessionRpc.mockResolvedValue({ ok: true });
    mocks.getSessionGoalControlAdapter.mockReset();
    mocks.getSessionGoalControlAdapter.mockResolvedValue(null);
    mocks.getSessionEvents.mockClear();
    mocks.getSessionTranscript.mockClear();
    mocks.listSessions.mockClear();
    mocks.readSettings.mockReset();
    mocks.readSettings.mockResolvedValue({ machineId: 'machine-local' });
    mocks.resolveSessionTransportContext.mockReset();
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: { active: true },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    mocks.sendSessionMessage.mockClear();
  });

  it('wires transcript and events actions to the canonical services', async () => {
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionTranscriptGet?.({
      sessionId: 'sess_1',
      limit: 2,
      cursor: '10',
      roles: ['assistant'],
      includeTools: true,
      maxCharsPerMessage: 100,
    });
    await deps.sessionEventsGet?.({
      sessionId: 'sess_1',
      limit: 3,
      roles: ['event'],
      kinds: ['tool-call'],
      includeRaw: true,
      maxPayloadChars: 256,
    });

    expect(mocks.getSessionTranscript).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
      limit: 2,
      cursor: '10',
      roles: ['assistant'],
      includeTools: true,
      maxCharsPerMessage: 100,
    });
    expect(mocks.getSessionEvents).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
      limit: 3,
      roles: ['event'],
      kinds: ['tool-call'],
      includeRaw: true,
      maxPayloadChars: 256,
    });
  });

  it('forwards session list preview and row shape options to the list service', async () => {
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionList({
      limit: 10,
      cursor: 'cursor-1',
      includeLastMessagePreview: true,
      includeRows: true,
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
    });

    expect(mocks.listSessions).toHaveBeenCalledWith({
      credentials,
      activeOnly: true,
      archivedOnly: false,
      includeSystem: true,
      resumableOnly: true,
      includeLastMessagePreview: true,
      includeRows: true,
      limit: 10,
      cursor: 'cursor-1',
    });
  });

  it('calls native session goal RPC instead of sending goal text', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({ sessionId: 'sess_1', objective: 'Ship native goals' })).resolves.toEqual({
      ok: true,
    });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'plain',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`,
      request: { objective: 'Ship native goals' },
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('delegates inactive local goal mutations to the provider goal control adapter', async () => {
    const providerSetGoal = vi.fn(async (_params: unknown) => ({ ok: true, workState: { v: 1, items: [], primaryItemId: null, updatedAt: 1 } }));
    mocks.getSessionGoalControlAdapter.mockResolvedValueOnce({
      setGoal: providerSetGoal,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({
      sessionId: 'sess_inactive',
      objective: 'Ship native goals',
      status: 'paused',
      tokenBudget: null,
    })).resolves.toEqual({
      ok: true,
      workState: { v: 1, items: [], primaryItemId: null, updatedAt: 1 },
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionGoalControlAdapter).toHaveBeenCalledWith('codex');
    expect(providerSetGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      request: {
        objective: 'Ship native goals',
        status: 'paused',
        tokenBudget: null,
      },
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
      currentMachineId: 'machine-local',
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('omits objective from status-only inactive goal mutations', async () => {
    const providerSetGoal = vi.fn(async (_params: { request: Record<string, unknown> }) => ({ ok: true }));
    mocks.getSessionGoalControlAdapter.mockResolvedValueOnce({
      setGoal: providerSetGoal,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({
      sessionId: 'sess_inactive',
      status: 'paused',
    })).resolves.toEqual({ ok: true });

    expect(providerSetGoal).toHaveBeenCalledWith(expect.objectContaining({
      request: { status: 'paused' },
    }));
    const request = providerSetGoal.mock.calls[0]?.[0].request;
    expect(Object.prototype.hasOwnProperty.call(request, 'objective')).toBe(false);
  });

  it('calls native catalog RPCs for vendor plugins and skills', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionVendorPluginCatalogList?.({ sessionId: 'sess_1' });
    await deps.sessionSkillCatalogList?.({ sessionId: 'sess_1' });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST}`,
      request: {},
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST}`,
      request: {},
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });
});
