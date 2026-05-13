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
  it('publishes task lifecycle system messages as work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Investigate flakes',
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

    expect(onWorkStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'claude',
      items: [
        expect.objectContaining({
          kind: 'task',
          status: 'active',
          title: 'Investigate flakes',
        }),
      ],
    }));
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
});
