import { describe, expect, it } from 'vitest';

import { normalizeCodexAppServerGoalToSessionWorkStateItem } from './appServerGoal.js';

describe('Codex app-server goal wire schema', () => {
    it('normalizes app-server goals into generic work-state goal items', () => {
        const item = normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            agentId: 'agent-codex',
            goal: {
                threadId: 'thread-1',
                objective: 'Ship plugin support',
                status: 'budgetLimited',
                tokenBudget: 123,
                tokensUsed: 45,
                timeUsedSeconds: 6,
                createdAt: '2026-05-13T10:00:00.000Z',
                updatedAt: '2026-05-13T10:05:00.000Z',
            },
        });

        expect(item).toMatchObject({
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'blocked',
            title: 'Ship plugin support',
            backendId: 'codex',
            agentId: 'agent-codex',
            vendorRef: 'thread-1',
            tokenBudget: 123,
            tokensUsed: 45,
            timeUsedSeconds: 6,
        });
        expect(item?.updatedAt).toBe(Date.parse('2026-05-13T10:05:00.000Z'));
    });

    it('returns null for malformed app-server goals', () => {
        expect(normalizeCodexAppServerGoalToSessionWorkStateItem({
            backendId: 'codex',
            goal: { threadId: '', objective: '', status: 'active', updatedAt: 'nope' },
        })).toBeNull();
    });
});
