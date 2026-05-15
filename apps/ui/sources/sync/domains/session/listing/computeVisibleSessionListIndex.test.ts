import { afterEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { SessionListIndexItem } from './sessionListIndex';
import type { SessionListAttentionPromotionOptions } from './attentionPromotion/sessionListAttentionPromotion';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';

function makeSessionRow(
    id: string,
    partial?: Partial<SessionListRenderableSession>,
): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        owner: undefined,
        accessLevel: undefined,
        canApprovePermissions: undefined,
        hasPendingPermissionRequests: undefined,
        hasPendingUserActionRequests: undefined,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...(partial ?? {}),
    };
}

function makeResolver(rowsByKey: Record<string, SessionListRenderableSession>) {
    return (serverId: string | null | undefined, sessionId: string) => {
        const key = `${String(serverId ?? '').trim()}:${String(sessionId ?? '').trim()}`;
        return rowsByKey[key] ?? null;
    };
}

describe('computeVisibleSessionListIndex', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('returns the original array when custom ordering inputs are no-ops', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 20 }),
                's1:b': makeSessionRow('b', { createdAt: 20, updatedAt: 30 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: [] },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
    });

    it('orders sessions by updatedAt descending when ordering mode is updated', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'd', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'c', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 200 }),
                's1:b': makeSessionRow('b', { createdAt: 30, updatedAt: 100 }),
                's1:c': makeSessionRow('c', { createdAt: 20, updatedAt: 100 }),
                's1:d': makeSessionRow('d', { createdAt: 20, updatedAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:c', 's1:b'] },
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('applies mixed folder and session ordering inside a workspace root folder group', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: planningFolderGroupKey,
                groupKind: 'folder',
                folderId: 'planning',
                folderDepth: 1,
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: rootFolderGroupKey,
                groupKind: 'folder',
                folderId: null,
                folderDepth: 0,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:in-folder': makeSessionRow('in-folder', { active: true }),
                's1:at-root': makeSessionRow('at-root', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [rootFolderGroupKey]: ['s1:at-root', 'folder:planning'] },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            's:at-root',
            'h:folder:Planning',
            's:in-folder',
        ]);
    });

    it('promotes sessions needing attention after pinned sessions without duplicating rows', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'pinned', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:pinned': makeSessionRow('pinned', { latestReadyEventSeq: 4, latestReadyEventAt: 30, lastViewedSessionSeq: 1 }),
                's1:ready': makeSessionRow('ready', { latestReadyEventSeq: 4, latestReadyEventAt: 20, lastViewedSessionSeq: 1 }),
                's1:normal': makeSessionRow('normal', { latestReadyEventSeq: 4, latestReadyEventAt: 10, lastViewedSessionSeq: 4 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.pinned === true ? 'pinned' : 'unpinned'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:pinned:Pinned',
            's:pinned:pinned:pinned:none',
            'h:attention:Needs attention',
            's:ready:attention:unpinned:ready',
            'h:date:Today',
            's:normal:date:unpinned:none',
        ]);
    });

    it('keeps globally promoted inactive sessions visible when inactive sessions are hidden', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:ready': makeSessionRow('ready', { latestReadyEventSeq: 4, latestReadyEventAt: 20, lastViewedSessionSeq: 1 }),
                's1:normal': makeSessionRow('normal'),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:ready:attention',
        ]);
    });

    it('promotes active permission blockers even while the turn is in progress', () => {
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'permission', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];
        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                }),
                's1:permission': makeSessionRow('permission', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:permission:attention:permission_required',
            'h:active:Active',
            'h:project:~/repo',
            's:working:project:none',
        ]);
    });

    it('keeps attention sessions inside their current groups when within-groups mode is selected', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:normal': makeSessionRow('normal'),
                's1:ready': makeSessionRow('ready', { latestReadyEventSeq: 4, latestReadyEventAt: 20, lastViewedSessionSeq: 1 }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'withinGroups' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:date:Today',
            's:ready:date:ready',
        ]);
    });
});
