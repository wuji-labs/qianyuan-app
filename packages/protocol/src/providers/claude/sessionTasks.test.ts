import { describe, expect, it } from 'vitest';

import {
    normalizeClaudeTaskEventToWorkStateItem,
    normalizeClaudeTodoWriteTodosToWorkStateItems,
} from './sessionTasks.js';

describe('Claude task and todo wire schemas', () => {
    it('normalizes task lifecycle statuses without leaking provider status values', () => {
        const item = normalizeClaudeTaskEventToWorkStateItem({
            backendId: 'claude',
            updatedAt: 456,
            event: {
                type: 'task_updated',
                task_id: 'task-1',
                description: 'Run migration',
                status: 'failed',
            },
        });

        expect(item).toMatchObject({
            id: 'task:task-1',
            kind: 'task',
            origin: 'vendor',
            status: 'blocked',
            title: 'Run migration',
            backendId: 'claude',
            vendorRef: 'task-1',
            updatedAt: 456,
        });
        expect((item?.status as string)).not.toBe('failed');
    });

    it('normalizes TodoWrite entries into generic todo items', () => {
        const items = normalizeClaudeTodoWriteTodosToWorkStateItems({
            backendId: 'claude',
            updatedAt: 789,
            todos: [
                { content: 'Patch schema', status: 'in_progress', activeForm: 'Patching schema' },
                { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
            ],
        });

        expect(items.map((item) => item.status)).toEqual(['active', 'pending']);
        expect(items[0]?.id).toMatch(/^todo:derived:/);
    });
});
