import type { TranslationKeyNoParams } from '@/text';

export type ThemeProfileMode = 'light' | 'dark';

export type CanonicalBaseThemeId = 'light' | 'dark';

export type ThemeProfilePublicTokenId = string;

export type ThemeProfileColorOverrides = Readonly<Record<ThemeProfilePublicTokenId, string>>;

export type ThemeProfileV1 = Readonly<{
    schemaVersion: 1;
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    base: Readonly<{
        light: 'light';
        dark: 'dark';
    }>;
    overrides: Readonly<{
        light: ThemeProfileColorOverrides;
        dark: ThemeProfileColorOverrides;
    }>;
}>;

export type ThemeProfilesLocalStateV1 = Readonly<{
    activeProfileId: string | null;
    profiles: readonly ThemeProfileV1[];
}>;

export type BuiltInThemeProfilePresetId =
    | 'premiumDark'
    | 'nightDark'
    | 'catppuccinMocha'
    | 'catppuccinMacchiato'
    | 'catppuccinFrappe'
    | 'oneDarkPro'
    | 'monokaiPro'
    | 'githubDark'
    | 'darkModern'
    | 'premiumLight'
    | 'catppuccinLatte'
    | 'githubLight';

export type BuiltInThemeProfileDefinition = Readonly<{
    profile: ThemeProfileV1;
    presetId: BuiltInThemeProfilePresetId;
    translationKey: TranslationKeyNoParams;
    preferredMode: ThemeProfileMode;
    cloneable: true;
    editable: false;
    deletable: false;
}>;
