import { describe, expect, it } from 'vitest';

import { shouldRenderDesktopUpdateBannerForRoute } from './shouldRenderDesktopUpdateBannerForRoute';

describe('shouldRenderDesktopUpdateBannerForRoute', () => {
    it('hides global update chrome inside the desktop pet overlay window route', () => {
        expect(shouldRenderDesktopUpdateBannerForRoute('/desktop/pet-overlay')).toBe(false);
        expect(shouldRenderDesktopUpdateBannerForRoute('/desktop/pet-overlay?desktopPetOverlayWindow=1')).toBe(false);
    });

    it('keeps the update banner visible for normal app routes', () => {
        expect(shouldRenderDesktopUpdateBannerForRoute('/settings/pets')).toBe(true);
        expect(shouldRenderDesktopUpdateBannerForRoute(null)).toBe(true);
    });
});
