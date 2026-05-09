import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installSessionAttachmentCommonModuleMocks } from '../attachments/sessionAttachmentTestHelpers';

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock(),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
    text: () => createTextModuleMock({
        translate: (key, params) => `${key}:${String(params?.name ?? '')}`,
    }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: () => ({
        status: 'loading',
        uri: null,
        svgXml: null,
        error: null,
    }),
}));

describe('SessionMediaInlineImages', () => {
    it('adds translated accessibility labels to generated image tiles', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = {
            id: 'media-1',
            name: 'cat.png',
            path: '.happier/uploads/generated/message-1/cat.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'generated' as const,
            role: 'output' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[media]}
                onOpenPath={() => {}}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${media.path}`);

        expect(tile).not.toBeNull();
        expect(tile?.props.accessibilityLabel).toBe('files.sessionMedia.generatedImageA11y:cat.png');
    });

    it('uses attachment-specific accessibility labels for attachment image tiles', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = {
            id: 'media-2',
            name: 'upload.png',
            path: '.happier/uploads/messages/message-1/upload.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'attachment' as const,
            role: 'input' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[media]}
                onOpenPath={() => {}}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${media.path}`);

        expect(tile).not.toBeNull();
        expect(tile?.props.accessibilityLabel).toBe('files.sessionMedia.attachmentImageA11y:upload.png');
    });
});
