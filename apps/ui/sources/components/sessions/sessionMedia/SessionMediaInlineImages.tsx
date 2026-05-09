import * as React from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SvgXml } from 'react-native-svg';

import { Modal } from '@/modal';
import { t } from '@/text';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import type { SessionMediaInlineImageSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

import { resolveSessionMediaImageMimeType } from './sessionMediaPresentation';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 2,
        marginBottom: 7,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    tile: {
        width: 84,
        height: 84,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
}));

function SessionMediaInlineImageTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineImageSummary;
    mimeType: string;
    imageIndex: number;
    onOpenPath: (path: string) => void;
    onOpenPreview: (index: number) => void;
    imageTestIDPrefix: string;
    previewTestIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const preview = useSessionImagePreview({
        sessionId: props.sessionId,
        filePath: props.media.path,
        enabled: true,
        cacheKey: props.media.sha256 ?? null,
        mimeType: props.mimeType,
        sizeBytes: props.media.sizeBytes,
    });
    const accessibilityLabel = (() => {
        if (props.media.category === 'attachment') {
            return t('files.sessionMedia.attachmentImageA11y', { name: props.media.name });
        }
        if (props.media.category === 'tool-artifact') {
            return t('files.sessionMedia.toolArtifactImageA11y', { name: props.media.name });
        }
        return t('files.sessionMedia.generatedImageA11y', { name: props.media.name });
    })();

    return (
        <Pressable
            testID={`${props.imageTestIDPrefix}:${props.media.path}`}
            accessibilityRole="imagebutton"
            accessibilityLabel={accessibilityLabel}
            onPress={() => {
                if (preview.status === 'error') {
                    props.onOpenPath(props.media.path);
                    return;
                }
                props.onOpenPreview(props.imageIndex);
            }}
            style={styles.tile}
        >
            {preview.status === 'loaded' ? (
                Platform.OS !== 'web' && preview.svgXml ? (
                    // SVG stays supported, but only after the daemon preview path has read an authorized session file.
                    // Never render transcript-inline XML, provider URLs, or file:// sources here.
                    <SvgXml xml={preview.svgXml} width="100%" height="100%" />
                ) : (
                    <Image
                        testID={`${props.previewTestIDPrefix}:${props.media.path}`}
                        source={{ uri: preview.uri }}
                        resizeMode="cover"
                        style={styles.image}
                    />
                )
            ) : (
                <View style={styles.placeholder}>
                    <Ionicons
                        name={preview.status === 'error' ? 'alert-circle-outline' : 'image-outline'}
                        size={22}
                        color={theme.colors.textSecondary}
                    />
                </View>
            )}
        </Pressable>
    );
}

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: Readonly<{
    sessionId: string;
    media: readonly SessionMediaInlineImageSummary[];
    onOpenPath: (path: string) => void;
    containerTestID?: string;
    imageTestIDPrefix?: string;
    previewTestIDPrefix?: string;
}>) {
    const styles = stylesheet;
    const containerTestID = props.containerTestID ?? 'message-session-media-inline-images';
    const imageTestIDPrefix = props.imageTestIDPrefix ?? 'message-session-media-inline-image';
    const previewTestIDPrefix = props.previewTestIDPrefix ?? 'message-session-media-inline-image-preview';

    const images = React.useMemo(() => {
        const result: Array<Readonly<{
            media: SessionMediaInlineImageSummary;
            mimeType: string;
            modalImage: AttachmentImagePreviewModalImage;
        }>> = [];
        for (const media of props.media) {
            const mimeType = resolveSessionMediaImageMimeType(media);
            if (!mimeType) continue;
            result.push({
                media,
                mimeType,
                modalImage: {
                    kind: 'session-image',
                    title: media.name,
                    sessionId: props.sessionId,
                    filePath: media.path,
                    mimeType,
                    sizeBytes: media.sizeBytes,
                    cacheKey: media.sha256 ?? null,
                },
            });
        }
        return result;
    }, [props.media, props.sessionId]);

    if (images.length === 0) return null;

    return (
        <View testID={containerTestID} style={styles.container}>
            {images.map((entry, index) => (
                <SessionMediaInlineImageTile
                    key={`${entry.media.path}:${entry.media.name}`}
                    sessionId={props.sessionId}
                    media={entry.media}
                    mimeType={entry.mimeType}
                    imageIndex={index}
                    onOpenPath={props.onOpenPath}
                    imageTestIDPrefix={imageTestIDPrefix}
                    previewTestIDPrefix={previewTestIDPrefix}
                    onOpenPreview={(imageIndex) => {
                        Modal.show({
                            component: AttachmentImagePreviewModal,
                            props: {
                                images: images.map((imageEntry) => imageEntry.modalImage),
                                initialIndex: imageIndex,
                            },
                        });
                    }}
                />
            ))}
        </View>
    );
});
