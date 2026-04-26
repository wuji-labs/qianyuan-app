import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

installSessionSettingsEntryModuleMocks({
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return {
            ...createTextModuleMock(),
            getLanguageNativeName: () => 'English',
            SUPPORTED_LANGUAGES: { en: { name: 'English' } },
        };
    },
});

beforeEach(() => {
    sessionSettingsEntryState.settingsState = {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
        avatarStyle: 'brutalist',
        showFlavorIcons: true,
        preferredLanguage: null,
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        detailsPaneTabsBehavior: 'preview',
        editorFocusModeEnabled: false,
    };
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Appearance settings avatar style', () => {
    it('cycles from brutalist to mesh gradient through the avatar style row', async () => {
        const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen), {
            flushOptions: { cycles: 0 },
        });

        const avatarStyleRow = screen.findByProps({ testID: 'settings-appearance-avatarStyle-cycle' });

        await act(async () => {
            avatarStyleRow.props.onPress();
        });

        expect(sessionSettingsEntryState.settingsState.avatarStyle).toBe('meshGradient');
    });
});
