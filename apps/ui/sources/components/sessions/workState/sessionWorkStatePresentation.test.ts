import { describe, expect, it } from 'vitest';

import {
    formatSessionWorkStateBadgeLabel,
    readSessionWorkStateFromMetadata,
    resolvePrimarySessionWorkStateItem,
} from './sessionWorkStatePresentation';

const translate = (key: string, params?: Record<string, unknown>) => `${key}:${params?.title ?? ''}`;

describe('sessionWorkStatePresentation', () => {
    it('reads canonical sessionWorkStateV1 metadata and resolves primaryItemId first', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:codex',
                items: [
                    { id: 'todo:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run tests', updatedAt: 9 },
                    { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Migrate plugin support', updatedAt: 10 },
                ],
            },
        });

        const primary = resolvePrimarySessionWorkStateItem(snapshot);
        expect(primary?.id).toBe('goal:codex');
        expect(formatSessionWorkStateBadgeLabel(primary, translate)).toBe('session.workState.badge.goal:Migrate plugin support');
    });

    it('falls back defensively when primaryItemId is stale', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'opencode',
                updatedAt: 10,
                primaryItemId: 'missing',
                items: [
                    { id: 'goal:1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Goal text', updatedAt: 8 },
                    { id: 'todo:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Update permissions', updatedAt: 9 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('todo:1');
    });

    it('ignores malformed canonical metadata safely', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                items: [
                    { id: '', kind: 'goal', origin: 'vendor', status: 'active', title: 'Missing id', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('normalizes legacy goal metadata only at the read edge', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            flavor: 'codex',
            sessionGoalV1: {
                objective: 'Ship goals',
                status: 'paused',
                updatedAt: 12,
            },
        });

        expect(snapshot?.backendId).toBe('codex');
        expect(snapshot?.items[0]).toEqual(expect.objectContaining({
            id: 'goal:legacy',
            kind: 'goal',
            status: 'paused',
            title: 'Ship goals',
        }));
    });
});
