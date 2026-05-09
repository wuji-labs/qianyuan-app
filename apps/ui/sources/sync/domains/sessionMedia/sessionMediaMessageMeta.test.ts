import { describe, expect, it } from 'vitest';

import { parseSessionMediaMessageMeta } from './sessionMediaMessageMeta';

function buildSessionMediaMeta(path: string): unknown {
    return {
        happier: {
            kind: 'session_media.v1',
            payload: {
                media: [
                    {
                        id: 'media-1',
                        role: 'output',
                        category: 'generated',
                        mediaKind: 'image',
                        name: 'generated.png',
                        path,
                        mimeType: 'image/png',
                        sizeBytes: 10,
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        },
    };
}

describe('parseSessionMediaMessageMeta', () => {
    it('ignores public URL and embedded-data media paths', () => {
        for (const path of [
            'https://example.test/generated.png',
            'http://example.test/generated.png',
            'blob:https://example.test/generated',
            'data:image/png;base64,AAAA',
        ]) {
            expect(parseSessionMediaMessageMeta(buildSessionMediaMeta(path)).inlineImages).toEqual([]);
        }
    });
});
