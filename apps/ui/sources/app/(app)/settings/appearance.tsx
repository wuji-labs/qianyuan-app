import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Appearance, Platform, View } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ThemeSelectionDropdown } from '@/components/settings/appearance/themeProfiles/ThemeSelectionDropdown';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import {
    AVATAR_STYLE_OPTIONS,
    isAvatarStyleId,
    normalizeAvatarStyleId,
} from '@/components/ui/avatar/avatarStyleOptions';
import { getGeneratedAvatarComponentForStyle } from '@/components/ui/avatar/avatarComponentRegistry';
import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { resolveStatusBarStyleForThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { runThemePreferenceChange } from '@/components/settings/appearance/themePreferenceTransition';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE, findThemeProfileById } from '@/theme/profiles/themeProfilePersistence';
import { getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

const UI_FONT_SCALE_PRESETS = {
    xxsmall: 0.8,
    xsmall: 0.85,
    small: 0.93,
    default: 1,
    large: 1.1,
    xlarge: 1.2,
    xxlarge: 1.3,
} as const;

type UiFontScalePresetId = keyof typeof UI_FONT_SCALE_PRESETS;
type UiItemDensity = LocalSettings['uiItemDensity'];
type DetailsPaneTabsBehavior = LocalSettings['detailsPaneTabsBehavior'];

const isUiFontScalePresetId = (value: string): value is UiFontScalePresetId => (
    Object.prototype.hasOwnProperty.call(UI_FONT_SCALE_PRESETS, value)
);

const isUiItemDensity = (value: string): value is UiItemDensity => (
    value === 'comfortable' || value === 'cozy' || value === 'compact'
);

const isDetailsPaneTabsBehavior = (value: string): value is DetailsPaneTabsBehavior => (
    value === 'preview' || value === 'persistent'
);

function AvatarStylePreviewIcon(props: Readonly<{ styleId: AvatarStyleId }>) {
    const AvatarStyleComponent = getGeneratedAvatarComponentForStyle(props.styleId);

    return (
        <View style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}>
            <AvatarStyleComponent
                id={`settings-avatar-style-preview-${props.styleId}`}
                styleId={props.styleId}
                size={28}
            />
        </View>
    );
}

export default React.memo(function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const deviceType = useDeviceType();
    const reduceMotion = useReducedMotionPreference();
    const panelsSupported = Platform.OS === 'web' || deviceType === 'tablet';
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles, setThemeProfiles] = useLocalSettingMutable('themeProfiles');
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [uiItemDensity, setUiItemDensity] = useLocalSettingMutable('uiItemDensity');
    const [uiContentWidthMode, setUiContentWidthMode] = useLocalSettingMutable('uiContentWidthMode');
    const [uiMultiPanePanelsEnabled, setUiMultiPanePanelsEnabled] = useLocalSettingMutable('uiMultiPanePanelsEnabled');
    const [uiBackdropBlurEnabled, setUiBackdropBlurEnabled] = useLocalSettingMutable('uiBackdropBlurEnabled');
    const [detailsPaneTabsBehavior, setDetailsPaneTabsBehavior] = useLocalSettingMutable('detailsPaneTabsBehavior');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [openTextSizeMenu, setOpenTextSizeMenu] = React.useState(false);
    const [openThemeMenu, setOpenThemeMenu] = React.useState(false);
    const [openItemDensityMenu, setOpenItemDensityMenu] = React.useState(false);
    const [openContentWidthMenu, setOpenContentWidthMenu] = React.useState(false);
    const [openDetailsTabsMenu, setOpenDetailsTabsMenu] = React.useState(false);
    const [openAvatarStyleMenu, setOpenAvatarStyleMenu] = React.useState(false);
    const safeThemeProfiles = themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE;
    const activeThemeProfile = React.useMemo(
        () => findThemeProfileById(safeThemeProfiles, safeThemeProfiles.activeProfileId),
        [safeThemeProfiles],
    );
    const textSizeMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        return [
            { id: 'xxsmall', title: t('settingsAppearance.textSizeOptions.xxsmall') },
            { id: 'xsmall', title: t('settingsAppearance.textSizeOptions.xsmall') },
            { id: 'small', title: t('settingsAppearance.textSizeOptions.small') },
            { id: 'default', title: t('settingsAppearance.textSizeOptions.default') },
            { id: 'large', title: t('settingsAppearance.textSizeOptions.large') },
            { id: 'xlarge', title: t('settingsAppearance.textSizeOptions.xlarge') },
            { id: 'xxlarge', title: t('settingsAppearance.textSizeOptions.xxlarge') },
        ];
    }, []);

    const detailsTabsMenuItems = React.useMemo(() => {
        return [
            { id: 'preview', title: t('settingsAppearance.detailsPaneTabsBehaviorOptions.preview') },
            { id: 'persistent', title: t('settingsAppearance.detailsPaneTabsBehaviorOptions.persistent') },
        ];
    }, []);

    const avatarStyleMenuItems = React.useMemo(() => {
        return AVATAR_STYLE_OPTIONS.map((option) => ({
            id: option.id,
            title: t(option.labelKey),
            icon: <AvatarStylePreviewIcon styleId={option.id} />,
        }));
    }, []);

    const itemDensityMenuItems = React.useMemo(() => {
        return [
            {
                id: 'comfortable',
                title: t('settingsAppearance.itemDensityOptions.comfortable'),
                subtitle: t('settingsAppearance.itemDensityOptions.comfortableDescription'),
            },
            {
                id: 'cozy',
                title: t('settingsAppearance.itemDensityOptions.cozy'),
                subtitle: t('settingsAppearance.itemDensityOptions.cozyDescription'),
            },
            {
                id: 'compact',
                title: t('settingsAppearance.itemDensityOptions.compact'),
                subtitle: t('settingsAppearance.itemDensityOptions.compactDescription'),
            },
        ];
    }, []);

    const contentWidthMenuItems = React.useMemo(() => {
        return [
            {
                id: 'compact',
                title: t('settingsAppearance.contentWidthOptions.compact'),
                subtitle: t('settingsAppearance.contentWidthOptions.compactDescription'),
            },
            {
                id: 'medium',
                title: t('settingsAppearance.contentWidthOptions.medium'),
                subtitle: t('settingsAppearance.contentWidthOptions.mediumDescription'),
            },
            {
                id: 'full',
                title: t('settingsAppearance.contentWidthOptions.full'),
                subtitle: t('settingsAppearance.contentWidthOptions.fullDescription'),
            },
        ];
    }, []);

    const selectedTextSizeId = React.useMemo(() => {
        const entries = Object.entries(UI_FONT_SCALE_PRESETS) as Array<[UiFontScalePresetId, number]>;
        let best: UiFontScalePresetId = 'default';
        let bestDist = Number.POSITIVE_INFINITY;
        for (const [id, scale] of entries) {
            const dist = Math.abs((uiFontScale ?? 1) - scale);
            if (dist < bestDist) {
                bestDist = dist;
                best = id;
            }
        }
        return best;
    }, [uiFontScale]);

    const selectUiFontSize = React.useCallback((itemId: string) => {
        if (!isUiFontScalePresetId(itemId)) return;
        setUiFontScale(UI_FONT_SCALE_PRESETS[itemId]);
    }, [setUiFontScale]);

    const applyThemeSelection = React.useCallback((nextThemePreference: 'adaptive' | 'light' | 'dark', nextThemeProfiles: ThemeProfilesLocalStateV1) => {
        const systemTheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        void runThemePreferenceChange({
            currentPreference: themePreference,
            nextPreference: nextThemePreference,
            platform: Platform.OS,
            reduceMotion,
            systemTheme,
            mutation: () => {
                setThemePreference(nextThemePreference);
                setThemeProfiles(nextThemeProfiles);
                applyThemeRuntimeSelection({
                    themePreference: nextThemePreference,
                    themeProfiles: nextThemeProfiles,
                    systemTheme,
                });
                setStatusBarStyle(resolveStatusBarStyleForThemePreference(nextThemePreference, systemTheme), true);
            },
        });
    }, [reduceMotion, setThemePreference, setThemeProfiles, themePreference]);

    const selectBaseTheme = React.useCallback((nextThemePreference: 'adaptive' | 'light' | 'dark') => {
        applyThemeSelection(nextThemePreference, { ...safeThemeProfiles, activeProfileId: null });
    }, [applyThemeSelection, safeThemeProfiles]);

    const selectThemeProfile = React.useCallback((profileId: string) => {
        const builtInDefinition = isBuiltInThemeProfilePresetId(profileId) ? getBuiltInThemeProfileDefinition(profileId) : undefined;
        const nextThemePreference = isBuiltInThemeProfilePresetId(profileId)
            ? builtInDefinition?.preferredMode ?? 'light'
            : themePreference;
        applyThemeSelection(nextThemePreference, { ...safeThemeProfiles, activeProfileId: profileId });
    }, [applyThemeSelection, safeThemeProfiles, themePreference]);

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle = normalizeAvatarStyleId(avatarStyle);
    
    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ? 
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) : 
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <ThemeSelectionDropdown
                    open={openThemeMenu}
                    onOpenChange={setOpenThemeMenu}
                    themePreference={themePreference}
                    themeProfiles={safeThemeProfiles}
                    onSelectBaseTheme={selectBaseTheme}
                    onSelectProfile={selectThemeProfile}
                />
                <Item
                    testID="settings-appearance-themeProfiles"
                    title={t('settingsAppearance.themeProfiles.title')}
                    subtitle={activeThemeProfile?.name ?? t('settingsAppearance.themeProfiles.defaultThemeSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.accent.indigo} />}
                    detail={activeThemeProfile ? t('settingsAppearance.themeProfiles.active') : t('settingsAppearance.themeProfiles.defaultTheme')}
                    onPress={() => router.push('/settings/appearance/themes')}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color={theme.colors.accent.blue} />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* Text Settings */}
            <ItemGroup title={t('settingsAppearance.text')} footer={t('settingsAppearance.textDescription')}>
                <DropdownMenu
                    open={openTextSizeMenu}
                    onOpenChange={setOpenTextSizeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={selectedTextSizeId}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.textSize'),
                        subtitle: t('settingsAppearance.textSizeDescription'),
                        icon: <Ionicons name="text-outline" size={29} color={theme.colors.accent.orange} />,
                        showSelectedSubtitle: false,
                    }}
                    items={textSizeMenuItems}
                    onSelect={selectUiFontSize}
                />
                <DropdownMenu
                    open={openItemDensityMenu}
                    onOpenChange={setOpenItemDensityMenu}
                    variant="selectable"
                    search={false}
                    selectedId={uiItemDensity}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.itemDensity'),
                        subtitle: t('settingsAppearance.itemDensityDescription'),
                        icon: <Ionicons name="list-outline" size={29} color={theme.colors.accent.orange} />,
                        showSelectedSubtitle: false,
                    }}
                    items={itemDensityMenuItems}
                    onSelect={(itemId) => {
                        if (!isUiItemDensity(itemId)) return;
                        setUiItemDensity(itemId);
                    }}
                />
            </ItemGroup>

            {/* Layout */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <DropdownMenu
                    open={openContentWidthMenu}
                    onOpenChange={setOpenContentWidthMenu}
                    variant="selectable"
                    search={false}
                    selectedId={uiContentWidthMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.contentWidth'),
                        subtitle: t('settingsAppearance.contentWidthDescription'),
                        icon: <Ionicons name="resize-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                    }}
                    items={contentWidthMenuItems}
                    onSelect={(itemId) => {
                        if (itemId !== 'compact' && itemId !== 'medium' && itemId !== 'full') return;
                        setUiContentWidthMode(itemId);
                    }}
                />
                <Item
                    title={t('settingsAppearance.multiPanePanels')}
                    subtitle={t('settingsAppearance.multiPanePanelsDescription')}
                    icon={<Ionicons name="browsers-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={uiMultiPanePanelsEnabled}
                            onValueChange={setUiMultiPanePanelsEnabled}
                            disabled={!panelsSupported}
                        />
                    }
                    disabled={!panelsSupported}
                    showChevron={false}
                />
                <Item
                    title={t('settingsAppearance.backdropBlur')}
                    subtitle={t('settingsAppearance.backdropBlurDescription')}
                    icon={<Ionicons name="layers-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={uiBackdropBlurEnabled !== false}
                            onValueChange={setUiBackdropBlurEnabled}
                        />
                    }
                    showChevron={false}
                />
                <DropdownMenu
                    open={openDetailsTabsMenu}
                    onOpenChange={setOpenDetailsTabsMenu}
                    variant="selectable"
                    search={false}
                    selectedId={detailsPaneTabsBehavior}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.detailsPaneTabsBehavior'),
                        subtitle: t('settingsAppearance.detailsPaneTabsBehaviorDescription'),
                        icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.blue} />,
                        showSelectedSubtitle: false,
                        itemProps: { disabled: !panelsSupported },
                    }}
                    items={detailsTabsMenuItems}
                    onSelect={(itemId) => {
                        if (!isDetailsPaneTabsBehavior(itemId)) return;
                        setDetailsPaneTabsBehavior(itemId);
                    }}
                />
            </ItemGroup>

            {/* Style */}
            <ItemGroup title={t('settingsAppearance.avatarStyle')}>
                <DropdownMenu
                    open={openAvatarStyleMenu}
                    onOpenChange={setOpenAvatarStyleMenu}
                    variant="selectable"
                    search={false}
                    selectedId={displayStyle}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    itemTrigger={{
                        title: t('settingsAppearance.avatarStyle'),
                        subtitle: t('settingsAppearance.avatarStyleDescription'),
                        icon: <AvatarStylePreviewIcon styleId={displayStyle} />,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'settings-appearance-avatarStyle-select' },
                    }}
                    items={avatarStyleMenuItems}
                    onSelect={(itemId) => {
                        if (!isAvatarStyleId(itemId)) return;
                        setAvatarStyle(itemId);
                    }}
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
            </ItemGroup>
        </ItemList>
    );
});
