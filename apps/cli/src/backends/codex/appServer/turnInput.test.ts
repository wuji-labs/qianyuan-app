import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTurnInput } from './turnInput';

describe('turnInput', () => {
    it('builds text, vendor plugin mentions, skills, and local images through one structured path', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'Use @gmail and $review',
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        {
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            label: 'Gmail',
                        },
                    ],
                    skillMentions: [
                        {
                            name: 'review',
                            path: '/skills/review/SKILL.md',
                            displayName: 'Review',
                        },
                    ],
                    attachments: [
                        {
                            kind: 'image',
                            mimeType: 'image/png',
                            localPath: '/tmp/upload/image.png',
                        },
                    ],
                },
            },
        })).toEqual([
            { type: 'text', text: 'Use @gmail and $review' },
            { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
            { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
            { type: 'localImage', path: '/tmp/upload/image.png' },
        ]);
    });

    it('supports Remote Dev fallback metadata without raw skill contents', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'fallback',
            metadata: {
                happierVendorPluginMentions: [
                    { vendorPluginRef: 'plugin://notion@openai-curated', label: 'Notion' },
                ],
                happierSkillMentions: [
                    { name: 'docs', path: '/skills/docs/SKILL.md', content: 'do not forward' },
                    { name: 'ignored-without-path' },
                ],
            },
        })).toEqual([
            { type: 'text', text: 'fallback' },
            { type: 'mention', name: 'Notion', path: 'plugin://notion@openai-curated' },
            { type: 'skill', name: 'docs', path: '/skills/docs/SKILL.md' },
        ]);
    });

    it('keeps non-image attachments out of structured app-server image input', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'see attachment',
            metadata: {
                happierStructuredInputV1: {
                    attachments: [
                        {
                            kind: 'file',
                            mimeType: 'text/plain',
                            localPath: '/tmp/upload/note.txt',
                        },
                    ],
                },
            },
        })).toEqual([{ type: 'text', text: 'see attachment' }]);
    });
});
