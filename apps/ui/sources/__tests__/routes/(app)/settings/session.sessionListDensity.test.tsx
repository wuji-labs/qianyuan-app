import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionListDensity = vi.fn();
const setWorkspacePathDisplayMode = vi.fn();
const setWorkspaceFaviconsEnabled = vi.fn();
const setWorkspaceMachineSubtitlesEnabled = vi.fn();

installSessionSettingsEntryModuleMocks({
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: ((key: string) => {
                    if (key === 'sessionTagsEnabled') return [true, vi.fn()];
                    if (key === 'sessionListDensity') return ['cozy', setSessionListDensity];
                    if (key === 'workspacePathDisplayModeV1') return ['name', setWorkspacePathDisplayMode];
                    if (key === 'workspaceFaviconsEnabled') return [true, setWorkspaceFaviconsEnabled];
                    if (key === 'workspaceMachineSubtitlesEnabled') return [true, setWorkspaceMachineSubtitlesEnabled];
                    if (key === 'sessionListNarrowWorkingIndicatorStyle') return ['spinner', vi.fn()];
                    if (key === 'hideInactiveSessions') return [false, vi.fn()];
                    if (key === 'sessionListActiveGroupingV1') return ['project', vi.fn()];
                    if (key === 'sessionListInactiveGroupingV1') return ['date', vi.fn()];
                    if (key === 'agentInputActionBarLayout') return ['auto', vi.fn()];
                    if (key === 'agentInputChipDensity') return ['auto', vi.fn()];
                    if (key === 'alwaysShowContextSize') return [false, vi.fn()];
                    if (key === 'sessionUseTmux') return [false, vi.fn()];
                    if (key === 'sessionTmuxSessionName') return ['happy', vi.fn()];
                    if (key === 'sessionTmuxIsolated') return [true, vi.fn()];
                    if (key === 'sessionTmuxTmpDir') return [null, vi.fn()];
                    if (key === 'sessionMessageSendMode') return ['agent_queue', vi.fn()];
                    if (key === 'sessionBusySteerSendPolicy') return ['steer_immediately', vi.fn()];
                    if (key === 'agentInputEnterToSend') return [true, vi.fn()];
                    if (key === 'agentInputHistoryScope') return ['perSession', vi.fn()];
                    if (key === 'terminalConnectLegacySecretExportEnabled') return [false, vi.fn()];
                    if (key === 'sessionReplayEnabled') return [false, vi.fn()];
                    if (key === 'sessionReplayStrategy') return ['recent_messages', vi.fn()];
                    if (key === 'sessionReplayRecentMessagesCount') return [250, vi.fn()];
                    if (key === 'sessionReplayMaxSeedChars') return [120000, vi.fn()];
                    if (key === 'sessionReplaySummaryRunnerV1') return [null, vi.fn()];
                    return [null, vi.fn()];
                }) as any,
                useLocalSettingMutable: ((key: string) => {
                    if (key === 'sessionsRightPaneDefaultOpen') return [false, vi.fn()];
                    if (key === 'uiMultiPanePanelsEnabled') return [true, vi.fn()];
                    return [null, vi.fn()];
                }) as any,
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    setSessionListDensity.mockClear();
    setWorkspacePathDisplayMode.mockClear();
    setWorkspaceFaviconsEnabled.mockClear();
    setWorkspaceMachineSubtitlesEnabled.mockClear();
    resetSessionSettingsEntryState();
});

describe('Session settings session list density', () => {
    it('defaults to the cozy density option and updates only the canonical density setting', async () => {
        setSessionListDensity.mockClear();
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const densityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.sessionListDensity.title');
        expect(densityDropdown).toBeTruthy();
        expect(densityDropdown?.props?.selectedId).toBe('cozy');

        const itemIds = densityDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['detailed', 'cozy', 'narrow']);

        await act(async () => {
            densityDropdown!.props.onSelect('cozy');
        });

        expect(setSessionListDensity).toHaveBeenCalledWith('cozy');
    });

    it('exposes workspace name and favicon controls in the session list settings', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workspaceNameDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.workspacePathDisplayTitle');
        expect(workspaceNameDropdown).toBeTruthy();
        expect(workspaceNameDropdown?.props?.selectedId).toBe('name');
        expect(workspaceNameDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['name', 'path']);

        await act(async () => {
            workspaceNameDropdown!.props.onSelect('path');
        });
        expect(setWorkspacePathDisplayMode).toHaveBeenCalledWith('path');

        const faviconItem = screen.findAllByType('Item' as any).find((node: any) =>
            node.props?.title === 'settingsSession.sessionList.workspaceFaviconsTitle');
        expect(faviconItem).toBeTruthy();
        await act(async () => {
            faviconItem!.props.onPress();
        });
        expect(setWorkspaceFaviconsEnabled).toHaveBeenCalledWith(false);

        const machineSubtitleItem = screen.findAllByType('Item' as any).find((node: any) =>
            node.props?.title === 'settingsSession.sessionList.workspaceMachineSubtitlesTitle');
        expect(machineSubtitleItem).toBeTruthy();
        await act(async () => {
            machineSubtitleItem!.props.onPress();
        });
        expect(setWorkspaceMachineSubtitlesEnabled).toHaveBeenCalledWith(false);
    });

    it('labels the loading style selector as the general working indicator setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workingIndicatorDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.workingIndicatorTitle');
        expect(workingIndicatorDropdown).toBeTruthy();
        expect(workingIndicatorDropdown?.props?.selectedId).toBe('spinner');
        expect(workingIndicatorDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-workingIndicator-trigger');
    });
});
