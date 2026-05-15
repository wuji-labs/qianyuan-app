import { describe, expect, it } from 'vitest';

describe('Claude work state normalization', () => {
  it('does not project background task lifecycle system messages to user-facing task items', async () => {
    const mod = await import('./claudeWorkState').catch(() => null);
    expect(mod?.buildClaudeTaskLifecycleWorkState).toEqual(expect.any(Function));

    const snapshot = mod!.buildClaudeTaskLifecycleWorkState({
      backendId: 'claude',
      updatedAt: 200,
      messages: [
        { type: 'system', subtype: 'task_started', task_id: 'task_1', description: 'grep -rn "thing"', task_type: 'local_bash' },
        { type: 'system', subtype: 'task_progress', task_id: 'task_1', description: 'Reading logs', task_type: 'local_bash' },
        { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed', summary: 'Background command completed' },
      ],
    });

    expect(snapshot.items).toEqual([]);
    expect(snapshot.primaryItemId).toBeNull();
  });

  it('projects TodoWrite data to generic todo items', async () => {
    const mod = await import('./claudeWorkState').catch(() => null);
    expect(mod?.buildClaudeTodoWriteWorkState).toEqual(expect.any(Function));

    const snapshot = mod!.buildClaudeTodoWriteWorkState({
      backendId: 'claude',
      updatedAt: 300,
      input: {
        todos: [
          { content: 'Write test', status: 'in_progress', activeForm: 'Writing test' },
          { content: 'Refactor', status: 'pending' },
        ],
      },
    });

    expect(snapshot.primaryItemId).toBe(snapshot.items[0].id);
    expect(snapshot.items.map((item: any) => item.status)).toEqual(['active', 'pending']);
    expect(snapshot.items[0].title).toBe('Write test');
    expect(snapshot.items[0].summary).toBe('Writing test');
  });

  it('tracks Claude TaskCreate results and TaskUpdate tool uses as task-list state', async () => {
    const mod = await import('./claudeWorkState').catch(() => null);
    expect(mod?.createClaudeTaskToolWorkStateTracker).toEqual(expect.any(Function));

    const tracker = mod!.createClaudeTaskToolWorkStateTracker({
      backendId: 'claude',
      agentId: 'claude',
    });

    const createSnapshot = tracker.applyMessage({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_create_1',
          name: 'TaskCreate',
          input: {
            subject: 'Patch task projection',
            activeForm: 'Patching task projection',
          },
        }],
      },
    }, 400);

    expect(createSnapshot?.items).toEqual([
      expect.objectContaining({
        id: 'task:tool_use:toolu_create_1',
        kind: 'task',
        status: 'pending',
        title: 'Patch task projection',
      }),
    ]);

    const resultSnapshot = tracker.applyMessage({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_create_1',
          content: 'Task #1 created successfully: Patch task projection',
          tool_use_result: {
            task: {
              id: 'task_real_1',
              subject: 'Patch task projection',
              status: 'pending',
            },
          },
        }],
      },
    }, 401);

    expect(resultSnapshot?.items).toEqual([
      expect.objectContaining({
        id: 'task:task_real_1',
        kind: 'task',
        status: 'pending',
        title: 'Patch task projection',
        vendorRef: 'task_real_1',
      }),
    ]);

    const updateSnapshot = tracker.applyMessage({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_update_1',
          name: 'TaskUpdate',
          input: {
            taskId: 'task_real_1',
            status: 'in_progress',
            subject: 'Run tests',
          },
        }],
      },
    }, 402);

    expect(updateSnapshot?.items).toEqual([
      expect.objectContaining({
        id: 'task:task_real_1',
        status: 'active',
        title: 'Run tests',
      }),
    ]);
  });

  it('replaces task-list state from TaskList tool results', async () => {
    const mod = await import('./claudeWorkState').catch(() => null);
    const tracker = mod!.createClaudeTaskToolWorkStateTracker({
      backendId: 'claude',
      agentId: 'claude',
    });

    tracker.applyMessage({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_create_1',
          name: 'TaskCreate',
          input: { subject: 'Stale task' },
        }],
      },
    }, 500);

    tracker.applyMessage({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_list_1',
          name: 'TaskList',
          input: {},
        }],
      },
    }, 501);

    const snapshot = tracker.applyMessage({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_list_1',
          content: 'Listed tasks',
          tool_use_result: {
            tasks: [
              { id: 'task_a', subject: 'Author tests', status: 'completed' },
              { id: 'task_b', subject: 'Ship parser', status: 'pending' },
            ],
          },
        }],
      },
    }, 502);

    expect(snapshot?.items.map((item: any) => [item.vendorRef, item.status, item.title])).toEqual([
      ['task_a', 'complete', 'Author tests'],
      ['task_b', 'pending', 'Ship parser'],
    ]);
  });
});
