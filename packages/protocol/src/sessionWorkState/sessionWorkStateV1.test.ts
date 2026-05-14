import { describe, expect, it } from 'vitest';

import {
    readDisplayableSessionWorkStateV1,
    SessionWorkStateItemV1Schema,
    SessionWorkStateStatusV1Schema,
    SessionWorkStateV1Schema,
} from './sessionWorkStateV1.js';
import {
    buildDeterministicSessionWorkStateItemId,
    buildVendorSessionWorkStateItemId,
} from './sessionWorkStateItemIds.js';

describe('SessionWorkStateV1', () => {
    it('parses the canonical bounded metadata shape', () => {
        const parsed = SessionWorkStateV1Schema.parse({
            v: 1,
            backendId: 'codex',
            agentId: 'agent-codex',
            updatedAt: 1_716_000_000_000,
            primaryItemId: 'goal:thread-1',
            truncated: { reason: 'item_limit', omittedCount: 2 },
            items: [
                {
                    id: 'goal:thread-1',
                    kind: 'goal',
                    origin: 'vendor',
                    status: 'active',
                    title: 'Migrate app-server goals',
                    backendId: 'codex',
                    agentId: 'agent-codex',
                    vendorRef: 'thread-1',
                    updatedAt: 1_716_000_000_000,
                    tokenBudget: null,
                },
            ],
        });

        expect(parsed.v).toBe(1);
        expect(parsed.backendId).toBe('codex');
        expect(parsed.items[0]?.status).toBe('active');
        expect(parsed.truncated).toEqual({ reason: 'item_limit', omittedCount: 2 });
    });

    it('accepts only provider-neutral item statuses', () => {
        expect(SessionWorkStateStatusV1Schema.options).toEqual([
            'pending',
            'active',
            'paused',
            'blocked',
            'complete',
            'cancelled',
            'unknown',
        ]);

        expect(() =>
            SessionWorkStateItemV1Schema.parse({
                id: 'todo:1',
                kind: 'todo',
                origin: 'vendor',
                status: 'in_progress',
                title: 'Provider status leaked',
                updatedAt: 1,
            }),
        ).toThrow();
    });

    it('builds stable vendor and deterministic fallback item ids', () => {
        expect(buildVendorSessionWorkStateItemId('goal', 'thread-1')).toBe('goal:thread-1');

        const first = buildDeterministicSessionWorkStateItemId({
            kind: 'todo',
            sourceFamily: 'opencode.todo',
            stableParts: ['Write tests', '0'],
        });
        const second = buildDeterministicSessionWorkStateItemId({
            kind: 'todo',
            sourceFamily: 'opencode.todo',
            stableParts: ['Write tests', '0'],
        });

        expect(first).toBe(second);
        expect(first).toMatch(/^todo:derived:/);
    });

    it('reads displayable known items while ignoring preserved future items', () => {
        const parsed = readDisplayableSessionWorkStateV1({
            v: 1,
            backendId: 'codex',
            updatedAt: 10,
            primaryItemId: 'goal:thread-1',
            items: [
                {
                    id: 'future:1',
                    kind: 'milestone',
                    origin: 'future',
                    status: 'waiting',
                    title: 'Future item',
                    updatedAt: 10,
                },
                {
                    id: 'goal:thread-1',
                    kind: 'goal',
                    origin: 'vendor',
                    status: 'active',
                    title: 'Known goal',
                    updatedAt: 10,
                    futureItemField: 'keep',
                },
            ],
            futureSnapshotField: 'keep',
        });

        expect(parsed).toMatchObject({
            v: 1,
            backendId: 'codex',
            updatedAt: 10,
            primaryItemId: 'goal:thread-1',
            futureSnapshotField: 'keep',
            items: [
                {
                    id: 'goal:thread-1',
                    kind: 'goal',
                    futureItemField: 'keep',
                },
            ],
        });
    });

    it('returns null when a non-empty snapshot has no displayable items', () => {
        expect(readDisplayableSessionWorkStateV1({
            v: 1,
            backendId: 'codex',
            updatedAt: 10,
            items: [
                {
                    id: 'future:1',
                    kind: 'milestone',
                    origin: 'future',
                    status: 'waiting',
                    title: 'Future item',
                    updatedAt: 10,
                },
            ],
        })).toBeNull();
    });
});
