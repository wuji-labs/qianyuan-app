import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }
        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }
        delete(key: string) {
            mmkvStore.delete(key);
        }
        clearAll() {
            mmkvStore.clear();
        }
    }
    return { MMKV };
});

import { createSessionsDomain } from './sessions';
import { clearPersistence } from '@/sync/domains/state/persistence';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    set(domain as any);
    return { get, domain };
}

describe('sessions domain: review comment drafts', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('upserts and deletes review comment drafts per session', () => {
        const { get, domain } = createHarness();

        domain.upsertSessionReviewCommentDraft('s1', {
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'nit',
            createdAt: 1,
        });

        expect(get().reviewCommentsDraftsBySessionId.s1).toHaveLength(1);

        domain.deleteSessionReviewCommentDraft('s1', 'c1');
        expect(get().reviewCommentsDraftsBySessionId.s1 ?? []).toHaveLength(0);
    });
});
