import { describe, expect, it } from 'vitest';

import { resolveMainViewTabRoute } from './mainViewTabRouting';

describe('resolveMainViewTabRoute', () => {
    it('routes settings tab presses to the real settings stack root', () => {
        expect(resolveMainViewTabRoute('settings')).toBe('/settings');
    });

    it('keeps non-route tabs inside the main view tab surface', () => {
        expect(resolveMainViewTabRoute('sessions')).toBeNull();
        expect(resolveMainViewTabRoute('inbox')).toBeNull();
        expect(resolveMainViewTabRoute('friends')).toBeNull();
    });
});
