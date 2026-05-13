import { describe, expect, it } from 'vitest';

import { resolveThemeProfile } from './resolveThemeProfile';
import { createThemeProfileDraft, resetThemeProfileDraftToken } from './createThemeProfileDraft';
import { BUILT_IN_THEME_PROFILES, getBuiltInThemeProfileDefinition } from './builtInThemeProfiles';

const premiumDarkSeed = {
    'background.canvas': '#050506',
    'surface.base': '#141417',
    'surface.inset': '#0D0D10',
    'surface.elevated': '#1B1B20',
    'surface.selected': '#26262D',
    'surface.pressed': '#2D2D35',
    'border.surface': 'rgba(255,255,255,0.075)',
    'border.strong': 'rgba(255,255,255,0.13)',
    'effect.surfaceHighlight': 'rgba(255,255,255,0.055)',
    'text.primary': '#ECECEF',
    'text.secondary': '#9A9AA3',
    'text.tertiary': '#6F6F78',
    'state.active.background': 'rgba(78,116,190,0.18)',
    'state.active.border': 'rgba(100,145,230,0.45)',
    'state.active.foreground': '#DDE8FF',
    'state.success.foreground': '#70D98A',
    'state.warning.foreground': '#E6B84A',
    'state.danger.foreground': '#E87878',
    'state.info.foreground': '#82A8FF',
    'control.input.background': '#17171C',
    'control.button.primary.background': '#24242B',
    'control.button.primary.foreground': '#ECECEF',
    'control.fab.background': '#24242B',
    'control.fab.foreground': '#ECECEF',
    'syntax.keyword': '#82A8FF',
};

const premiumLightSeed = {
    'background.canvas': '#F6F6F4',
    'surface.base': '#FFFFFF',
    'surface.inset': '#F2F2F0',
    'surface.elevated': '#FCFCFC',
    'border.surface': 'rgba(0,0,0,0.08)',
    'border.strong': 'rgba(0,0,0,0.14)',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#111114',
    'text.secondary': '#5A5A5F',
    'text.tertiary': '#7A7A80',
    'state.active.background': 'rgba(10,132,255,0.08)',
    'state.active.border': 'rgba(10,132,255,0.40)',
    'state.active.foreground': '#111114',
    'state.success.foreground': '#248A3D',
    'state.warning.foreground': '#B26A00',
    'state.danger.foreground': '#D70015',
    'state.info.foreground': '#0A84FF',
};

const nightDarkSeed = {
    'background.canvas': '#020204',
    'surface.base': '#090A0E',
    'surface.inset': '#050609',
    'surface.elevated': '#101116',
    'surface.selected': '#141620',
    'surface.pressed': '#191C28',
    'border.surface': 'rgba(255,255,255,0.055)',
    'border.strong': 'rgba(255,255,255,0.095)',
    'effect.surfaceHighlight': 'rgba(255,255,255,0.028)',
    'text.primary': '#E4E3E8',
    'text.secondary': '#898892',
    'text.tertiary': '#5D5C66',
    'state.active.background': 'rgba(225,151,63,0.10)',
    'state.active.border': 'rgba(225,177,90,0.26)',
    'state.active.foreground': '#E8C46F',
    'control.input.background': '#0D0E14',
    'control.button.primary.background': '#141620',
    'control.fab.background': '#141620',
    'overlay.scrim': 'rgba(0,0,0,0.72)',
};

describe('built-in theme profiles', () => {
    it('exposes curated themes as read-only cloneable presets with locked seed palettes', () => {
        expect(BUILT_IN_THEME_PROFILES.map((definition) => definition.presetId)).toEqual([
            'premiumDark',
            'nightDark',
            'catppuccinMocha',
            'catppuccinMacchiato',
            'catppuccinFrappe',
            'oneDarkPro',
            'monokaiPro',
            'githubDark',
            'darkModern',
            'premiumLight',
            'catppuccinLatte',
            'githubLight',
        ]);
        expect(getBuiltInThemeProfileDefinition('premiumDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('premiumLight')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'light' });
        expect(getBuiltInThemeProfileDefinition('nightDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('catppuccinLatte')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'light' });
        expect(getBuiltInThemeProfileDefinition('catppuccinFrappe')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('catppuccinMacchiato')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('catppuccinMocha')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('oneDarkPro')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('monokaiPro')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('githubDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('githubLight')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'light' });
        expect(getBuiltInThemeProfileDefinition('darkModern')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('premiumDark')?.profile.overrides.dark).toMatchObject(premiumDarkSeed);
        expect(Object.keys(getBuiltInThemeProfileDefinition('premiumDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(80);
        expect(getBuiltInThemeProfileDefinition('premiumLight')?.profile.overrides.light).toEqual(premiumLightSeed);
        expect(getBuiltInThemeProfileDefinition('nightDark')?.profile.overrides.dark).toMatchObject(nightDarkSeed);
        expect(Object.keys(getBuiltInThemeProfileDefinition('nightDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(80);
        expect(getBuiltInThemeProfileDefinition('catppuccinMocha')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#11111B',
            'surface.base': '#1E1E2E',
            'text.primary': '#CDD6F4',
            'text.secondary': '#BAC2DE',
            'state.active.foreground': '#89B4FA',
            'syntax.keyword': '#CBA6F7',
        });
        expect(getBuiltInThemeProfileDefinition('catppuccinLatte')?.profile.overrides.light).toMatchObject({
            'background.canvas': '#EFF1F5',
            'surface.base': '#FFFFFF',
            'text.primary': '#4C4F69',
            'text.secondary': '#5C5F77',
            'state.active.foreground': '#1E66F5',
            'syntax.keyword': '#8839EF',
        });
        expect(getBuiltInThemeProfileDefinition('oneDarkPro')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#21252B',
            'surface.base': '#282C34',
            'text.primary': '#ABB2BF',
            'state.active.foreground': '#61AFEF',
            'syntax.keyword': '#C678DD',
        });
        expect(getBuiltInThemeProfileDefinition('monokaiPro')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#221F22',
            'surface.base': '#2D2A2E',
            'text.primary': '#FCFCFA',
            'state.active.foreground': '#FFD866',
            'syntax.keyword': '#FF6188',
        });
        expect(getBuiltInThemeProfileDefinition('githubDark')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#0D1117',
            'surface.base': '#161B22',
            'text.primary': '#E6EDF3',
            'state.active.foreground': '#2F81F7',
            'syntax.keyword': '#FF7B72',
        });
        expect(getBuiltInThemeProfileDefinition('githubLight')?.profile.overrides.light).toMatchObject({
            'background.canvas': '#FFFFFF',
            'surface.base': '#F6F8FA',
            'text.primary': '#1F2328',
            'state.active.foreground': '#0969DA',
            'syntax.keyword': '#CF222E',
        });
        expect(getBuiltInThemeProfileDefinition('darkModern')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#181818',
            'surface.base': '#1F1F1F',
            'text.primary': '#CCCCCC',
            'state.active.foreground': '#0078D4',
            'syntax.keyword': '#569CD6',
        });
    });

    it('clones a built-in profile into an editable flat custom profile', () => {
        const builtIn = getBuiltInThemeProfileDefinition('premiumDark')?.profile;
        if (!builtIn) throw new Error('missing premium dark');

        const clone = createThemeProfileDraft({ id: 'clone', name: 'My Crisp Dark', now: '2026-05-11T00:00:00.000Z', sourceProfile: builtIn });

        expect(clone.id).toBe('clone');
        expect(clone.overrides).toEqual(builtIn.overrides);
        expect(clone.overrides).not.toBe(builtIn.overrides);
    });

    it('resolves internal feed card surfaces from each built-in preset palette', () => {
        for (const definition of BUILT_IN_THEME_PROFILES) {
            const effective = resolveThemeProfile({
                mode: definition.preferredMode,
                profile: definition.profile,
            });

            expect(effective.colors.feed.card.background).toBe(effective.colors.surface.elevated);
        }
    });

    it('resets a token in a built-in clone back to canonical base, not the preset value', () => {
        const builtIn = getBuiltInThemeProfileDefinition('premiumDark')?.profile;
        if (!builtIn) throw new Error('missing premium dark');
        const clone = createThemeProfileDraft({ id: 'clone', name: 'My Crisp Dark', now: '2026-05-11T00:00:00.000Z', sourceProfile: builtIn });
        const reset = resetThemeProfileDraftToken(clone, 'dark', 'background.canvas', '2026-05-11T00:01:00.000Z');

        expect(resolveThemeProfile({ mode: 'dark', profile: reset }).colors.background.canvas).toBe('#181818');
    });
});
