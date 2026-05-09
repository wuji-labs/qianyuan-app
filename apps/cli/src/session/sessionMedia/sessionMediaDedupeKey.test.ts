import { describe, expect, it } from 'vitest';

import type { SessionMediaSource } from '@/agent/core/AgentMessage';

import { resolveSessionMediaDedupeKey } from './sessionMediaDedupeKey';

describe('resolveSessionMediaDedupeKey', () => {
    it('hashes base64 media payloads instead of embedding full payloads in memory', () => {
        const largePayload = 'iVBORw0KGgo='.repeat(10_000);
        const media: SessionMediaSource = {
            kind: 'base64',
            data: largePayload,
            mimeType: 'image/png',
            origin: { source: 'acp-content', providerEventId: 'event-1', contentIndex: 0 },
        };

        const key = resolveSessionMediaDedupeKey(media);

        expect(key).not.toContain(largePayload);
        expect(key).toMatch(/^acp-content:event-1:0:image\/png:sha256:[a-f0-9]{64}$/);
    });

    it('preserves explicit provider dedupe keys', () => {
        const media: SessionMediaSource = {
            kind: 'local-uri',
            uri: 'file:///tmp/generated.png',
            mimeType: 'image/png',
            origin: { source: 'tool-output', toolCallId: 'tool-1', contentIndex: 0 },
            dedupeKey: 'provider:key',
        };

        expect(resolveSessionMediaDedupeKey(media)).toBe('provider:key');
    });
});
