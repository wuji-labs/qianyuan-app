import { describe, expect, it } from 'vitest';

import { AVATAR_STYLE_IDS } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import {
    AVATAR_STYLE_OPTIONS,
    getNextAvatarStyleId,
    normalizeAvatarStyleId,
} from './avatarStyleOptions';

describe('avatarStyleOptions', () => {
    it('defines one display option for every persisted avatar style id', () => {
        const optionIds = AVATAR_STYLE_OPTIONS.map((option) => option.id);

        expect(new Set(optionIds).size).toBe(optionIds.length);
        expect(optionIds).toEqual([...AVATAR_STYLE_IDS]);
    });

    it('normalizes unknown avatar styles to the legacy gradient fallback', () => {
        expect(normalizeAvatarStyleId('not-a-style')).toBe('gradient');
    });

    it('cycles through mesh gradient after brutalist and wraps to pixelated', () => {
        expect(getNextAvatarStyleId('brutalist')).toBe('meshGradient');
        expect(getNextAvatarStyleId('meshGradient')).toBe('pixelated');
    });
});
