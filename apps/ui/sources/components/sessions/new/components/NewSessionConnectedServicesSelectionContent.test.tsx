import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SelectionListProps } from '@/components/ui/selectionList';
import { activateSelectionListRow } from '@/components/ui/selectionList/SelectionListRowActivation';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists: SelectionListProps[] = [];

vi.mock('react-native', () => createReactNativeWebMock({
    View: createPassThroughComponent('View'),
    Platform: {
        OS: 'ios',
        select: (options: any) => options.ios ?? options.native ?? options.default,
    },
}));

vi.mock('react-native-unistyles', () => createUnistylesMock());
vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughComponent('Ionicons'),
}));
vi.mock('@/text', () => createTextModuleMock({ translate: (key) => key }));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));
vi.mock('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName', () => ({
    resolveConnectedServiceDisplayName: (serviceId: string) => serviceId,
}));
vi.mock('@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView', () => ({
    ConnectedServiceQuotaBadgesView: createPassThroughComponent('ConnectedServiceQuotaBadgesView'),
}));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));
vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
    return {
        ...actual,
        StatusPill: createPassThroughComponent('StatusPill'),
        SelectionList: (props: SelectionListProps) => {
            capturedSelectionLists.push(props);
            return React.createElement('SelectionList', { testID: props.testID });
        },
    };
});

describe('NewSessionConnectedServicesSelectionContent', () => {
    it('uses measured native height for connected-services auth content under the computed popover cap', async () => {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

        capturedSelectionLists.length = 0;
        await renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={[]}
                profileOptionsByServiceId={{}}
                bindingsByServiceId={{}}
                setBindingForService={() => {}}
                onOpenSettings={() => {}}
                maxHeight={420}
            />,
        );

        expect(capturedSelectionLists).toHaveLength(1);
        expect(capturedSelectionLists[0]?.heightBehavior).toBe('measuredToMaxHeight');
    });

    it('closes the connected-services popover after selecting a profile option', async () => {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

        capturedSelectionLists.length = 0;
        const requestClose = vi.fn();
        const setBindingForService = vi.fn();
        await renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={['anthropic']}
                profileOptionsByServiceId={{
                    anthropic: [{
                        profileId: 'work',
                        label: 'Work',
                        providerEmail: 'work@example.com',
                        kind: 'token',
                        status: 'connected',
                    }],
                }}
                bindingsByServiceId={{}}
                setBindingForService={setBindingForService}
                onOpenSettings={() => {}}
                maxHeight={420}
                requestClose={requestClose}
            />,
        );

        expect(capturedSelectionLists).toHaveLength(1);
        const selectionList = capturedSelectionLists[0]!;
        const staticSection = selectionList.rootStep.sections[0];
        if (!staticSection || staticSection.kind !== 'static') {
            throw new Error('Expected a static connected-services section');
        }
        const profileOption = staticSection.options.find((option) => option.id.includes(':profile:'));
        if (!profileOption) {
            throw new Error('Expected a connected profile option');
        }

        await React.act(async () => {
            activateSelectionListRow({
                option: profileOption,
                onSelect: selectionList.onSelect,
                onPushStep: vi.fn(),
            });
        });

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        });
        expect(requestClose).toHaveBeenCalledTimes(1);
    });
});
