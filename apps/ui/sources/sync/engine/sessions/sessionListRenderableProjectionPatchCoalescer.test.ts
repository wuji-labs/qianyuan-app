import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListRenderablePatch } from '@/sync/store/domains/sessionListRenderableStoreUpdate';
import { createSessionListRenderableProjectionPatchCoalescer } from './sessionListRenderableProjectionPatchCoalescer';

function buildRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('createSessionListRenderableProjectionPatchCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        ['leading patch', undefined],
        ['force-immediate patch', { forceImmediate: true }],
    ] as const)('clears %s leading state when a session is dropped', (_label, options) => {
        const renderables = new Map<string, SessionListRenderableSession>([
            ['s1', buildRenderable('s1')],
        ]);
        const appliedUpdatedAt: number[] = [];
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches: SessionListRenderablePatch[]) => {
                for (const { sessionId, patch } of patches) {
                    const previous = renderables.get(sessionId);
                    if (!previous) continue;
                    const next = { ...previous, ...patch, id: previous.id };
                    renderables.set(sessionId, next);
                    appliedUpdatedAt.push(next.updatedAt);
                }
            },
        });

        coalescer.enqueue('s1', 2, options);
        coalescer.dropSessionIds(['s1']);
        coalescer.enqueue('s1', 3);

        expect(appliedUpdatedAt).toEqual([2, 3]);
    });
});
