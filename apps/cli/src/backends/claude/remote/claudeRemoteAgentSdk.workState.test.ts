import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

function createQueryFromMessages(messages: readonly unknown[]) {
  return vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    close: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    supportedCommands: vi.fn(async () => []),
    supportedModels: vi.fn(async () => []),
  } as any));
}

describe('claudeRemoteAgentSdk work-state projection', () => {
  it('does not publish background task lifecycle system messages as user-facing work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'grep -rn "thing"',
        task_type: 'local_bash',
        session_id: 'claude-session-1',
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).not.toHaveBeenCalled();
  });

  it('publishes TodoWrite tool inputs as todo work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_todo_1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Wire send path', activeForm: 'Wiring send path', status: 'in_progress' },
                  { content: 'Run tests', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'claude',
      ownedSourceFamilies: ['todo'],
      items: [
        expect.objectContaining({
          kind: 'todo',
          status: 'active',
          title: 'Wire send path',
          summary: 'Wiring send path',
        }),
        expect.objectContaining({
          kind: 'todo',
          status: 'pending',
          title: 'Run tests',
        }),
      ],
    }));
  });

  it('publishes empty TodoWrite snapshots so completed todo lists clear stale todos', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_todo_empty',
              name: 'TodoWrite',
              input: { todos: [] },
            },
          ],
        },
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'claude',
      ownedSourceFamilies: ['todo'],
      items: [],
      primaryItemId: null,
    }));
  });

  it('publishes Claude TaskCreate and TaskUpdate tool uses as task-list work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_create_1',
              name: 'TaskCreate',
              input: {
                subject: 'Patch task projection',
                activeForm: 'Patching task projection',
              },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_create_1',
              content: '{"task":{"id":"task_real_1","subject":"Patch task projection","status":"pending"}}',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_update_1',
              name: 'TaskUpdate',
              input: {
                taskId: 'task_real_1',
                status: 'in_progress',
                subject: 'Run tests',
              },
            },
          ],
        },
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      backendId: 'claude',
      ownedSourceFamilies: ['task'],
      items: [
        expect.objectContaining({
          id: 'task:task_real_1',
          kind: 'task',
          status: 'active',
          title: 'Run tests',
        }),
      ],
    }));
  });
});
