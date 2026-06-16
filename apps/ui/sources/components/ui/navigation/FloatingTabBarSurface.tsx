import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { layout } from '@/components/ui/layout/layout';
import { buildTabBarCastShadowStyle } from '@/shadowElevation';
import { useSetting } from '@/sync/domains/state/storage';

const BLUR_INTENSITY: Record<'light' | 'regular' | 'strong', number> = {
    light: 25,
    regular: 50,
    strong: 80,
};

/**
 * Floating, rounded iOS-26-style chrome shell for the bottom tab bars.
 *
 * Renders a centered capsule that floats above the safe-area inset with a cast
 * shadow, and fills it with the tiered Liquid Glass / blur / solid material from
 * `GlassSurface`. The material is clipped to the capsule via `overflow: 'hidden'`
 * on the glass layer, while the shadow lives on an un-clipped wrapper so it can
 * render around the pill.
 *
 * Bars pass only their tab row as `children` plus the bottom safe-area inset.
 */
// Tuned to match the iOS 26 Liquid Glass tab bar: a capsule that *sizes to its
// content* and floats centered (deliberate negative space on the sides) rather
// than spanning the full width. `FLOATING_SIDE_GUTTER` is the minimum breathing
// room so a wide bar never touches the screen edges; the bar shrink-wraps its
// tabs and only compresses if it would exceed that bound.
// Large radius → clamps to a full capsule at any bar height (matches the iOS 26 /
// Instagram fully-rounded floating bar).
const TAB_BAR_RADIUS = 999;
const FLOATING_SIDE_GUTTER = 16;
const FLOATING_TOP_GAP = 6;
const FLOATING_MIN_BOTTOM_GAP = 8;
// Sit the bar lower/closer to the home indicator: use most of the safe-area
// inset as the float gap rather than the whole inset, while keeping clearance.
const SAFE_AREA_BOTTOM_TRIM = 12;
// Capsule inner padding. Combined with the active-highlight inset (CockpitTabBar/
// TabBar `activePill`: left/right 4, top/bottom 3) this sets the gap from the
// capsule rim to a selected tab at the edge: H = 2 + 4 = 6, V = 1 + 3 = 4.
const PILL_PADDING_VERTICAL = 1;
const PILL_PADDING_HORIZONTAL = 2;

const styles = StyleSheet.create((theme) => ({
    positioner: {
        alignItems: 'center',
        paddingHorizontal: FLOATING_SIDE_GUTTER,
        paddingTop: FLOATING_TOP_GAP,
        backgroundColor: 'transparent',
    },
    shadow: {
        maxWidth: layout.maxWidth,
        borderRadius: TAB_BAR_RADIUS,
        // Cross-platform soft cast shadow (boxShadow on Android/web, native shadow*
        // on iOS) — never Android `elevation`, which reads hard/over-strong.
        ...buildTabBarCastShadowStyle(theme.colors.shadowLevels[4], false),
    },
    // Cockpit chrome sits on an opaque band (no content showing through), so the
    // full cast shadow reads too strong — keep the same offset/radius but soften it.
    shadowSoft: {
        maxWidth: layout.maxWidth,
        borderRadius: TAB_BAR_RADIUS,
        ...buildTabBarCastShadowStyle(theme.colors.shadowLevels[4], true),
    },
    pill: {
        borderRadius: TAB_BAR_RADIUS,
        overflow: 'hidden',
        paddingHorizontal: PILL_PADDING_HORIZONTAL,
        paddingVertical: PILL_PADDING_VERTICAL,
        // Reddit-style glass rim: bright near-white on light, subtle light rim on
        // dark — reads as a distinct floating surface against either background.
        borderWidth: 1.5,
        borderColor: theme.colors.tabBarBorder,
        // iOS-26 / Reddit-style subtle top inner-shadow for inset depth.
        boxShadow: theme.colors.tabBarInnerShadow,
    },
}));

export type FloatingTabBarSurfaceProps = Readonly<{
    children: React.ReactNode;
    bottomInset: number;
    /**
     * The bar sits on an opaque reserved band (in-flow cockpit chrome). The band
     * itself is painted by the chrome host so it can fade independently; this flag
     * only softens the cast shadow, which reads too strong over the opaque band.
     */
    opaqueBand?: boolean;
    testID?: string;
}>;

export const FloatingTabBarSurface = React.memo(function FloatingTabBarSurface(props: FloatingTabBarSurfaceProps) {
    const bottomPadding = Math.max(props.bottomInset - SAFE_AREA_BOTTOM_TRIM, FLOATING_MIN_BOTTOM_GAP);
    const blurEnabled = useSetting('tabBarBlurEnabled');
    const blurIntensity = BLUR_INTENSITY[useSetting('tabBarBlurIntensity')] ?? BLUR_INTENSITY.regular;
    const onOpaqueBand = props.opaqueBand === true;

    return (
        <View
            pointerEvents="box-none"
            style={[styles.positioner, { paddingBottom: bottomPadding }]}
        >
            <View style={onOpaqueBand ? styles.shadowSoft : styles.shadow}>
                <GlassSurface
                    testID={props.testID}
                    style={styles.pill}
                    enabled={blurEnabled}
                    blurIntensity={blurIntensity}
                >
                    {props.children}
                </GlassSurface>
            </View>
        </View>
    );
});
