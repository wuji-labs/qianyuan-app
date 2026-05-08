import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { storage } from '@/sync/domains/state/storage';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('./accountSettingsDaemonSpawnPreparation', () => ({
  prepareAccountSettingsForDaemonSpawnIfNeeded: prepareAccountSettingsForDaemonSpawnMock,
  registerAccountSettingsDaemonSpawnPreparation: vi.fn(() => vi.fn()),
}));

vi.mock('../api/session/apiSocket', () => ({
  apiSocket: {
    machineRPC: vi.fn(),
    sessionRPC: vi.fn(),
  },
}));

vi.mock('@/sync/runtime/socketIoAckTimeout', () => ({
  isSocketIoAckTimeoutError: (error: unknown) =>
    error instanceof Error && error.message.includes('timed out'),
}));

describe('machineSpawnNewSession error mapping', () => {
  const initialStorageState = storage.getState();

  beforeEach(() => {
    machineRpcWithServerScopeMock.mockReset();
    prepareAccountSettingsForDaemonSpawnMock.mockReset();
    prepareAccountSettingsForDaemonSpawnMock.mockResolvedValue({});
    storage.setState(initialStorageState, true);
  });

  it('returns a descriptive error when daemon RPC method is not available', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE);
    expect(result.errorMessage.toLowerCase()).toContain('daemon');
    expect(result.errorMessage.toLowerCase()).toContain('rpc');
  });

  it('uses an extended RPC timeout for spawn session calls', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const { readSpawnSessionRpcTimeoutMsFromEnv } = await import('../domains/session/spawn/spawnSessionRpcTimeout');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('success');
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    const call = machineRpcWithServerScopeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({ timeoutMs: expect.any(Number) });
    expect(call.timeoutMs).toBe(readSpawnSessionRpcTimeoutMsFromEnv());
  });

  it('prepares account settings and includes the returned version hint before spawning', async () => {
    prepareAccountSettingsForDaemonSpawnMock.mockResolvedValueOnce({ accountSettingsVersionHint: 22 });
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('success');
    expect(prepareAccountSettingsForDaemonSpawnMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        accountSettingsVersionHint: 22,
      }),
    }));
  });

  it('does not override an explicit account settings version hint', async () => {
    prepareAccountSettingsForDaemonSpawnMock.mockResolvedValueOnce({ accountSettingsVersionHint: 22 });
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
    });

    expect(prepareAccountSettingsForDaemonSpawnMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        accountSettingsVersionHint: 12,
      }),
    }));
  });

  it('maps socket ack timeouts to SESSION_WEBHOOK_TIMEOUT', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('operation has timed out'));

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT);
    expect(typeof result.errorMessage).toBe('string');
    expect(result.errorMessage.length).toBeGreaterThan(0);
  });

  it('maps legacy daemon error envelopes into a structured spawn error result', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      success: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'Claude CLI override is invalid',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Claude CLI override is invalid',
    });
  });

  it('maps legacy daemon success envelopes into a structured spawn success result', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      success: true,
      sessionId: 'session-legacy',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-legacy' });
  });

  it('builds a legacy spawn payload for older daemon versions', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-legacy',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.1.0',
        },
        daemonStateVersion: 1,
      },
    ]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-legacy' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
      serverId: 'server-b',
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-legacy' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        type: 'spawn-in-directory',
        directory: '/tmp',
        agent: 'codex',
        experimentalCodexAcp: true,
      }),
    }));
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload).not.toHaveProperty('backendTarget');
  });

  it('keeps the modern spawn payload for compatible 0.1.0 dev daemon versions', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-dev',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.1.0-dev.1775063171.91734',
        },
        daemonStateVersion: 1,
      },
    ]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-dev' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-dev',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
      serverId: 'server-b',
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-dev' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        type: 'spawn-in-directory',
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      }),
    }));
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload).not.toHaveProperty('agent');
  });

  it('fails early when an older daemon cannot represent the selected configured backend target', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-legacy',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.1.0',
        },
        daemonStateVersion: 1,
      },
    ]);

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: expect.stringContaining('0.2.0'),
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('maps misleading legacy daemon directory errors into a compatibility hint when the app sent a directory', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-legacy',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.1.0',
        },
        daemonStateVersion: 1,
      },
    ]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Directory is required',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: expect.stringContaining('incompatible'),
    });
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorMessage).toContain('re-authorize');
  });
});
