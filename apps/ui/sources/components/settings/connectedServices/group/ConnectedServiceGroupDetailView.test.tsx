import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncHandlers() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    patchConnectedServiceAuthGroupV3: vi.fn(),
    patchConnectedServiceAuthGroupMemberV3: vi.fn(),
    addConnectedServiceAuthGroupMemberV3: vi.fn(),
    removeConnectedServiceAuthGroupMemberV3: vi.fn(),
    setConnectedServiceAuthGroupActiveProfileV3: vi.fn(),
}));

const syncSpies = vi.hoisted(() => ({
    refreshProfile: vi.fn(),
}));

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const featureEnabledById = vi.hoisted(() => new Map<string, boolean>());
const profileState = vi.hoisted(() => ({
    current: {
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
        ],
    },
}));

const authoritativeGroupState = vi.hoisted(() => ({
    groups: [] as unknown[],
}));

function createAuthoritativeGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: {
            v: 1,
            strategy: 'priority',
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
        },
        activeProfileId: 'work',
        generation: 2,
        state: { status: 'ready' },
        createdAt: 1,
        updatedAt: 2,
        members: [
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        ...overrides,
    };
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'openai-codex', groupId: 'primary' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalSpies.prompt,
                confirm: modalSpies.confirm,
                alert: modalSpies.alert,
            },
        }).module;
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledById.get(featureId) ?? true,
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useProfile: () => profileState.current,
        useSettings: () => ({
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
        }),
    };
});

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: syncSpies.refreshProfile },
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    const React = require('react');
    return {
        DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
    };
});

vi.mock('@/components/ui/lists/ItemRowActions', () => {
    const React = require('react');
    return {
        ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
    };
});

async function renderGroupDetailScreen() {
    const { ConnectedServiceGroupDetailView } = await import('./ConnectedServiceGroupDetailView');
    const screen = await renderScreen(<ConnectedServiceGroupDetailView />);
    await flushAsyncHandlers();
    return screen;
}

describe('ConnectedServiceGroupDetailView', () => {
    beforeEach(() => {
        modalSpies.prompt.mockReset();
        modalSpies.confirm.mockReset();
        modalSpies.alert.mockReset();
        syncSpies.refreshProfile.mockReset();
        featureEnabledById.clear();
        authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
        authoritativeGroupState.groups = [createAuthoritativeGroup()];
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementation(async () => authoritativeGroupState.groups);
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({
            members: [
                (createAuthoritativeGroup().members as unknown[])[0],
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    groupId: 'primary',
                    profileId: 'backup',
                    priority: 100,
                    enabled: true,
                    state: {},
                    createdAt: 1,
                    updatedAt: 2,
                },
            ],
        }));
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({ members: [] }));
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockReset();
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async () => createAuthoritativeGroup({ activeProfileId: 'backup' }));
    });

    it('renders the selected group with editable settings and profile member dropdown', async () => {
        const screen = await renderGroupDetailScreen();
        const dropdown = screen.tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-group-detail:members');
        expect(dropdown).toBeTruthy();
        const items = dropdown!.props.items as ReadonlyArray<{ id: string; rightElement?: React.ReactNode }>;

        expect(screen.findByTestId('connected-services-group-detail:name')).toBeTruthy();
        expect(screen.findByTestId('connected-services-group-detail:auto-switch')).toBeTruthy();
        expect(dropdown!.props.itemTrigger?.itemProps?.testID).toBe('connected-services-group-detail:members');
        expect(items.map((item) => item.id)).toEqual(['work', 'backup']);
        expect(items.find((item) => item.id === 'work')?.rightElement).toBeTruthy();
        expect(items.find((item) => item.id === 'backup')?.rightElement).toBeNull();
    });

    it('disables the auto-switch control when account fallback is disabled by the server', async () => {
        featureEnabledById.set('connectedServices.accountFallback', false);

        const screen = await renderGroupDetailScreen();
        const autoSwitchItem = screen.tree.root.find((node) =>
            node.props?.testID === 'connected-services-group-detail:auto-switch'
            && node.props?.title === 'connectedServices.detail.groupDetail.autoSwitchTitle');

        expect(autoSwitchItem.props).toEqual(expect.objectContaining({
            disabled: true,
            subtitle: 'connectedServices.detail.groupActions.accountFallbackDisabled',
            onPress: undefined,
        }));
    });

    it('updates group name, policy, and dropdown membership through v3 group APIs', async () => {
        modalSpies.prompt.mockResolvedValueOnce('Renamed pool');
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderGroupDetailScreen();

        await screen.pressByTestIdAsync('connected-services-group-detail:name');
        await screen.pressByTestIdAsync('connected-services-group-detail:auto-switch');
        const strategyDropdown = screen.tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-group-detail:strategy');
        await act(async () => {
            strategyDropdown?.props.onSelect('least_limited');
            await flushAsyncHandlers();
        });
        const membersDropdown = screen.tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-group-detail:members');
        await act(async () => {
            membersDropdown?.props.onSelect('backup');
            await flushAsyncHandlers();
            membersDropdown?.props.onSelect('work');
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { displayName: 'Renamed pool' } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { policy: { autoSwitch: true }, expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { policy: { strategy: 'least_limited' }, expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                priority: 100,
                enabled: true,
                expectedGeneration: 2,
            },
        );
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', profileId: 'work', expectedGeneration: 2 },
        );
        expect(syncSpies.refreshProfile).toHaveBeenCalled();
        expect(modalSpies.prompt).not.toHaveBeenCalledWith(
            'connectedServices.detail.groupActions.memberProfileTitle',
            expect.anything(),
            expect.anything(),
        );
    });

    it('updates group quota fallback thresholds through policy patch APIs', async () => {
        modalSpies.prompt
            .mockResolvedValueOnce('9')
            .mockResolvedValueOnce('2');
        const screen = await renderGroupDetailScreen();

        await screen.pressByTestIdAsync('connected-services-group-detail:soft-switch-threshold');
        await screen.pressByTestIdAsync('connected-services-group-detail:stale-probe-after');

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { policy: { softSwitchRemainingPercent: 9 }, expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { policy: { probeIfSnapshotOlderThanMs: 120_000 }, expectedGeneration: 2 } },
        );
    });

    it('renders member status rows and updates active member, enabled state, and priority', async () => {
        modalSpies.prompt.mockResolvedValueOnce('5');
        const exhaustedUntilMs = Date.UTC(2026, 4, 19, 12, 30, 0);
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                members: [
                    {
                        v: 1,
                        serviceId: 'openai-codex',
                        groupId: 'primary',
                        profileId: 'work',
                        priority: 10,
                        enabled: true,
                        state: {},
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    {
                        v: 1,
                        serviceId: 'openai-codex',
                        groupId: 'primary',
                        profileId: 'backup',
                        priority: 20,
                        enabled: false,
                        state: { exhaustedUntilMs, lastFailureKind: 'usage_limit' },
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
            }),
        ];

        const screen = await renderGroupDetailScreen();
        const { t } = await import('@/text');
        const backupRow = screen.tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-group-detail:member:backup'
            && typeof node.props?.subtitle === 'string')[0] ?? null;
        expect(backupRow).toBeTruthy();
        const backupSubtitle = String(backupRow?.props.subtitle ?? '');
        const backupActions = screen.tree.root
            .findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'backup')?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;

        expect(screen.findByTestId('connected-services-group-detail:member:work')).toBeTruthy();
        expect(backupSubtitle).toContain(t('connectedServices.detail.groups.memberDisabled'));
        expect(backupSubtitle).toContain(t('connectedServices.detail.groups.memberPriority', { priority: 20 }));
        expect(backupSubtitle).toContain(t('connectedServices.detail.groups.memberExhaustedUntil', { time: new Date(exhaustedUntilMs).toLocaleString() }));
        expect(backupActions?.map((action) => action.id)).toEqual([
            'connected-services-group:primary:member:backup:action:set-active',
            'connected-services-group:primary:member:backup:action:enable',
            'connected-services-group:primary:member:backup:action:priority',
            'connected-services-group:primary:member:backup:action:remove',
        ]);

        await act(async () => {
            backupActions?.find((action) => action.id.endsWith(':set-active'))?.onPress();
            await flushAsyncHandlers();
            backupActions?.find((action) => action.id.endsWith(':enable'))?.onPress();
            await flushAsyncHandlers();
            backupActions?.find((action) => action.id.endsWith(':priority'))?.onPress();
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', profileId: 'backup', expectedGeneration: 2 },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { enabled: true, expectedGeneration: 2 },
            },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 5, expectedGeneration: 2 },
            },
        );
    });
});
