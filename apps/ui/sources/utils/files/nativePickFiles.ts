import { isBrowserFile, sanitizePickedName } from './pickedFileNormalization';

export type NativePickedFile =
    | Readonly<{ kind: 'web'; file: File }>
    | Readonly<{
        kind: 'native';
        uri: string;
        name: string;
        sizeBytes: number | null;
        mimeType: string | null;
    }>;

export async function nativePickFiles(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
    let DocumentPicker: any;
    try {
        DocumentPicker = await import('expo-document-picker');
    } catch (err) {
        // expo-document-picker not autolinked into this build — turns "tap did nothing"
        // into a searchable log line on the device.
        console.warn('[nativePickFiles] expo-document-picker unavailable:', err instanceof Error ? err.message : err);
        return [];
    }
    if (typeof DocumentPicker?.getDocumentAsync !== 'function') {
        console.warn('[nativePickFiles] DocumentPicker.getDocumentAsync is not a function — check expo-document-picker autolinking.');
        return [];
    }
    const result = await DocumentPicker.getDocumentAsync({
        multiple,
        type: '*/*',
    });
    if (!result || result.canceled) return [];

    const assets = Array.isArray(result.assets) ? result.assets : [];
    const mapped: NativePickedFile[] = assets
        .map((asset: any) => {
            const file = asset?.file;
            if (isBrowserFile(file)) {
                return { kind: 'web' as const, file };
            }

            return {
                kind: 'native' as const,
                uri: typeof asset?.uri === 'string' ? asset.uri : '',
                name: sanitizePickedName(asset?.name, 'file'),
                sizeBytes: typeof asset?.size === 'number' ? asset.size : null,
                mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
            };
        })
        .filter((entry: NativePickedFile) => entry.kind === 'web' || entry.uri.length > 0);

    return mapped;
}
