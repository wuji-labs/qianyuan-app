import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { layout } from '@/components/ui/layout/layout';
import { shadowLevelStyle } from '@/shadowElevation';
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
const PILL_PADDING_VERTICAL = 4;
const PILL_PADDING_HORIZONTAL = 8;

const styles = StyleSheet.create((theme) => ({
    positioner: {
        alignItems: 'center',
        paddingHorizontal: FLOATING_SIDE_GUTTER,
        paddingTop: FLOATING_TOP_GAP,
        backgroundColor: 'transparent',
    },
    // Opaque reserved band for in-flow (cockpit) chrome so the area behind the
    // floating capsule matches the transcript/composer background instead of the
    // window canvas showing through.
    positionerBand: {
        backgroundColor: theme.colors.surface.base,
    },
    shadow: {
        maxWidth: layout.maxWidth,
        borderRadius: TAB_BAR_RADIUS,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    pill: {
        borderRadius: TAB_BAR_RADIUS,
        overflow: 'hidden',
        paddingHorizontal: PILL_PADDING_HORIZONTAL,
        paddingVertical: PILL_PADDING_VERTICAL,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
}));

export type FloatingTabBarSurfaceProps = Readonly<{
    children: React.ReactNode;
    bottomInset: number;
    /** Paint the reserved band behind the capsule (for in-flow cockpit chrome). */
    opaqueBand?: boolean;
    testID?: string;
}>;

export const FloatingTabBarSurface = React.memo(function FloatingTabBarSurface(props: FloatingTabBarSurfaceProps) {
    const bottomPadding = Math.max(props.bottomInset - SAFE_AREA_BOTTOM_TRIM, FLOATING_MIN_BOTTOM_GAP);
    const blurEnabled = useSetting('tabBarBlurEnabled');
    const blurIntensity = BLUR_INTENSITY[useSetting('tabBarBlurIntensity')] ?? BLUR_INTENSITY.regular;

    return (
        <View
            pointerEvents="box-none"
            style={[styles.positioner, props.opaqueBand ? styles.positionerBand : null, { paddingBottom: bottomPadding }]}
        >
            <View style={styles.shadow}>
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
