import { beforeEach, describe, expect, it, vi } from 'vitest';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const queryMock = vi.fn();
const ensureJavaScriptRuntimeExecutableMock = vi.fn(async () => '/managed/js-runtime');

vi.mock('@/backends/claude/sdk/query', () => ({
  query: queryMock,
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/agent/runtime/subprocessArtifacts', () => ({
  createSubprocessStderrAppender: vi.fn(async () => null),
}));

function createQueryResult(): ReturnType<typeof queryMock> {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn(async () => {}),
  };
}

describe('ClaudeSdkAgentBackend runtime bootstrap', () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    queryMock.mockReturnValue(createQueryResult());
  });

  it('bootstraps the managed JavaScript runtime before starting the SDK query', async () => {
    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionPolicy: 'no_tools',
    });

    try {
      await backend.startSession();
    } finally {
      await backend.dispose();
    }

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          executable: '/managed/js-runtime',
        }),
      }),
    );
  });

  it('prefers query.stopTask(taskId) over query.interrupt() when cancelling a turn with an active task id', async () => {
    const taskStartedProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_1', session_id: 'sess_1' };
          taskStartedProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionPolicy: 'no_tools',
    });

    try {
      const { sessionId } = await backend.startSession();
      await taskStartedProcessed.promise;

      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_1');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });
});
