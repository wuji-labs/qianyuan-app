import { Platform } from 'react-native';

/** Canonical UI shadow steps (1 = lowest). Web uses CSS `box-shadow`; native uses a single-shadow approximation. */
export const SHADOW_LEVELS = [1, 2, 3, 4, 5] as const;
export type ShadowLevel = (typeof SHADOW_LEVELS)[number];

export type ShadowElevationToken = Readonly<{
    boxShadow: string;
    shadowColor: string;
    shadowOffset: Readonly<{ width: number; height: number }>;
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
}>;

export type ShadowLevels = Record<ShadowLevel, ShadowElevationToken>;

export type ShadowLevelStyle =
    | Readonly<{
            boxShadow: string;
        }>
    | Readonly<{
            shadowColor: string;
            shadowOffset: Readonly<{ width: number; height: number }>;
            shadowOpacity: number;
            shadowRadius: number;
            elevation: number;
        }>;

function token(
    boxShadow: string,
    shadowColor: string,
    shadowOffset: Readonly<{ width: number; height: number }>,
    shadowOpacity: number,
    shadowRadius: number,
    elevation: number,
): ShadowElevationToken {
    return {
        boxShadow,
        shadowColor,
        shadowOffset,
        shadowOpacity,
        shadowRadius,
        elevation,
    };
}

/** Light surfaces: level 1 matches product spec (lowest elevation). */
export function buildLightShadowLevels(): ShadowLevels {
    return {
        1: token(
            '0 2px 8px rgba(0, 0, 0, 0.01), 0 1px 3px rgba(0, 0, 0, 0.03)',
            '#000000',
            { width: 0, height: 1 },
            0.06,
            4,
            1,
        ),
        2: token(
            '0 2px 10px rgba(0, 0, 0, 0.04), 0 2px 6px rgba(0, 0, 0, 0.06)',
            '#000000',
            { width: 0, height: 2 },
            0.1,
            5,
            2,
        ),
        3: token(
            '0 4px 18px rgba(0, 0, 0, 0.07), 0 2px 8px rgba(0, 0, 0, 0.09)',
            '#000000',
            { width: 0, height: 3 },
            0.14,
            8,
            4,
        ),
        4: token(
            '0 8px 28px rgba(0, 0, 0, 0.11), 0 4px 14px rgba(0, 0, 0, 0.09)',
            '#000000',
            { width: 0, height: 4 },
            0.18,
            12,
            6,
        ),
        5: token(
            '0 14px 40px rgba(0, 0, 0, 0.16), 0 6px 18px rgba(0, 0, 0, 0.12)',
            '#000000',
            { width: 0, height: 8 },
            0.22,
            16,
            10,
        ),
    };
}

/** Dark surfaces: subtler cast shadows so depth reads without over-lifting dark chrome. */
export function buildDarkShadowLevels(): ShadowLevels {
    return {
        1: token('0 1px 4px rgba(0, 0, 0, 0.02), 0 1px 2px rgba(0, 0, 0, 0.03)', '#000000', { width: 0, height: 1 }, 0.04, 3, 1),
        2: token('0 2px 6px rgba(0, 0, 0, 0.04), 0 2px 4px rgba(0, 0, 0, 0.05)', '#000000', { width: 0, height: 2 }, 0.08, 4, 2),
        3: token('0 3px 10px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.07)', '#000000', { width: 0, height: 3 }, 0.12, 7, 4),
        4: token('0 5px 16px rgba(0, 0, 0, 0.08), 0 3px 8px rgba(0, 0, 0, 0.09)', '#000000', { width: 0, height: 4 }, 0.16, 10, 6),
        5: token('0 8px 22px rgba(0, 0, 0, 0.10), 0 4px 10px rgba(0, 0, 0, 0.12)', '#000000', { width: 0, height: 8 }, 0.20, 14, 10),
    };
}

/** Rotated popover arrow on web: keep a dedicated token (RN-web shadow + transforms are finicky). */
export function buildShadowPopoverArrowBoxShadow(dark: boolean): string {
    return dark
        ? '0 3px 10px rgba(0, 0, 0, 0.42)'
        : '0 4px 14px rgba(0, 0, 0, 0.24)';
}

/**
 * Subtle top inner-shadow for the floating tab bar capsule (iOS-26 / Reddit-style
 * inset depth). Light: a faint dark recess at the top edge; dark: a faint light
 * highlight (a dark inset would be invisible on dark chrome). Cross-platform
 * `inset` box-shadow (supported on RN 0.81 Fabric + web).
 */
export function buildTabBarInnerShadow(dark: boolean): string {
    return dark
        ? 'inset 0px 5px 18px rgba(255, 255, 255, 0.035)'
        : 'inset 0px 6px 20px rgba(0, 0, 0, 0.035)';
}

/**
 * Floating tab bar capsule rim. Light: a bright near-white rim (Reddit-style
 * glass edge); dark: a subtle light translucent rim so the capsule separates
 * from the dark background. Replaces the plain grey `border.strong` outline.
 */
export function buildTabBarBorderColor(dark: boolean): string {
    return dark
        ? 'rgba(255, 255, 255, 0.16)'
        : 'rgba(255, 255, 255, 0.92)';
}

/**
 * View shadow styles for a themed elevation step.
 */
export function shadowLevelStyle(level: ShadowElevationToken): ShadowLevelStyle {
    if (Platform.OS === 'web') {
        return { boxShadow: level.boxShadow };
    }
    return {
        shadowColor: level.shadowColor,
        shadowOffset: level.shadowOffset,
        shadowOpacity: level.shadowOpacity,
        shadowRadius: level.shadowRadius,
        elevation: level.elevation,
    };
}

/** Scale the alpha of every `rgba(...)` in a CSS box-shadow string. */
function scaleBoxShadowOpacity(boxShadow: string, multiplier: number): string {
    if (multiplier === 1) {
        return boxShadow;
    }
    return boxShadow.replace(
        /rgba\((\s*\d+\s*,\s*\d+\s*,\s*\d+\s*),\s*([\d.]+)\)/g,
        (_match, rgb: string, alpha: string) => `rgba(${rgb}, ${Number((Number(alpha) * multiplier).toFixed(3))})`,
    );
}

/**
 * Cast shadow for the floating tab bar capsule.
 *
 * iOS keeps the soft native `shadow*` props. Android + web use the cross-platform
 * `boxShadow` (real Gaussian blur, two-layer) instead of Android `elevation` —
 * elevation renders a hard, over-strong Material drop-shadow that ignores
 * radius/opacity/color, so the bar's shadow read much stronger on Android than the
 * tuned iOS one. `soft` halves the opacity for cockpit chrome sitting on an opaque
 * band (matching the iOS `shadowOpacity * 0.5` softening), on both platforms.
 */
export function buildTabBarCastShadowStyle(level: ShadowElevationToken, soft: boolean): ShadowLevelStyle {
    const opacityMultiplier = soft ? 0.5 : 1;
    if (Platform.OS === 'ios') {
        return {
            shadowColor: level.shadowColor,
            shadowOffset: level.shadowOffset,
            shadowOpacity: level.shadowOpacity * opacityMultiplier,
            shadowRadius: level.shadowRadius,
            elevation: 0,
        };
    }
    return { boxShadow: scaleBoxShadowOpacity(level.boxShadow, opacityMultiplier) };
}
