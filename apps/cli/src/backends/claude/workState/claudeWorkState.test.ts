import { describe, expect, it } from 'vitest';

describe('Claude work state normalization', () => {
  it('projects task lifecycle system messages to generic task items', async () => {
    const mod = await import('./claudeWorkState').catch(() => null);
    expect(mod?.buildClaudeTaskLifecycleWorkState).toEqual(expect.any(Function));

    const snapshot = mod!.buildClaudeTaskLifecycleWorkState({
      backendId: 'claude',
      updatedAt: 200,
      messages: [
        { type: 'system', subtype: 'task_started', task_id: 'task_1', description: 'Investigate bug' },
        { type: 'system', subtype: 'task_progress', task_id: 'task_1', description: 'Reading logs' },
        { type: 'system', subtype: 'task_notification', task_id: 'task_2', status: 'failed', summary: 'No route' },
      ],
    });

    expect(snapshot.items.find((item: any) => item.id === 'task:task_1')).toMatchObject({
      kind: 'task',
      status: 'active',
      title: 'Reading logs',
    });
    expect(snapshot.items.find((item: any) => item.id === 'task:task_2')).toMatchObject({
      status: 'blocked',
      title: 'No route',
    });
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
});
