/**
 * Pure decision for which chrome material to render.
 *
 * `liquidGlass` → real iOS 26 Liquid Glass (`expo-glass-effect`).
 * `blur`        → translucent fallback (`expo-blur`) for platforms/builds without Liquid Glass.
 * `solid`       → opaque surface (today's look); also the accessibility-safe fallback.
 *
 * Reduce Transparency disables every translucency effect, so it forces `solid`
 * regardless of Liquid Glass / blur availability.
 */
export type GlassCapability = 'liquidGlass' | 'blur' | 'solid';

export type ResolveGlassCapabilityInput = Readonly<{
    liquidGlassAvailable: boolean;
    blurAvailable: boolean;
    reduceTransparency: boolean;
}>;

export function resolveGlassCapability(input: ResolveGlassCapabilityInput): GlassCapability {
    if (input.reduceTransparency) {
        return 'solid';
    }
    if (input.liquidGlassAvailable) {
        return 'liquidGlass';
    }
    if (input.blurAvailable) {
        return 'blur';
    }
    return 'solid';
}
