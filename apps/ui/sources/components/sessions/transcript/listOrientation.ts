/**
 * Transcript list orientation seam (lane N3.1 of the inverted-FlashList pilot).
 *
 * Everything inside the transcript stays in canonical oldest-first scroll space:
 * 0 = older/history edge, max = newest/live-tail edge. FlashList/RN `inverted`
 * exposes visual bottom at the raw list start, so this module is the only place
 * that mirrors raw native offsets into canonical transcript offsets.
 */

export type TranscriptListOrientation = 'standard' | 'inverted';

export type TranscriptListPresentation = Readonly<{
    implementation: 'flash_v2' | 'flatlist_legacy';
    orientation: TranscriptListOrientation;
}>;

function isInRangeIndex(index: number, count: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < count;
}

/**
 * Resolves the account setting value to the rendered list presentation.
 * 'flatlist_legacy' -> { flatlist_legacy, standard }.
 * 'flash_v2_inverted' on native -> { flash_v2, inverted } (the pilot).
 * 'flash_v2_inverted' on web -> { flash_v2, standard } (web hot/cold split + DOM
 * writers assume non-inverted; native-only pilot).
 * 'flash_v2' and ANY unknown/invalid value -> { flash_v2, standard } (mirrors
 * today's tolerant fallback).
 */
export function resolveTranscriptListPresentation(
    params: Readonly<{ setting: unknown; platformIsWeb: boolean }>
): TranscriptListPresentation {
    if (params.setting === 'flatlist_legacy') {
        return { implementation: 'flatlist_legacy', orientation: 'standard' };
    }
    if (params.setting === 'flash_v2_inverted' && !params.platformIsWeb) {
        return { implementation: 'flash_v2', orientation: 'inverted' };
    }
    return { implementation: 'flash_v2', orientation: 'standard' };
}

/**
 * View adapter at the list boundary. standard: returns the SAME array reference
 * (identity — no alloc). inverted: newest-first reversed COPY (input never
 * mutated); may return the same reference when items.length <= 1.
 */
export function orientTranscriptListItems<T>(items: readonly T[], orientation: TranscriptListOrientation): readonly T[] {
    if (orientation === 'standard' || items.length <= 1) {
        return items;
    }
    return [...items].reverse();
}

/**
 * Involutive index map between oldest-first source order and rendered order.
 * standard: identity. inverted: count - 1 - index. Returns null for
 * non-integer, non-finite, or out-of-range [0, count) inputs, and for count <= 0.
 */
export function mapTranscriptListIndexBetweenOrders(
    index: number,
    count: number,
    orientation: TranscriptListOrientation
): number | null {
    if (!isInRangeIndex(index, count)) {
        return null;
    }
    return orientation === 'inverted' ? count - 1 - index : index;
}

/**
 * Rendered index of the CHRONOLOGICALLY previous (older) neighbor of a rendered
 * index. standard: index - 1. inverted: index + 1. Returns null when the
 * neighbor falls outside [0, count) or the input index is outside [0, count) /
 * non-integer.
 */
export function resolveOlderNeighborRenderedIndex(
    index: number,
    count: number,
    orientation: TranscriptListOrientation
): number | null {
    if (!isInRangeIndex(index, count)) {
        return null;
    }
    const neighbor = orientation === 'inverted' ? index + 1 : index - 1;
    return isInRangeIndex(neighbor, count) ? neighbor : null;
}

/**
 * Maps a RAW native scroll offset to canonical transcript offset.
 *
 * Standard: raw list start is the older/history edge.
 * Inverted: raw list start is the newest/live-tail edge, so the observed offset
 * is mirrored into the canonical oldest-first transcript space.
 */
export function toCanonicalScrollOffset(
    params: Readonly<{ offsetY: number; contentHeight: number; layoutHeight: number; orientation: TranscriptListOrientation }>
): number {
    if (params.orientation === 'inverted') {
        const scrollableExtent = Math.max(0, params.contentHeight - params.layoutHeight);
        return scrollableExtent - params.offsetY;
    }
    return params.offsetY;
}

/**
 * Inverse of toCanonicalScrollOffset.
 * Use for converting canonical write targets to raw scroll offsets.
 */
export function fromCanonicalScrollOffset(
    params: Readonly<{ offsetY: number; contentHeight: number; layoutHeight: number; orientation: TranscriptListOrientation }>
): number {
    if (params.orientation === 'inverted') {
        const scrollableExtent = Math.max(0, params.contentHeight - params.layoutHeight);
        return scrollableExtent - params.offsetY;
    }
    return params.offsetY;
}

/**
 * RAW scroll offset that means "pinned at the visual bottom".
 */
export function resolveBottomRawScrollOffset(
    params: Readonly<{ contentHeight: number; layoutHeight: number; orientation: TranscriptListOrientation }>
): number {
    if (params.orientation === 'inverted') {
        return 0;
    }
    return Math.max(0, Math.trunc(params.contentHeight - params.layoutHeight));
}

/**
 * RAW imperative list command target for "go to the visual bottom".
 *
 * This is intentionally separate from observed-offset interpretation. Under
 * native `inverted`, mature chat implementations command the visual bottom via
 * the list start (`scrollToOffset(0)` / `scrollToIndex(0)`), while passive
 * observations may still be reported in physical UIScrollView coordinates.
 */
export function resolveBottomRawScrollCommandOffset(
    params: Readonly<{ contentHeight: number; layoutHeight: number; orientation: TranscriptListOrientation }>
): number {
    if (params.orientation === 'inverted') {
        return 0;
    }
    return resolveBottomRawScrollOffset(params);
}

/**
 * Entry slice-from-anchor window bounds in SOURCE (oldest-first) index terms,
 * for Array.prototype.slice(start, end). standard withholds OLDER rows:
 * { start: anchorSourceIndex, end: count }. inverted withholds NEWER rows:
 * { start: 0, end: anchorSourceIndex + 1 }. Bounds are clamped into [0, count];
 * if anchorSourceIndex is out of [0, count) or count <= 0, returns the full
 * window { start: 0, end: max(0, count) } (fail open: reveal everything).
 */
export function resolveEntrySliceSourceBounds(
    params: Readonly<{ anchorSourceIndex: number; count: number; orientation: TranscriptListOrientation }>
): Readonly<{ start: number; end: number }> {
    const { anchorSourceIndex, count, orientation } = params;
    if (count <= 0 || !isInRangeIndex(anchorSourceIndex, count)) {
        return { start: 0, end: Math.max(0, count) };
    }
    if (orientation === 'inverted') {
        return { start: 0, end: Math.min(count, anchorSourceIndex + 1) };
    }
    return { start: Math.max(0, anchorSourceIndex), end: count };
}

/**
 * Maps the visual-top and visual-bottom edge nodes onto FlashList's
 * ListHeader/ListFooter slots. In an inverted list the header slot renders at
 * the data start = VISUAL BOTTOM, so the slots swap.
 */
export function resolveOrientedListEdgeSlots<T>(
    params: Readonly<{ orientation: TranscriptListOrientation; visualTopNode: T; visualBottomNode: T }>
): Readonly<{ listHeaderNode: T; listFooterNode: T }> {
    if (params.orientation === 'inverted') {
        return { listHeaderNode: params.visualBottomNode, listFooterNode: params.visualTopNode };
    }
    return { listHeaderNode: params.visualTopNode, listFooterNode: params.visualBottomNode };
}
