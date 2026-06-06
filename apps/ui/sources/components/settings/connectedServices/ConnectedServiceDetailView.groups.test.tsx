import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';
import { connectedServicesModuleState } from './connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncHandlers() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function isItemRowActionsNode(node: Readonly<{ type: unknown }>): boolean {
    return node.type === 'ItemRowActions';
}

const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    createConnectedServiceAuthGroupV3: vi.fn(),
    patchConnectedServiceAuthGroupV3: vi.fn(),
    deleteConnectedServiceAuthGroupV3: vi.fn(),
    addConnectedServiceAuthGroupMemberV3: vi.fn(),
    patchConnectedServiceAuthGroupMemberV3: vi.fn(),
    removeConnectedServiceAuthGroupMemberV3: vi.fn(),
    setConnectedServiceAuthGroupActiveProfileV3: vi.fn(),
}));

const syncSpies = vi.hoisted(() => ({
    refreshProfile: vi.fn(),
    applySettings: vi.fn(),
}));
const connectedServiceCredentialSpies = vi.hoisted(() => ({
    storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
    deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const featureEnabledById = vi.hoisted(() => new Map<string, boolean>());
const profileState = vi.hoisted(() => ({
    current: { connectedServicesV2: [] as unknown[] },
    listeners: new Set<() => void>(),
}));
const authoritativeGroupState = vi.hoisted(() => ({
    groups: [] as unknown[],
}));

function notifyProfileStateChanged() {
    for (const listener of profileState.listeners) {
        listener();
    }
}

function createProfileSnapshot(groups: unknown[] = []) {
    return {
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
                groups,
            },
        ],
    };
}

function createAuthoritativeGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: {
            v: 1,
            strategy: 'priority',
            autoSwitch: true,
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
        state: {
            status: 'ready',
            cooldownUntilMs: 1_800_000_000_000,
        },
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
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                priority: 20,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        ...overrides,
    };
}

async function renderGroupsScreen() {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await flushAsyncHandlers();
    return screen;
}

async function invokeRowAction(action: Readonly<{ onPress: () => void }>) {
    await act(async () => {
        action.onPress();
        await flushAsyncHandlers();
    });
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'openai-codex' },
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
    const React = await import('react');
    return {
        ...actual,
        useProfile: () => React.useSyncExternalStore(
            (listener) => {
                profileState.listeners.add(listener);
                return () => {
                    profileState.listeners.delete(listener);
                };
            },
            () => profileState.current,
            () => profileState.current,
        ),
        useSettings: () => ({
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
        }),
    };
});

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshProfile: syncSpies.refreshProfile,
        applySettings: syncSpies.applySettings,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
    storeConnectedServiceCredentialForAccount: connectedServiceCredentialSpies.storeConnectedServiceCredentialForAccount,
    deleteConnectedServiceCredentialForAccount: connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount,
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);

vi.mock('@/components/ui/lists/ItemRowActions', () => {
    const React = require('react');
    type ItemRowActionsMockProps = React.PropsWithChildren<Record<string, unknown>>;
    return {
        ItemRowActions: (props: ItemRowActionsMockProps) => React.createElement('ItemRowActions', props, props.children),
    };
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    const React = require('react');
    return {
        DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
    };
});

describe('ConnectedServiceDetailView groups', () => {
    beforeEach(() => {
        modalSpies.prompt.mockReset();
        modalSpies.confirm.mockReset();
        modalSpies.alert.mockReset();
        syncSpies.refreshProfile.mockReset();
        syncSpies.applySettings.mockReset();
        connectedServiceCredentialSpies.storeConnectedServiceCredentialForAccount.mockClear();
        connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount.mockClear();
        authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
        featureEnabledById.clear();
        profileState.current = createProfileSnapshot([
            {
                groupId: 'primary',
                displayName: 'Profile summary',
                activeProfileId: 'work',
                generation: 2,
                memberProfileIds: ['work', 'backup'],
            },
        ]);
        authoritativeGroupState.groups = [createAuthoritativeGroup()];
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementation(async () => authoritativeGroupState.groups);
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockResolvedValue(true);
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockReset();
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async () => createAuthoritativeGroup());
        syncSpies.refreshProfile.mockResolvedValue(undefined);
    });

    it('loads authoritative groups from the v3 list API instead of the profile projection', async () => {
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                displayName: 'Authoritative pool',
            }),
        ];

        const screen = await renderGroupsScreen();

        expect(screen.findByTestId('connected-services-group:primary')).toBeTruthy();
        expect(screen.findByTestId('connected-services-group:primary:member:work')).toBeTruthy();
        expect(screen.findByTestId('connected-services-group:primary:member:backup')).toBeTruthy();
        const memberDropdown = screen.tree.root.findByType('DropdownMenu' as any);
        expect(memberDropdown.props.itemTrigger?.itemProps?.testID).toBe('connected-services-group:primary:members');
        expect(screen.findByTestId('connected-services-action:create-group')).toBeTruthy();
        const groupRow = screen.tree.find((node) => node.props?.title === 'Authoritative pool');
        const createGroupRow = screen.tree.find((node) =>
            node.props?.title === 'connectedServices.detail.groupActions.createTitle'
        );
        const projectedSummaryRow = screen.tree.findAll((node) => node.props?.title === 'Profile summary');
        const profileNavigation = screen.findByTestId('connected-services-profile:work:open');
        const renderedTitles = screen.tree.root
            .findAll((node) => typeof node.props?.title === 'string')
            .map((node) => node.props.title);

        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex' },
        );
        expect(groupRow).toBeTruthy();
        expect(groupRow?.props.subtitle).toContain('connectedServices.detail.groups.activeMember');
        expect(groupRow?.props.subtitle).toContain('connectedServices.detail.groups.enabledMembers');
        expect(groupRow?.props.subtitle).toContain('connectedServices.detail.groups.autoFallbackEnabled');
        expect(groupRow?.props.subtitle).toContain('connectedServices.detail.groups.cooldown');
        expect(projectedSummaryRow).toHaveLength(0);

        expect(profileNavigation).toBeTruthy();
        expect(createGroupRow).toBeTruthy();
        expect(renderedTitles).toContain('connectedServices.detail.groups.title');
        expect(renderedTitles).toContain('connectedServices.detail.groupActions.title');
    });

    it('refetches authoritative groups when the service projection changes after a profile update', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                displayName: 'Initial pool',
            }),
        ];

        const screen = await renderScreen(<ConnectedServiceDetailView />);
        await flushAsyncHandlers();
        expect(screen.tree.find((node) => node.props?.title === 'Initial pool')).toBeTruthy();

        const listCallsBeforeProjectionChange = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;

        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                displayName: 'Refetched pool',
                activeProfileId: 'backup',
                generation: 3,
            }),
        ];

        await screen.update(<ConnectedServiceDetailView />);
        await act(async () => {
            profileState.current = {
                connectedServicesV2: [
                    {
                        serviceId: 'openai-codex',
                        profiles: [
                            { profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' },
                            { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                        ],
                        groups: [
                            {
                                groupId: 'primary',
                                displayName: 'Projected summary',
                                activeProfileId: 'backup',
                                generation: 3,
                                memberProfileIds: ['backup'],
                            },
                        ],
                    },
                ],
            };
            notifyProfileStateChanged();
            await flushAsyncHandlers();
        });
        await flushAsyncHandlers();

        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(
            listCallsBeforeProjectionChange,
        );
        expect(screen.tree.find((node) => node.props?.title === 'Refetched pool')).toBeTruthy();
    });

    it('refetches authoritative groups after disconnect even when the service projection stays equivalent', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                displayName: 'Initial pool',
            }),
        ];
        syncSpies.refreshProfile.mockImplementation(async () => {
            profileState.current = createProfileSnapshot([
                {
                    groupId: 'primary',
                    displayName: 'Profile summary',
                    activeProfileId: 'work',
                    generation: 2,
                    memberProfileIds: ['work', 'backup'],
                },
            ]);
            notifyProfileStateChanged();
        });
        modalSpies.confirm.mockResolvedValueOnce(true);

        const screen = await renderScreen(<ConnectedServiceDetailView />);
        await flushAsyncHandlers();
        expect(screen.tree.find((node) => node.props?.title === 'Initial pool')).toBeTruthy();

        const listCallsBeforeDisconnect = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                displayName: 'Refetched after disconnect',
            }),
        ];

        const actionHosts = screen.tree.findAllByType('ItemRowActions' as any);
        const disconnect = actionHosts
            .flatMap((host) => (host.props?.actions ?? []) as ReadonlyArray<{ id: string; onPress: () => Promise<void> | void }>)
            .find((action) => action.id === 'disconnect');

        await act(async () => {
            await disconnect?.onPress();
            await flushAsyncHandlers();
        });

        expect(connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', profileId: 'work' },
        );
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(
            listCallsBeforeDisconnect,
        );
        expect(screen.tree.find((node) => node.props?.title === 'Refetched after disconnect')).toBeTruthy();
    });

    it('creates groups from a single user-facing name prompt and refetches authoritative group state', async () => {
        profileState.current = createProfileSnapshot([]);
        authoritativeGroupState.groups = [];
        const createdGroup = createAuthoritativeGroup({
            groupId: 'team-pool',
            displayName: 'Team Pool',
            activeProfileId: null,
            members: [],
        });
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockImplementation(async () => {
            authoritativeGroupState.groups = [createdGroup];
            return createdGroup;
        });
        modalSpies.prompt.mockResolvedValueOnce('Team Pool!');
        const screen = await renderGroupsScreen();
        const listCallsBeforeAction = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;
        await screen.pressByTestIdAsync('connected-services-action:create-group');
        await flushAsyncHandlers();

        expect(modalSpies.prompt).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'team-pool',
                displayName: 'Team Pool!',
                members: [],
                activeProfileId: null,
            }),
        );
        expect(syncSpies.refreshProfile).toHaveBeenCalled();
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(listCallsBeforeAction);
        expect(screen.findByTestId('connected-services-group:team-pool')).toBeTruthy();
    });

    it('infers a safe group id when the display name has no slug characters', async () => {
        profileState.current = createProfileSnapshot([]);
        authoritativeGroupState.groups = [];
        const createdGroup = createAuthoritativeGroup({
            groupId: 'group',
            displayName: 'チーム',
            activeProfileId: null,
            members: [],
        });
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockImplementation(async () => {
            authoritativeGroupState.groups = [createdGroup];
            return createdGroup;
        });
        modalSpies.prompt.mockResolvedValueOnce('チーム');

        const screen = await renderGroupsScreen();
        await screen.pressByTestIdAsync('connected-services-action:create-group');
        await flushAsyncHandlers();

        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'group',
                displayName: 'チーム',
            }),
        );
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('renders account groups before quota sections so group management is not buried below usage', async () => {
        const screen = await renderGroupsScreen();
        const titledNodes = screen.tree.root
            .findAll((node) => typeof node.props?.title === 'string')
            .map((node) => node.props.title);

        const groupsIndex = titledNodes.indexOf('connectedServices.detail.groups.title');
        const quotaRefreshIndex = titledNodes.indexOf('common.refresh');

        expect(groupsIndex).toBeGreaterThanOrEqual(0);
        expect(quotaRefreshIndex).toBeGreaterThanOrEqual(0);
        expect(groupsIndex).toBeLessThan(quotaRefreshIndex);
    });

    it('routes create-group auth loss through the shared modal error path', async () => {
        profileState.current = createProfileSnapshot([]);
        authoritativeGroupState.groups = [];
        modalSpies.prompt
            .mockResolvedValueOnce('Team Pool');
        const screen = await renderGroupsScreen();

        authState.credentials = null;

        await expect(screen.pressByTestIdAsync('connected-services-action:create-group')).resolves.toBeUndefined();
        await flushAsyncHandlers();

        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
        expect(modalSpies.alert).toHaveBeenCalledWith('common.error', 'Not authenticated');
    });

    it('manages group display and fallback policy through row actions', async () => {
        const screen = await renderGroupsScreen();
        const listCallsBeforeActions = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;
        const groupActions = screen.tree.find((node) => isItemRowActionsNode(node) && node.props?.title === 'Team pool');
        const actions = groupActions?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;

        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:action:edit')!);
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:action:disable-fallback')!);
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:action:manual-strategy')!);

        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/group',
            params: { serviceId: 'openai-codex', groupId: 'primary' },
        });
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: expect.objectContaining({
                    expectedGeneration: 2,
                    policy: expect.objectContaining({ autoSwitch: false }),
                }),
            }),
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: expect.objectContaining({
                    expectedGeneration: 2,
                    policy: expect.objectContaining({ strategy: 'manual' }),
                }),
            }),
        );
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThanOrEqual(
            listCallsBeforeActions + 2,
        );
    });

    it('uses a profile dropdown to add and remove group members without manual profile-id prompts', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            members: [{
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            }],
        })];
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderGroupsScreen();
        const dropdown = screen.tree.root.findByType('DropdownMenu' as any);
        const items = dropdown.props.items as ReadonlyArray<{ id: string; title: string; rightElement?: React.ReactNode }>;

        await act(async () => {
            dropdown.props.onSelect('backup');
            await flushAsyncHandlers();
            dropdown.props.onSelect('work');
            await flushAsyncHandlers();
        });

        expect(items.map((item) => item.id)).toEqual(['work', 'backup']);
        expect(items.find((item) => item.id === 'work')?.rightElement).toBeTruthy();
        expect(items.find((item) => item.id === 'backup')?.rightElement).toBeNull();
        expect(modalSpies.prompt).not.toHaveBeenCalledWith(
            'connectedServices.detail.groupActions.memberProfileTitle',
            expect.anything(),
            expect.anything(),
        );
        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            }),
        );
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', profileId: 'work', expectedGeneration: 2 },
        );
    });

    it('deletes groups after confirmation', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderGroupsScreen();
        const listCallsBeforeAction = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;
        const groupActions = screen.tree.find((node) => isItemRowActionsNode(node) && node.props?.title === 'Team pool');
        const actions = groupActions?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:action:delete')!);

        expect(authGroupApiSpies.deleteConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary' },
        );
        expect(syncSpies.refreshProfile).toHaveBeenCalled();
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(listCallsBeforeAction);
    });

    it('adds members and updates active, enabled, and priority member state', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            members: [{
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            }],
        })];
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => {
            const nextGroup = createAuthoritativeGroup();
            authoritativeGroupState.groups = [nextGroup];
            return nextGroup;
        });
        modalSpies.prompt.mockResolvedValueOnce('5');
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderGroupsScreen();
        const listCallsBeforeActions = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;
        const dropdown = screen.tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            dropdown.props.onSelect('backup');
            await flushAsyncHandlers();
        });

        const backupActions = screen.tree
            .root
            .findAll((node) => isItemRowActionsNode(node) && node.props?.title === 'backup')
            .find((node) => Array.isArray(node.props.actions)
                && node.props.actions.some((action: { id?: string }) => action.id === 'connected-services-group:primary:member:backup:action:set-active'));
        const actions = backupActions?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:member:backup:action:set-active')!);
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:member:backup:action:disable')!);
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:member:backup:action:priority')!);
        await invokeRowAction(actions!.find((action) => action.id === 'connected-services-group:primary:member:backup:action:remove')!);

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
        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { enabled: false, expectedGeneration: 2 },
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
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            },
        );
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThanOrEqual(
            listCallsBeforeActions + 5,
        );
    });

    it('disables member active switching when account fallback is disabled', async () => {
        featureEnabledById.set('connectedServices.accountFallback', false);
        const screen = await renderGroupsScreen();
        const backupActions = screen.tree
            .root
            .findAll((node) => isItemRowActionsNode(node) && node.props?.title === 'backup')
            .find((node) => Array.isArray(node.props.actions)
                && node.props.actions.some((action: { id?: string }) => action.id === 'connected-services-group:primary:member:backup:action:set-active'));
        const actions = backupActions?.props.actions as ReadonlyArray<{ id: string; disabled?: boolean; subtitle?: string }> | undefined;
        const setActive = actions?.find((action) => action.id === 'connected-services-group:primary:member:backup:action:set-active');

        expect(setActive).toEqual(expect.objectContaining({
            disabled: true,
            subtitle: 'connectedServices.detail.groupActions.accountFallbackDisabled',
        }));
    });
});
