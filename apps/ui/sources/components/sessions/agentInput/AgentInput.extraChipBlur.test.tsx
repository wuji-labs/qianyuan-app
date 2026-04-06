import * as React from 'react';
import { Pressable } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import type { AgentInputExtraActionChip } from './agentInputContracts';

const blurSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((_props: any, ref) => {
        React.useImperativeHandle(ref, () => ({
            blur: blurSpy,
        }));
        return null;
    }),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

describe('AgentInput (extra chip popovers)', () => {
    it('blurs the composer input when opening an extra chip collapsed popover so taps inside the popover work on iOS', async () => {
        blurSpy.mockReset();
        const { AgentInput } = await import('./AgentInput');

        const extraChip: AgentInputExtraActionChip = {
            key: 'probe-chip',
            controlId: 'attachments' as any,
            labelPolicy: 'auto-hide',
            collapsedOptionsPopover: {
                presentation: 'simple',
                title: null,
                closeOnSelect: false,
                options: [{ id: 'a', label: 'A' }],
                onSelect: () => {},
            },
            render: (ctx) => (
                <Pressable
                    testID="probe-extra-chip"
                    onPress={() => ctx.toggleCollapsedPopover?.('probe-chip')}
                />
            ),
        };

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[extraChip]}
            />,
        );

        await screen.pressByTestIdAsync('probe-extra-chip');
        expect(blurSpy).toHaveBeenCalledTimes(1);
    });
});
