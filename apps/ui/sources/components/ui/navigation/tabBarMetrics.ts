/**
 * Resolves bottom tab-bar sizing from the user's `tabBarSize` + `tabBarShowLabels`
 * settings. Shared by every bottom bar (main app + cockpit) so size and the
 * Instagram-style icon-only mode stay consistent.
 *
 * Icon-only mode (no labels) gets slightly more vertical padding so the bar keeps
 * a comfortable, balanced height.
 */
export type TabBarSize = 'compact' | 'regular' | 'large';

export type TabBarMetrics = Readonly<{
    iconSize: number;
    tabPaddingVertical: number;
    tabPaddingHorizontal: number;
    rowGap: number;
    showLabels: boolean;
}>;

const SIZE_PRESETS: Record<TabBarSize, Readonly<{ iconSize: number; padV: number; padH: number; gap: number }>> = {
    compact: { iconSize: 22, padV: 5, padH: 10, gap: 4 },
    regular: { iconSize: 26, padV: 7, padH: 12, gap: 6 },
    large: { iconSize: 30, padV: 9, padH: 14, gap: 8 },
};

export function resolveTabBarMetrics(size: TabBarSize, showLabels: boolean): TabBarMetrics {
    const preset = SIZE_PRESETS[size] ?? SIZE_PRESETS.regular;
    return {
        iconSize: preset.iconSize,
        tabPaddingVertical: showLabels ? preset.padV : preset.padV + 4,
        tabPaddingHorizontal: preset.padH,
        rowGap: preset.gap,
        showLabels,
    };
}
