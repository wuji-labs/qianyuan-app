import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setCoalesceEnabled = vi.fn();
const setPartialOutputEnabled = vi.fn();
const setListImplementation = vi.fn();
let listImplementationValue: string = 'flash_v2';

installSessionSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TextInput: 'TextInput',
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: (key: string) => {
                    if (key === 'transcriptStreamingCoalesceEnabled') return [true, setCoalesceEnabled];
                    if (key === 'transcriptStreamingCoalesceWindowMs') return [16, vi.fn()];
                    if (key === 'transcriptStreamingCoalesceMaxBatchSize') return [200, vi.fn()];
                    if (key === 'transcriptStreamingPartialOutputEnabled') return [true, setPartialOutputEnabled];
                    if (key === 'transcriptThinkingPulseStaleMs') return [120_000, vi.fn()];
                    if (key === 'transcriptListImplementation') return [listImplementationValue, setListImplementation];
                    if (key === 'transcriptMotionPreset') return ['subtle', vi.fn()];
                    if (key === 'transcriptMotionFreshnessMs') return [60_000, vi.fn()];
                    if (key === 'transcriptAnimateNewItemsEnabled') return [true, vi.fn()];
                    if (key === 'transcriptAnimateToolExpandCollapseEnabled') return [true, vi.fn()];
                    if (key === 'transcriptAnimateToolExpandCollapseFreshOnly') return [true, vi.fn()];
                    if (key === 'transcriptAnimateThinkingEnabled') return [true, vi.fn()];
                    if (key === 'transcriptScrollPinOffsetThresholdPx') return [72, vi.fn()];
                    if (key === 'transcriptScrollAutoFollowWhenPinned') return [true, vi.fn()];
                    if (key === 'transcriptScrollJumpToBottomMinNewCount') return [1, vi.fn()];
                    if (key === 'transcriptScrollJumpToBottomAnimateScroll') return [true, vi.fn()];
                    return [null, vi.fn()];
                },
            },
        });
    },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

afterEach(() => {
    standardCleanup();
    setCoalesceEnabled.mockClear();
    setPartialOutputEnabled.mockClear();
    setListImplementation.mockClear();
    listImplementationValue = 'flash_v2';
});

describe('Transcript advanced settings (performance)', () => {
    it('toggles streaming coalescing enabled', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle');
        });

        expect(setCoalesceEnabled).toHaveBeenCalledWith(false);
    });

    it('toggles partial streaming output visibility', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.streamingPartialOutputTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsSession.transcript.advanced.streamingPartialOutputTitle');
        });

        expect(setPartialOutputEnabled).toHaveBeenCalledWith(false);
    });

    it('offers the flash_v2_inverted list implementation and persists it on select', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const dropdown = screen.findAll((node) => String(node.type) === 'DropdownMenu')[0];
        expect(dropdown).toBeTruthy();

        const invertedItem = (dropdown!.props.items as Array<{ id: string; title: string; subtitle: string }>)
            .find((item) => item.id === 'flash_v2_inverted');
        expect(invertedItem?.title).toBe('settingsSession.transcript.advanced.listImplementation.flashInvertedTitle');
        expect(invertedItem?.subtitle).toBe('settingsSession.transcript.advanced.listImplementation.flashInvertedSubtitle');

        await act(async () => {
            dropdown!.props.onSelect('flash_v2_inverted');
        });

        expect(setListImplementation).toHaveBeenCalledWith('flash_v2_inverted');
    });

    it('shows flash_v2_inverted as the selected option when persisted', async () => {
        listImplementationValue = 'flash_v2_inverted';
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const dropdown = screen.findAll((node) => String(node.type) === 'DropdownMenu')[0];
        expect(dropdown?.props.selectedId).toBe('flash_v2_inverted');
    });
});
