import { describe, expect, it } from 'vitest';

import { resolveTabBarMetrics } from './tabBarMetrics';

describe('resolveTabBarMetrics', () => {
    it('scales the icon with size', () => {
        expect(resolveTabBarMetrics('compact', true).iconSize).toBe(22);
        expect(resolveTabBarMetrics('regular', true).iconSize).toBe(26);
        expect(resolveTabBarMetrics('large', true).iconSize).toBe(30);
    });

    it('adds vertical padding in icon-only mode for a balanced height', () => {
        expect(resolveTabBarMetrics('regular', false).tabPaddingVertical)
            .toBeGreaterThan(resolveTabBarMetrics('regular', true).tabPaddingVertical);
    });

    it('passes showLabels through', () => {
        expect(resolveTabBarMetrics('regular', true).showLabels).toBe(true);
        expect(resolveTabBarMetrics('regular', false).showLabels).toBe(false);
    });

    it('falls back to regular for an unknown size', () => {
        expect(resolveTabBarMetrics('huge' as never, true).iconSize).toBe(26);
    });
});
