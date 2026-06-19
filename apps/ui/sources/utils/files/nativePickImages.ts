import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { NativePickedFile } from './nativePickFiles';
import { isBrowserFile, sanitizePickedName } from './pickedFileNormalization';

type ImagePickerNativeModule = Readonly<{
    launchImageLibraryAsync?: unknown;
}>;

function isImagePickerNativeModuleAvailable(): boolean {
    if (Platform.OS === 'web') return true;
    const nativeModule = requireOptionalNativeModule<ImagePickerNativeModule>('ExponentImagePicker');
    const available = typeof nativeModule?.launchImageLibraryAsync === 'function';
    if (!available) {
        // Silent-fail diagnostic: the native module was not autolinked into this build.
        // Surfacing it here turns a confusing "tap did nothing" symptom into a single
        // searchable line in the device log.
        console.warn('[nativePickImages] ExponentImagePicker native module unavailable on', Platform.OS, '— picker will return []. Check expo-image-picker autolinking in the EAS build.');
    }
    return available;
}

function sanitizePickedNameFromAsset(asset: unknown): string {
    const anyAsset = asset as any;
    return sanitizePickedName(anyAsset?.fileName ?? anyAsset?.name ?? anyAsset?.uri, 'image');
}

export async function nativePickImages(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
    if (!isImagePickerNativeModuleAvailable()) return [];

    const ImagePicker: any = await import('expo-image-picker');
    const launchImageLibraryAsync: any =
        ImagePicker.launchImageLibraryAsync
        ?? ImagePicker.default?.launchImageLibraryAsync
        ?? null;
    const mediaTypeImages: any =
        ImagePicker.MediaTypeOptions?.Images
        ?? ImagePicker.default?.MediaTypeOptions?.Images
        ?? 'images';
    if (typeof launchImageLibraryAsync !== 'function') return [];

    const result = await launchImageLibraryAsync({
        mediaTypes: mediaTypeImages,
        allowsMultipleSelection: multiple,
        quality: 1,
    });
    if (!result || result.canceled) return [];

    if (typeof ImagePicker.getMediaLibraryPermissionsAsync === 'function') {
        // Permission denied also surfaces as `canceled` in some builds. Logging the asset
        // count when picker returns lets us tell "user cancelled" from "permission denied"
        // when debugging a real device.
        try {
            const perms = await ImagePicker.getMediaLibraryPermissionsAsync();
            if (perms?.status && perms.status !== 'granted') {
                console.warn('[nativePickImages] media library permission not granted:', perms.status);
            }
        } catch { /* non-fatal */ }
    }

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
                name: sanitizePickedNameFromAsset(asset),
                sizeBytes: typeof asset?.fileSize === 'number' ? asset.fileSize : null,
                mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
            };
        })
        .filter((entry: NativePickedFile) => entry.kind === 'web' || entry.uri.length > 0);

    return mapped;
}
