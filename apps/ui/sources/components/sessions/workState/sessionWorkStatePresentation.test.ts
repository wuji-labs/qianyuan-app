import { describe, expect, it } from 'vitest';

import {
    formatSessionWorkStateBadgeLabel,
    readSessionWorkStateFromMetadata,
    resolvePrimarySessionWorkStateItem,
    resolveSessionWorkStateStatusBadgePresentation,
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

    it('keeps displayable canonical items when future items are preserved in metadata', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:thread-1',
                items: [
                    { id: 'future:1', kind: 'milestone', origin: 'future', status: 'waiting', title: 'Future item', updatedAt: 10 },
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:thread-1');
    });

    it('keeps displayable canonical items when future items use a different item shape', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:thread-1',
                items: [
                    { id: 'future:1', label: 'Future item', state: 'waiting' },
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:thread-1');
    });

    it('ignores canonical metadata with invalid root timestamps', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: -1,
                items: [
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('keeps a transient editable goal badge anchor when /goal opens without existing work state', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: null,
            activeStatusBadgeKey: 'work-state',
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.goal.title:',
            tone: 'neutral',
            emphasis: 'quiet',
        });
    });

    it('does not render a transient goal badge when goal editing is unavailable', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: null,
            activeStatusBadgeKey: 'work-state',
            editableGoal: false,
            translate,
        });

        expect(presentation).toBeNull();
    });

    it('uses quiet emphasis for ordinary active work state so it stays visible without badge chrome', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'active',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goal:Ship the release',
            tone: 'active',
            emphasis: 'quiet',
        });
    });

    it('uses prominent emphasis for blocked work state that needs attention', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'blocked',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goalBlocked:',
            tone: 'warning',
            emphasis: 'prominent',
        });
    });

    it('preserves precise budget-limited status reason and time fields from canonical metadata', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 20,
                primaryItemId: 'goal:thread-1',
                items: [
                    {
                        id: 'goal:thread-1',
                        kind: 'goal',
                        origin: 'vendor',
                        status: 'blocked',
                        statusReason: 'budgetLimited',
                        title: 'Ship budget display',
                        createdAt: 11,
                        startedAt: 12,
                        completedAt: 19,
                        updatedAt: 20,
                    },
                ],
            },
        });

        expect(snapshot?.items[0]).toEqual(expect.objectContaining({
            status: 'blocked',
            statusReason: 'budgetLimited',
            createdAt: 11,
            startedAt: 12,
            completedAt: 19,
        }));
        expect(formatSessionWorkStateBadgeLabel(snapshot?.items[0] ?? null, translate)).toBe('session.workState.badge.goalBudgetLimited:');
    });
});
