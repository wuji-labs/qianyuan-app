import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createPartialStorageModuleMock,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionListGroupOrderV1 = vi.fn();
const setCollapsedGroupKeysV1 = vi.fn();
const setSessionFolderViewModeV1 = vi.fn();
const setSessionFoldersV1 = vi.fn();
const setSessionTagsV1 = vi.fn();
const modalPromptSpy = vi.hoisted(() => vi.fn(async () => null as string | null));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => false));
const useSessionInlineDragSpy = vi.hoisted(() => vi.fn((params: any) => ({
    gesture: undefined,
    animatedStyle: params ? {} : {},
})));
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn(async () => ({ accessToken: 'token-a' })));
const getServerProfileByIdSpy = vi.hoisted(() => vi.fn((serverId: string) => serverId === 'server_a'
    ? { id: 'server_a', serverUrl: 'https://server-a.test' }
    : null));
const setSessionFolderAssignmentSpy = vi.hoisted(() => vi.fn(async () => undefined));
const moveSessionFolderAssignmentsSpy = vi.hoisted(() => vi.fn(async () => undefined));

let sessionFolderViewModeV1: 'off' | 'tree' = 'tree';
let sessionFoldersV1: any = { v: 1, folders: [] };
let collapsedGroupKeysV1: Record<string, boolean> = {};
let mockVisibleSessionListViewData: any[] = [];

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value.web ?? value.default },
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ...rest }: any) =>
                React.createElement(
                    'FlatList',
                    { ...rest },
                    ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
                    (data ?? []).map((item: any, index: number) => {
                        const key = keyExtractor ? keyExtractor(item, index) : String(index);
                        return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                    }),
                    ListFooterComponent ? React.createElement(ListFooterComponent) : null,
                ),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '', router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalPromptSpy as any,
                confirm: modalConfirmSpy as any,
            },
        }).module;
    },
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useProfile: () => ({ id: 'profile-1' }),
        useSetting: (key: string) => {
            if (key === 'hideInactiveSessions') return false;
            if (key === 'sessionTagsEnabled') return false;
            if (key === 'sessionListDensity') return 'default';
            if (key === 'rememberLastProjectSessionSelections') return false;
            if (key === 'sessionFolderViewModeV1') return sessionFolderViewModeV1;
            if (key === 'sessionFoldersV1') return sessionFoldersV1;
            return null;
        },
        useSettingMutable: (key: string) => {
            if (key === 'sessionListGroupOrderV1') return [{}, setSessionListGroupOrderV1];
            if (key === 'collapsedGroupKeysV1') return [collapsedGroupKeysV1, setCollapsedGroupKeysV1];
            if (key === 'sessionFolderViewModeV1') return [sessionFolderViewModeV1, setSessionFolderViewModeV1];
            if (key === 'sessionFoldersV1') return [sessionFoldersV1, setSessionFoldersV1];
            if (key === 'sessionTagsV1') return [{}, setSessionTagsV1];
            if (key === 'pinnedSessionKeysV1') return [[], vi.fn()];
            if (key === 'workspaceLabelsV1') return [{}, vi.fn()];
            return [null, vi.fn()];
        },
        useLocalSettingMutable: () => [[], vi.fn()],
    }),
});

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedStyle: (fn: () => any) => fn(),
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureDetector: 'GestureDetector',
    Swipeable: 'Swipeable',
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: ['server_a'],
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => mockVisibleSessionListViewData,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: getServerProfileByIdSpy,
}));

vi.mock('@/sync/ops/sessionFolders', () => ({
    setSessionFolderAssignment: setSessionFolderAssignmentSpy,
    moveSessionFolderAssignments: moveSessionFolderAssignmentsSpy,
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({
                open: props.open,
                toggle: vi.fn(),
                openMenu: vi.fn(),
                closeMenu: vi.fn(),
                selectedItem: null,
            })
            : props.trigger ?? null,
    ),
}));

vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: (params: any) => useSessionInlineDragSpy(params),
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', {
        ...props,
        testID: `session-list-session:${String(props.session?.id ?? 'unknown')}`,
    }),
}));

const workspace = { t: 'workspaceScope', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' };
const projectGroupKey = 'server:server_a:active:project:project_a';
const folderGroupKey = `${projectGroupKey}:folder:folder_a`;
const sessionA = { id: 'sess_a', createdAt: 1, active: true, presence: 'online', metadata: null };
const sessionB = { id: 'sess_b', createdAt: 2, active: true, presence: 'online', metadata: null };

function resetFolderData() {
    mockVisibleSessionListViewData = [
        { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active', serverId: 'server_a' },
        {
            type: 'header',
            title: '~/repo',
            headerKind: 'project',
            groupKey: projectGroupKey,
            workspaceKey: 'project_a',
            workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            serverId: 'server_a',
        },
        {
            type: 'header',
            title: 'Planning',
            headerKind: 'folder',
            groupKey: folderGroupKey,
            workspace,
            renderWorkspaceKey: 'project_a',
            folderId: 'folder_a',
            parentFolderId: null,
            depth: 1,
            sessionCount: 47,
            serverId: 'server_a',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey: folderGroupKey,
            groupKind: 'folder',
            folderId: 'folder_a',
            folderDepth: 1,
            serverId: 'server_a',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey: projectGroupKey,
            groupKind: 'project',
            folderId: null,
            folderDepth: 0,
            serverId: 'server_a',
        },
    ];
}

async function renderSessionsList() {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList />);
}

describe('SessionsList session folders shell', () => {
    beforeEach(() => {
        sessionFolderViewModeV1 = 'tree';
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder_a',
                workspace,
                renderWorkspaceKey: 'project_a',
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        collapsedGroupKeysV1 = {};
        setSessionListGroupOrderV1.mockClear();
        setCollapsedGroupKeysV1.mockClear();
        setSessionFolderViewModeV1.mockClear();
        setSessionFoldersV1.mockClear();
        setSessionTagsV1.mockClear();
        modalPromptSpy.mockReset();
        modalPromptSpy.mockResolvedValue(null);
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(false);
        useSessionInlineDragSpy.mockClear();
        getCredentialsForServerUrlSpy.mockClear();
        getServerProfileByIdSpy.mockClear();
        setSessionFolderAssignmentSpy.mockClear();
        moveSessionFolderAssignmentsSpy.mockClear();
        resetFolderData();
        standardCleanup();
    });

    it('renders folder headers with stable e2e ids', async () => {
        const screen = await renderSessionsList();

        expect(screen.findByTestId('session-folder-header-folder_a')).toBeTruthy();
        expect(screen.findByTestId('session-folder-reorder-handle-folder_a')).toBeTruthy();
        expect(screen.findByTestId('session-folder-menu-trigger-folder_a')).toBeTruthy();
        expect(screen.findByTestId('session-folder-drop-target-folder_a')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('47');
    });

    it('attaches the folder drag gesture on web', async () => {
        const folderGesture = { __kind: 'folder-gesture' };
        useSessionInlineDragSpy.mockImplementation((params: any): any => ({
            gesture: params?.sessionKey === 'folder:folder_a' ? folderGesture : undefined,
            animatedStyle: {},
        }));

        const screen = await renderSessionsList();

        expect(screen.root.findAllByType('GestureDetector').some((node) => node.props.gesture === folderGesture)).toBe(true);
    });

    it('focuses a folder and renders breadcrumbs above the list sections', async () => {
        const screen = await renderSessionsList();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-folder-header-folder_a'),
                'onPress',
                undefined,
                'expected folder header',
            );
        });

        expect(screen.findByTestId('session-folder-breadcrumb')).toBeTruthy();
        expect(screen.findByTestId('session-folder-clear-focus')).toBeTruthy();
        expect(screen.findByTestId(`session-list-project-header:${projectGroupKey}`)).toBeTruthy();
        expect(screen.findByTestId('session-list-session:sess_a')).toBeTruthy();
        expect(screen.findByTestId('session-list-session:sess_b')).toBeNull();
    });

    it('renders the view menu with a folder view toggle on primary section headers', async () => {
        const screen = await renderSessionsList();

        const menu = screen.findByTestId('session-list-ordering-menu-trigger');
        expect(menu).toBeTruthy();
        const dropdown = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.testID === 'session-folder-view-toggle'));

        expect(dropdown).toBeTruthy();
        expect(dropdown?.props.selectedId).toBe('folder-view-tree');

        dropdown?.props.onSelect('folder-view-off');
        expect(setSessionFolderViewModeV1).toHaveBeenCalledWith('off');
    });

    it('passes folder indentation and move menu options to session rows', async () => {
        const screen = await renderSessionsList();

        const folderRow = screen.findByTestId('session-list-session:sess_a');
        expect(folderRow?.props.folderDepth).toBe(1);
        expect(folderRow?.props.folderMoveMenuItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'move-to-folder:folder_a' }),
                expect.objectContaining({ id: 'move-to-folder:null' }),
            ]),
        );
    });

    it('passes drag/drop assignment hooks into the inline drag handler', async () => {
        await renderSessionsList();

        expect(useSessionInlineDragSpy).toHaveBeenCalledWith(expect.objectContaining({
            resolveDropIntent: expect.any(Function),
            onDropIntent: expect.any(Function),
        }));
    });

    it('persists a row menu move through the row server assignment op', async () => {
        const screen = await renderSessionsList();
        const row = screen.findByTestId('session-list-session:sess_b');

        await act(async () => {
            row?.props.onSelectFolderMoveMenuItem('move-to-folder:folder_a');
        });

        expect(getServerProfileByIdSpy).toHaveBeenCalledWith('server_a');
        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith('https://server-a.test', { serverId: 'server_a' });
        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith({
            credentials: { accessToken: 'token-a' },
            serverId: 'server_a',
            serverUrl: 'https://server-a.test',
            sessionId: 'sess_b',
            folderId: 'folder_a',
        });
    });

    it('persists folder drop intent through the row server assignment op', async () => {
        await renderSessionsList();
        const dragParams = useSessionInlineDragSpy.mock.calls
            .map((call) => call[0])
            .find((params) => params?.sessionKey === 'server_a:sess_b');

        await act(async () => {
            dragParams.onDropIntent({
                sessionKey: 'server_a:sess_b',
                groupKey: projectGroupKey,
                positionDelta: 0,
                intent: { kind: 'moveToFolder', folderId: 'folder_a' },
            });
        });

        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server_a',
            serverUrl: 'https://server-a.test',
            sessionId: 'sess_b',
            folderId: 'folder_a',
        }));
    });

    it('moves folder headers through the folder drag/drop hook', async () => {
        sessionFoldersV1 = {
            v: 1,
            folders: [
                ...sessionFoldersV1.folders,
                {
                    id: 'folder_b',
                    workspace,
                    renderWorkspaceKey: 'project_a',
                    parentId: null,
                    name: 'Archive',
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };
        await renderSessionsList();
        const dragParams = useSessionInlineDragSpy.mock.calls
            .map((call) => call[0])
            .find((params) => params?.sessionKey === 'folder:folder_a');

        await act(async () => {
            dragParams.onDropIntent({
                sessionKey: 'folder:folder_a',
                groupKey: folderGroupKey,
                positionDelta: 0,
                intent: { kind: 'moveToFolder', folderId: 'folder_b' },
            });
        });

        expect(setSessionFoldersV1).toHaveBeenCalledWith(expect.objectContaining({
            folders: expect.arrayContaining([
                expect.objectContaining({ id: 'folder_a', parentId: 'folder_b' }),
            ]),
        }));
    });

    it('resolves dragging a folder session into workspace root rows as an unassign intent', async () => {
        await renderSessionsList();
        const dragParams = useSessionInlineDragSpy.mock.calls
            .map((call) => call[0])
            .find((params) => params?.sessionKey === 'server_a:sess_a');

        const intent = dragParams.resolveDropIntent({
            sessionKey: 'server_a:sess_a',
            groupKey: folderGroupKey,
            positionDelta: 1,
            dataIndex: 3,
            absoluteX: null,
            absoluteY: null,
        });

        expect(intent).toEqual({
            kind: 'moveToWorkspaceRoot',
            order: {
                groupKey: projectGroupKey,
                afterKey: 'server_a:sess_b',
            },
        });
    });

    it('moves a folder session to the workspace root before the first root folder when dropped on that line', async () => {
        await renderSessionsList();
        const dragParams = useSessionInlineDragSpy.mock.calls
            .map((call) => call[0])
            .find((params) => params?.sessionKey === 'server_a:sess_a');

        await act(async () => {
            dragParams.onDropIntent({
                sessionKey: 'server_a:sess_a',
                groupKey: folderGroupKey,
                positionDelta: -1,
                intent: dragParams.resolveDropIntent({
                    sessionKey: 'server_a:sess_a',
                    groupKey: folderGroupKey,
                    positionDelta: -1,
                    dataIndex: 3,
                    absoluteX: null,
                    absoluteY: null,
                }),
            });
        });

        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_a',
            folderId: null,
        }));
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith(expect.objectContaining({
            [projectGroupKey]: ['server_a:sess_a', 'folder:folder_a', 'server_a:sess_b'],
        }));
    });

    it('creates a root folder from the workspace menu', async () => {
        modalPromptSpy.mockResolvedValueOnce('Roadmap');
        const screen = await renderSessionsList();
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId(`session-list-project-header:${projectGroupKey}`),
                'onHoverIn',
                undefined,
                'expected project header',
            );
        });
        const workspaceMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'add-folder'));

        await act(async () => {
            await workspaceMenu?.props.onSelect('add-folder');
        });

        expect(setSessionFoldersV1).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            folders: expect.arrayContaining([
                expect.objectContaining({
                    name: 'Roadmap',
                    parentId: null,
                    workspace,
                    renderWorkspaceKey: 'project_a',
                }),
            ]),
        }));
    });

    it('creates and renames subfolders from the folder menu', async () => {
        const screen = await renderSessionsList();
        const folderMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'add-subfolder'));

        modalPromptSpy.mockResolvedValueOnce('Implementation');
        await act(async () => {
            await folderMenu?.props.onSelect('add-subfolder');
        });
        expect(setSessionFoldersV1).toHaveBeenCalledWith(expect.objectContaining({
            folders: expect.arrayContaining([
                expect.objectContaining({ name: 'Implementation', parentId: 'folder_a' }),
            ]),
        }));

        setSessionFoldersV1.mockClear();
        modalPromptSpy.mockResolvedValueOnce('Renamed planning');
        await act(async () => {
            await folderMenu?.props.onSelect('rename');
        });
        expect(setSessionFoldersV1).toHaveBeenCalledWith(expect.objectContaining({
            folders: expect.arrayContaining([
                expect.objectContaining({ id: 'folder_a', name: 'Renamed planning' }),
            ]),
        }));
    });

    it('moves assignments before deleting a folder subtree', async () => {
        modalConfirmSpy.mockResolvedValueOnce(true);
        const screen = await renderSessionsList();
        const folderMenu = screen.findAllByType('DropdownMenu' as React.ElementType)
            .find((node) => node.props?.items?.some((item: any) => item.id === 'delete'));

        await act(async () => {
            await folderMenu?.props.onSelect('delete');
        });

        expect(moveSessionFolderAssignmentsSpy).toHaveBeenCalledWith({
            credentials: { accessToken: 'token-a' },
            serverId: 'server_a',
            serverUrl: 'https://server-a.test',
            fromFolderIds: ['folder_a'],
            toFolderId: null,
        });
        expect(setSessionFoldersV1).toHaveBeenCalledWith(expect.objectContaining({
            folders: [],
        }));
    });
});
