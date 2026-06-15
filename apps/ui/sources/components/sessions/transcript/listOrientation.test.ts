import { describe, expect, it } from 'vitest';

import {
    fromCanonicalScrollOffset,
    mapTranscriptListIndexBetweenOrders,
    orientTranscriptListItems,
    resolveBottomRawScrollCommandOffset,
    resolveBottomRawScrollOffset,
    resolveEntrySliceSourceBounds,
    resolveOlderNeighborRenderedIndex,
    resolveOrientedListEdgeSlots,
    resolveTranscriptListPresentation,
    toCanonicalScrollOffset,
} from './listOrientation';

describe('resolveTranscriptListPresentation', () => {
    it('maps flatlist_legacy to the legacy standard presentation on both platforms', () => {
        expect(resolveTranscriptListPresentation({ setting: 'flatlist_legacy', platformIsWeb: false })).toEqual({
            implementation: 'flatlist_legacy',
            orientation: 'standard',
        });
        expect(resolveTranscriptListPresentation({ setting: 'flatlist_legacy', platformIsWeb: true })).toEqual({
            implementation: 'flatlist_legacy',
            orientation: 'standard',
        });
    });

    it('maps flash_v2 to standard flash on both platforms', () => {
        expect(resolveTranscriptListPresentation({ setting: 'flash_v2', platformIsWeb: false })).toEqual({
            implementation: 'flash_v2',
            orientation: 'standard',
        });
        expect(resolveTranscriptListPresentation({ setting: 'flash_v2', platformIsWeb: true })).toEqual({
            implementation: 'flash_v2',
            orientation: 'standard',
        });
    });

    it('maps flash_v2_inverted to the inverted pilot on native only', () => {
        expect(resolveTranscriptListPresentation({ setting: 'flash_v2_inverted', platformIsWeb: false })).toEqual({
            implementation: 'flash_v2',
            orientation: 'inverted',
        });
    });

    it('downgrades flash_v2_inverted to standard on web', () => {
        expect(resolveTranscriptListPresentation({ setting: 'flash_v2_inverted', platformIsWeb: true })).toEqual({
            implementation: 'flash_v2',
            orientation: 'standard',
        });
    });

    it('falls back to standard flash_v2 for unknown or invalid setting values', () => {
        const invalidSettings: unknown[] = [
            'something_else',
            '',
            'FLATLIST_LEGACY',
            null,
            undefined,
            42,
            0,
            true,
            false,
            {},
            [],
            { setting: 'flatlist_legacy' },
        ];
        for (const setting of invalidSettings) {
            for (const platformIsWeb of [false, true]) {
                expect(resolveTranscriptListPresentation({ setting, platformIsWeb })).toEqual({
                    implementation: 'flash_v2',
                    orientation: 'standard',
                });
            }
        }
    });
});

describe('orientTranscriptListItems', () => {
    it('returns the same array reference in standard orientation', () => {
        const items = ['a', 'b', 'c'];
        expect(orientTranscriptListItems(items, 'standard')).toBe(items);
        const empty: string[] = [];
        expect(orientTranscriptListItems(empty, 'standard')).toBe(empty);
    });

    it('returns a newest-first reversed copy in inverted orientation without mutating the input', () => {
        const items = ['oldest', 'middle', 'newest'];
        const result = orientTranscriptListItems(items, 'inverted');
        expect(result).toEqual(['newest', 'middle', 'oldest']);
        expect(result).not.toBe(items);
        expect(items).toEqual(['oldest', 'middle', 'newest']);
    });

    it('handles empty and single-item lists in inverted orientation', () => {
        const empty: string[] = [];
        expect(orientTranscriptListItems(empty, 'inverted')).toEqual([]);
        const single = ['only'];
        expect(orientTranscriptListItems(single, 'inverted')).toEqual(['only']);
    });
});

describe('mapTranscriptListIndexBetweenOrders', () => {
    it('is the identity in standard orientation for in-range indices', () => {
        expect(mapTranscriptListIndexBetweenOrders(0, 5, 'standard')).toBe(0);
        expect(mapTranscriptListIndexBetweenOrders(2, 5, 'standard')).toBe(2);
        expect(mapTranscriptListIndexBetweenOrders(4, 5, 'standard')).toBe(4);
        expect(mapTranscriptListIndexBetweenOrders(0, 1, 'standard')).toBe(0);
    });

    it('mirrors the index in inverted orientation', () => {
        expect(mapTranscriptListIndexBetweenOrders(0, 5, 'inverted')).toBe(4);
        expect(mapTranscriptListIndexBetweenOrders(4, 5, 'inverted')).toBe(0);
        expect(mapTranscriptListIndexBetweenOrders(2, 5, 'inverted')).toBe(2);
        expect(mapTranscriptListIndexBetweenOrders(0, 1, 'inverted')).toBe(0);
    });

    it('is involutive for all in-range indices in both orientations', () => {
        const count = 7;
        for (const orientation of ['standard', 'inverted'] as const) {
            for (let index = 0; index < count; index += 1) {
                const mapped = mapTranscriptListIndexBetweenOrders(index, count, orientation);
                expect(mapped).not.toBeNull();
                expect(mapTranscriptListIndexBetweenOrders(mapped as number, count, orientation)).toBe(index);
            }
        }
    });

    it('returns null for out-of-range indices in both orientations', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(-1, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(5, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(100, 5, orientation)).toBeNull();
        }
    });

    it('returns null for non-integer and non-finite indices', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(1.5, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.NaN, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.POSITIVE_INFINITY, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.NEGATIVE_INFINITY, 5, orientation)).toBeNull();
        }
    });

    it('returns null for empty and non-positive counts', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(0, 0, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(0, -3, orientation)).toBeNull();
        }
    });
});

describe('resolveOlderNeighborRenderedIndex', () => {
    it('returns index - 1 in standard orientation (older rows render above)', () => {
        expect(resolveOlderNeighborRenderedIndex(3, 5, 'standard')).toBe(2);
        expect(resolveOlderNeighborRenderedIndex(1, 5, 'standard')).toBe(0);
        expect(resolveOlderNeighborRenderedIndex(4, 5, 'standard')).toBe(3);
    });

    it('returns index + 1 in inverted orientation (older rows render below)', () => {
        expect(resolveOlderNeighborRenderedIndex(0, 5, 'inverted')).toBe(1);
        expect(resolveOlderNeighborRenderedIndex(3, 5, 'inverted')).toBe(4);
    });

    it('returns null when the older neighbor falls outside the list', () => {
        expect(resolveOlderNeighborRenderedIndex(0, 5, 'standard')).toBeNull();
        expect(resolveOlderNeighborRenderedIndex(4, 5, 'inverted')).toBeNull();
        expect(resolveOlderNeighborRenderedIndex(0, 1, 'standard')).toBeNull();
        expect(resolveOlderNeighborRenderedIndex(0, 1, 'inverted')).toBeNull();
    });

    it('returns null when the input index is outside the list or non-integer', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveOlderNeighborRenderedIndex(-1, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(5, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(2.5, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(Number.NaN, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(Number.POSITIVE_INFINITY, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(0, 0, orientation)).toBeNull();
        }
    });
});

describe('toCanonicalScrollOffset', () => {
    it('passes raw offsets through unchanged in standard orientation, including bounce and floats', () => {
        expect(toCanonicalScrollOffset({ offsetY: 0, contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(0);
        expect(toCanonicalScrollOffset({ offsetY: 123.45, contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(123.45);
        expect(toCanonicalScrollOffset({ offsetY: -37.5, contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(-37.5);
        expect(toCanonicalScrollOffset({ offsetY: 600, contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(600);
    });

    it('mirrors native FlashList inverted offsets into canonical oldest-first space', () => {
        // Inverted visual bottom is raw list start. Canonical transcript space remains
        // oldest-first, so raw 0 maps to the newest/bottom end and raw max maps to top.
        expect(toCanonicalScrollOffset({ offsetY: 0, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(600);
        expect(toCanonicalScrollOffset({ offsetY: 600, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(toCanonicalScrollOffset({ offsetY: 200, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(400);
    });

    it('mirrors inverted bounce without clamping so validity checks can still inspect raw offsets', () => {
        expect(toCanonicalScrollOffset({ offsetY: -25, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(625);
        expect(toCanonicalScrollOffset({ offsetY: 650, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(-50);
    });

    it('handles under-filled geometry (contentHeight < layoutHeight) without clamping', () => {
        expect(toCanonicalScrollOffset({ offsetY: 0, contentHeight: 200, layoutHeight: 400, orientation: 'standard' })).toBe(0);
        expect(toCanonicalScrollOffset({ offsetY: 0, contentHeight: 200, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(toCanonicalScrollOffset({ offsetY: -200, contentHeight: 200, layoutHeight: 400, orientation: 'inverted' })).toBe(200);
    });

    it('preserves float precision in inverted orientation', () => {
        expect(toCanonicalScrollOffset({ offsetY: 123.25, contentHeight: 1000.5, layoutHeight: 400.25, orientation: 'inverted' })).toBe(477);
    });
});

describe('fromCanonicalScrollOffset', () => {
    it('is the identity in standard orientation', () => {
        expect(fromCanonicalScrollOffset({ offsetY: 250.5, contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(250.5);
        expect(fromCanonicalScrollOffset({ offsetY: -10, contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(-10);
    });

    it('mirrors canonical write targets for native inverted orientation', () => {
        expect(fromCanonicalScrollOffset({ offsetY: 600, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(fromCanonicalScrollOffset({ offsetY: 0, contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(600);
    });

    it('round-trips with toCanonicalScrollOffset in both orientations, including floats and bounce values', () => {
        const geometries = [
            { contentHeight: 1000, layoutHeight: 400 },
            { contentHeight: 1000.5, layoutHeight: 399.25 },
            { contentHeight: 200, layoutHeight: 400 }, // under-filled
            { contentHeight: 0, layoutHeight: 0 },
        ];
        const offsets = [0, 1, 600, 599.5, 123.0625, -37.5, -0.25, 612.75];
        for (const orientation of ['standard', 'inverted'] as const) {
            for (const { contentHeight, layoutHeight } of geometries) {
                for (const offsetY of offsets) {
                    const canonical = toCanonicalScrollOffset({ offsetY, contentHeight, layoutHeight, orientation });
                    expect(fromCanonicalScrollOffset({ offsetY: canonical, contentHeight, layoutHeight, orientation })).toBe(offsetY);
                    const raw = fromCanonicalScrollOffset({ offsetY, contentHeight, layoutHeight, orientation });
                    expect(toCanonicalScrollOffset({ offsetY: raw, contentHeight, layoutHeight, orientation })).toBe(offsetY);
                }
            }
        }
    });
});

describe('resolveBottomRawScrollOffset', () => {
    it('returns the scrollable extent truncated toward zero in standard orientation', () => {
        expect(resolveBottomRawScrollOffset({ contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(600);
        expect(resolveBottomRawScrollOffset({ contentHeight: 1000.9, layoutHeight: 400, orientation: 'standard' })).toBe(600);
    });

    it('clamps to zero for under-filled geometry in standard orientation', () => {
        expect(resolveBottomRawScrollOffset({ contentHeight: 200, layoutHeight: 400, orientation: 'standard' })).toBe(0);
        expect(resolveBottomRawScrollOffset({ contentHeight: 0, layoutHeight: 0, orientation: 'standard' })).toBe(0);
    });

    it('returns the raw list-start offset in inverted orientation', () => {
        expect(resolveBottomRawScrollOffset({ contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(resolveBottomRawScrollOffset({ contentHeight: 200, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(resolveBottomRawScrollOffset({ contentHeight: 0, layoutHeight: 0, orientation: 'inverted' })).toBe(0);
    });
});

describe('resolveBottomRawScrollCommandOffset', () => {
    it('targets the physical content end in standard orientation', () => {
        expect(resolveBottomRawScrollCommandOffset({ contentHeight: 1000, layoutHeight: 400, orientation: 'standard' })).toBe(600);
        expect(resolveBottomRawScrollCommandOffset({ contentHeight: 1000.9, layoutHeight: 400, orientation: 'standard' })).toBe(600);
    });

    it('targets the list start for user-facing inverted bottom commands', () => {
        expect(resolveBottomRawScrollCommandOffset({ contentHeight: 1000, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(resolveBottomRawScrollCommandOffset({ contentHeight: 200, layoutHeight: 400, orientation: 'inverted' })).toBe(0);
        expect(resolveBottomRawScrollCommandOffset({ contentHeight: 0, layoutHeight: 0, orientation: 'inverted' })).toBe(0);
    });
});

describe('resolveEntrySliceSourceBounds', () => {
    it('withholds older rows in standard orientation', () => {
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 3, count: 10, orientation: 'standard' })).toEqual({ start: 3, end: 10 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 10, orientation: 'standard' })).toEqual({ start: 0, end: 10 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 9, count: 10, orientation: 'standard' })).toEqual({ start: 9, end: 10 });
    });

    it('withholds newer rows in inverted orientation', () => {
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 3, count: 10, orientation: 'inverted' })).toEqual({ start: 0, end: 4 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 10, orientation: 'inverted' })).toEqual({ start: 0, end: 1 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 9, count: 10, orientation: 'inverted' })).toEqual({ start: 0, end: 10 });
    });

    it('handles a single-item list', () => {
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 1, orientation: 'standard' })).toEqual({ start: 0, end: 1 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 1, orientation: 'inverted' })).toEqual({ start: 0, end: 1 });
    });

    it('fails open to the full window for out-of-range anchors', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: -1, count: 10, orientation })).toEqual({ start: 0, end: 10 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 10, count: 10, orientation })).toEqual({ start: 0, end: 10 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 2.5, count: 10, orientation })).toEqual({ start: 0, end: 10 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: Number.NaN, count: 10, orientation })).toEqual({ start: 0, end: 10 });
        }
    });

    it('fails open to an empty full window for non-positive counts', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 0, orientation })).toEqual({ start: 0, end: 0 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: -5, orientation })).toEqual({ start: 0, end: 0 });
        }
    });

    it('produces bounds usable directly with Array.prototype.slice', () => {
        const items = ['m0', 'm1', 'm2', 'm3', 'm4'];
        const standard = resolveEntrySliceSourceBounds({ anchorSourceIndex: 2, count: items.length, orientation: 'standard' });
        expect(items.slice(standard.start, standard.end)).toEqual(['m2', 'm3', 'm4']);
        const inverted = resolveEntrySliceSourceBounds({ anchorSourceIndex: 2, count: items.length, orientation: 'inverted' });
        expect(items.slice(inverted.start, inverted.end)).toEqual(['m0', 'm1', 'm2']);
    });
});

describe('resolveOrientedListEdgeSlots', () => {
    it('keeps slots in place in standard orientation', () => {
        const visualTopNode = { id: 'top' };
        const visualBottomNode = { id: 'bottom' };
        const slots = resolveOrientedListEdgeSlots({ orientation: 'standard', visualTopNode, visualBottomNode });
        expect(slots.listHeaderNode).toBe(visualTopNode);
        expect(slots.listFooterNode).toBe(visualBottomNode);
    });

    it('swaps slots in inverted orientation (header slot renders at the visual bottom)', () => {
        const visualTopNode = { id: 'top' };
        const visualBottomNode = { id: 'bottom' };
        const slots = resolveOrientedListEdgeSlots({ orientation: 'inverted', visualTopNode, visualBottomNode });
        expect(slots.listHeaderNode).toBe(visualBottomNode);
        expect(slots.listFooterNode).toBe(visualTopNode);
    });
});
