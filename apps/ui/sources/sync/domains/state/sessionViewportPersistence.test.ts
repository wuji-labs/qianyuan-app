import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '../scope/serverAccountScope';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import {
    MAX_PERSISTED_SESSION_VIEWPORTS,
    clearPersistedSessionViewports,
    deletePersistedSessionViewport,
    loadPersistedSessionViewports,
    readPersistedSessionViewport,
    upsertPersistedSessionViewport,
    type PersistedSessionViewportV1,
} from './sessionViewportPersistence';
import { sessionViewportStorageKey } from './sessionLocalStateKeys';

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-1' };
const scopeB: ServerAccountScope = { serverId: 'server-b', accountId: 'account-1' };

function buildViewport(overrides: Partial<PersistedSessionViewportV1> = {}): PersistedSessionViewportV1 {
    return {
        isPinned: false,
        anchor: {
            kind: 'message',
            messageId: 'message-1',
            seq: 42,
            itemId: 'msg:message-1',
            itemOffsetPx: -24,
            capturedAtMs: 1_000,
        },
        offsetY: 420,
        lastUpdatedAt: 2_000,
        ...overrides,
    };
}

describe('session viewport persistence', () => {
    beforeEach(() => {
        store.clear();
    });

    it('round-trips the identity-first durable unit per session', () => {
        upsertPersistedSessionViewport('session-1', buildViewport());

        expect(readPersistedSessionViewport('session-1')).toEqual(buildViewport());
        expect(readPersistedSessionViewport('session-2')).toBeNull();
    });

    it('keys records by session id so forked sessions never inherit a parent anchor', () => {
        upsertPersistedSessionViewport('session-parent', buildViewport());

        expect(readPersistedSessionViewport('session-parent')).not.toBeNull();
        expect(readPersistedSessionViewport('session-parent-fork')).toBeNull();
    });

    it('isolates records per server-account scope', () => {
        upsertPersistedSessionViewport('session-1', buildViewport(), scopeA);

        expect(readPersistedSessionViewport('session-1', scopeA)).toEqual(buildViewport());
        expect(readPersistedSessionViewport('session-1', scopeB)).toBeNull();
        expect(readPersistedSessionViewport('session-1')).toBeNull();
    });

    it('accepts anchors without a known seq (seq stays null for downstream resolution)', () => {
        const viewport = buildViewport({
            anchor: {
                kind: 'message',
                messageId: 'message-1',
                seq: null,
                itemId: 'msg:message-1',
                itemOffsetPx: 12,
                capturedAtMs: 1_000,
            },
        });
        upsertPersistedSessionViewport('session-1', viewport);

        expect(readPersistedSessionViewport('session-1')).toEqual(viewport);
    });

    it('drops identity-less anchors on write while keeping the degraded distance metadata', () => {
        upsertPersistedSessionViewport('session-1', buildViewport({
            anchor: {
                kind: 'item',
                messageId: '',
                seq: null,
                itemId: 'divider:1',
                itemOffsetPx: 0,
                capturedAtMs: 1_000,
            },
        }));

        expect(readPersistedSessionViewport('session-1')).toEqual(buildViewport({ anchor: null }));
    });

    it('sanitizes malformed persisted payloads instead of throwing', () => {
        store.set(sessionViewportStorageKey(), 'not-json');
        expect(loadPersistedSessionViewports()).toEqual({});

        store.set(sessionViewportStorageKey(), JSON.stringify({
            'session-valid': buildViewport(),
            'session-bad-anchor-seq': buildViewport({
                anchor: {
                    kind: 'message',
                    messageId: 'message-2',
                    seq: Number.NaN,
                    itemId: 'msg:message-2',
                    itemOffsetPx: 4,
                    capturedAtMs: 1_000,
                },
            }),
            'session-not-object': 7,
            'session-bad-updated-at': buildViewport({ lastUpdatedAt: Number.POSITIVE_INFINITY }),
        }));

        const loaded = loadPersistedSessionViewports();
        expect(Object.keys(loaded).sort()).toEqual(['session-bad-anchor-seq', 'session-valid']);
        expect(loaded['session-valid']).toEqual(buildViewport());
        // Invalid seq degrades to null without dropping the identity anchor.
        expect(loaded['session-bad-anchor-seq']?.anchor).toMatchObject({ messageId: 'message-2', seq: null });
    });

    it('deletes a single session record and removes the storage key when empty', () => {
        upsertPersistedSessionViewport('session-1', buildViewport());
        upsertPersistedSessionViewport('session-2', buildViewport());

        deletePersistedSessionViewport('session-1');
        expect(readPersistedSessionViewport('session-1')).toBeNull();
        expect(readPersistedSessionViewport('session-2')).not.toBeNull();

        deletePersistedSessionViewport('session-2');
        expect(store.has(sessionViewportStorageKey())).toBe(false);
    });

    it('deleting an absent record does not create or rewrite storage', () => {
        deletePersistedSessionViewport('session-unknown');
        expect(store.has(sessionViewportStorageKey())).toBe(false);
    });

    it('clears all records for a scope', () => {
        upsertPersistedSessionViewport('session-1', buildViewport(), scopeA);
        clearPersistedSessionViewports(scopeA);
        expect(readPersistedSessionViewport('session-1', scopeA)).toBeNull();
    });

    it('caps stored records by recency (lastUpdatedAt) to bound storage growth', () => {
        for (let index = 0; index < MAX_PERSISTED_SESSION_VIEWPORTS + 5; index += 1) {
            upsertPersistedSessionViewport(`session-${index}`, buildViewport({ lastUpdatedAt: index }));
        }

        const loaded = loadPersistedSessionViewports();
        expect(Object.keys(loaded)).toHaveLength(MAX_PERSISTED_SESSION_VIEWPORTS);
        // Oldest entries were pruned; the newest survive.
        expect(loaded['session-0']).toBeUndefined();
        expect(loaded['session-4']).toBeUndefined();
        expect(loaded[`session-${MAX_PERSISTED_SESSION_VIEWPORTS + 4}`]).toBeDefined();
        expect(loaded['session-5']).toBeDefined();
    });
});
