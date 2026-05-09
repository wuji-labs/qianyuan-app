import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentBackend';

const { createOpenCodeServerRuntimeMock } = vi.hoisted(() => ({
  createOpenCodeServerRuntimeMock: vi.fn(),
}));

vi.mock('@/backends/opencode/server/runtime', () => ({
  createOpenCodeServerRuntime: createOpenCodeServerRuntimeMock,
}));

describe('createOpenCodeServerExecutionRunBackend', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('adapts the canonical OpenCode server runtime to the execution-run backend contract', async () => {
    const observedMessages: AgentMessage[] = [];
    let runtimeSession: Record<string, unknown> | null = null;
    let activeSessionId: string | null = null;
    const beginTurn = vi.fn();
    const flushTurn = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const reset = vi.fn(async () => undefined);
    const startOrLoad = vi.fn(async (opts?: { resumeId?: string | null }) => {
      activeSessionId = opts?.resumeId ? `resumed:${opts.resumeId}` : 'session_server';
      return activeSessionId;
    });
    const sendPrompt = vi.fn(async (_prompt: string) => {
      if (!runtimeSession) {
        throw new Error('Expected runtime session adapter to be captured');
      }
      const sendAgentMessage = runtimeSession.sendAgentMessage as ((provider: string, body: Record<string, unknown>) => void);
      const sendAgentMessageCommitted = runtimeSession.sendAgentMessageCommitted as ((provider: string, body: Record<string, unknown>, opts: {
        localId: string;
        meta?: Record<string, unknown>;
      }) => Promise<void>);

      await sendAgentMessageCommitted(
        'opencode',
        {
          type: 'message',
          message: 'Hello',
        },
        { localId: 'assistant-1' },
      );
      sendAgentMessage('opencode', {
        type: 'tool-call',
        callId: 'tool-1',
        name: 'Bash',
        input: { command: 'pwd' },
        id: 'msg-tool-call',
      });
      sendAgentMessage('opencode', {
        type: 'tool-result',
        callId: 'tool-1',
        output: { output: '/tmp/demo' },
        id: 'msg-tool-result',
      });
      await sendAgentMessageCommitted(
        'opencode',
        {
          type: 'message',
          message: 'Hello world',
        },
        { localId: 'assistant-1' },
      );
    });

    createOpenCodeServerRuntimeMock.mockImplementation((params: Record<string, unknown>) => {
      runtimeSession = params.session as Record<string, unknown>;
      return {
        getSessionId: () => activeSessionId,
        beginTurn,
        flushTurn,
        startOrLoad,
        sendPrompt,
        cancel,
        reset,
      };
    });

    const { createOpenCodeServerExecutionRunBackend } = await import('./createOpenCodeServerExecutionRunBackend');
    const backend = createOpenCodeServerExecutionRunBackend({
      cwd: '/tmp/opencode-run',
      env: {
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
      },
      permissionHandler: {
        handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' as const })),
      },
      permissionMode: 'read-only',
    });

    backend.onMessage((message: AgentMessage) => {
      observedMessages.push(message);
    });

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'session_server' });
    await backend.sendPrompt('session_server', 'Inspect this repo');
    await backend.waitForResponseComplete?.();
    await expect(backend.loadSession?.('vendor-session-1')).resolves.toEqual({ sessionId: 'resumed:vendor-session-1' });
    await backend.cancel('resumed:vendor-session-1');
    await backend.dispose();

    expect(createOpenCodeServerRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/opencode-run',
      env: { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' },
    }));
    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(flushTurn).toHaveBeenCalledTimes(1);
    expect(startOrLoad).toHaveBeenNthCalledWith(1, {});
    expect(startOrLoad).toHaveBeenNthCalledWith(2, { resumeId: 'vendor-session-1' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(observedMessages).toEqual(expect.arrayContaining([
      { type: 'model-output', fullText: 'Hello' },
      { type: 'tool-call', toolName: 'Bash', args: { command: 'pwd' }, callId: 'tool-1' },
      { type: 'tool-result', toolName: 'Bash', result: { output: '/tmp/demo' }, callId: 'tool-1', isError: false },
      { type: 'model-output', fullText: 'Hello world' },
    ]));
  });

  it('acks sendPrompt before the OpenCode runtime turn completes', async () => {
    let activeSessionId: string | null = null;
    let resolveRuntimePrompt!: () => void;
    const runtimePrompt = new Promise<void>((resolve) => {
      resolveRuntimePrompt = resolve;
    });
    const beginTurn = vi.fn();
    const flushTurn = vi.fn();
    const startOrLoad = vi.fn(async () => {
      activeSessionId = 'session_server';
      return activeSessionId;
    });
    const sendPrompt = vi.fn(() => runtimePrompt);

    createOpenCodeServerRuntimeMock.mockImplementation(() => ({
      getSessionId: () => activeSessionId,
      beginTurn,
      flushTurn,
      startOrLoad,
      sendPrompt,
      cancel: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
    }));

    const { createOpenCodeServerExecutionRunBackend } = await import('./createOpenCodeServerExecutionRunBackend');
    const backend = createOpenCodeServerExecutionRunBackend({
      cwd: '/tmp/opencode-run',
      permissionHandler: {
        handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' as const })),
      },
      permissionMode: 'read-only',
    });

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'session_server' });

    const sendAck = backend.sendPrompt('session_server', 'Inspect this repo');
    await expect.poll(() => sendPrompt.mock.calls.length).toBe(1);

    try {
      await expect(Promise.race([
        sendAck.then(() => 'resolved' as const),
        new Promise<'pending'>((resolve) => {
          const timer = setTimeout(() => resolve('pending'), 25);
          timer.unref?.();
        }),
      ])).resolves.toBe('resolved');
      expect(flushTurn).not.toHaveBeenCalled();
    } finally {
      resolveRuntimePrompt();
      await sendAck.catch(() => undefined);
    }

    await backend.waitForResponseComplete?.();
    expect(flushTurn).toHaveBeenCalledTimes(1);
  });

  it('routes /compact to the OpenCode runtime compaction hook', async () => {
    let activeSessionId: string | null = null;
    const beginTurn = vi.fn();
    const flushTurn = vi.fn();
    const sendPrompt = vi.fn(async () => undefined);
    const compactContext = vi.fn(async () => undefined);
    const startOrLoad = vi.fn(async () => {
      activeSessionId = 'session_server';
      return activeSessionId;
    });

    createOpenCodeServerRuntimeMock.mockImplementation(() => ({
      getSessionId: () => activeSessionId,
      beginTurn,
      flushTurn,
      startOrLoad,
      sendPrompt,
      compactContext,
      cancel: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
    }));

    const { createOpenCodeServerExecutionRunBackend } = await import('./createOpenCodeServerExecutionRunBackend');
    const backend = createOpenCodeServerExecutionRunBackend({
      cwd: '/tmp/opencode-run',
      permissionHandler: {
        handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' as const })),
      },
      permissionMode: 'read-only',
    });

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'session_server' });
    await backend.sendPrompt('session_server', '/compact');
    await backend.waitForResponseComplete?.();

    expect(compactContext).toHaveBeenCalledWith('/compact');
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(flushTurn).toHaveBeenCalledTimes(1);
  });
});
