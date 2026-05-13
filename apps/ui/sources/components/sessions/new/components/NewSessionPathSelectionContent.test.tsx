import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { NewSessionPathSelectionContentProps } from './NewSessionPathSelectionContent';


type CapturedPathSelectionListProps = Readonly<Record<string, unknown>>;
const capturedPathSelectionListProps: CapturedPathSelectionListProps[] = [];

const itemListMountSpy = vi.fn();
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => {
        itemListMountSpy();
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('./PathSelectionList', () => ({
    PathSelectionList: (props: CapturedPathSelectionListProps) => {
        capturedPathSelectionListProps.push(props);
        return null;
    },
}));

describe('NewSessionPathSelectionContent', () => {
    it('delegates the popover layout to PathSelectionList, forwarding the seed/favorites/recents and the machine identity', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;
        const onCommit = vi.fn();

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit,
            recentPaths: ['/repo'],
            favoriteDirectories: ['~/proj'],
            machineId: 'm-1',
            serverId: 'srv-1',
            machinePlatform: 'unix',
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect(capturedPathSelectionListProps[0]).toMatchObject({
            initialValue: '/repo',
            machineHomeDir: '/home/me',
            machineId: 'm-1',
            serverId: 'srv-1',
            machinePlatform: 'unix',
            onCommit,
        });
        const captured = capturedPathSelectionListProps[0] as any;
        expect(captured.favorites).toEqual([{ path: '~/proj' }]);
        expect(captured.recents).toEqual([{ path: '/repo', lastUsedAt: expect.any(Number) }]);
    });

    it('forwards draft path edits before the path is committed', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;
        const onChangeDraftSelectedPath = vi.fn();

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            onChangeDraftSelectedPath,
            recentPaths: [],
            favoriteDirectories: [],
            machineId: 'm-1',
            machinePlatform: 'unix',
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        const onChangeDraftPath = (capturedPathSelectionListProps[0] as any).onChangeDraftPath;
        expect(typeof onChangeDraftPath).toBe('function');

        onChangeDraftPath('/repo/custom/subdir');

        expect(onChangeDraftSelectedPath).toHaveBeenCalledWith('/repo/custom/subdir');
    });

    it('does NOT wrap the path picker in an ItemList card (R6 Fix 2 — flat command-bar shell)', async () => {
        // The SelectionList primitive owns its own popover chrome (background,
        // radius, max-height); wrapping it in an ItemList gives a settings-list
        // "card inside a list" feel that breaks the premium command-bar
        // aesthetic. R6 removes the wrapper.
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');
        capturedPathSelectionListProps.length = 0;
        itemListMountSpy.mockClear();
        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            recentPaths: [],
            favoriteDirectories: [],
            machineId: 'm-1',
            machinePlatform: 'unix',
        } as any));
        expect(itemListMountSpy).not.toHaveBeenCalled();
    });

    it('freezes the synthesized recents lastUsedAt seed across rerenders even when the recentPaths array identity changes (R16d Fix 3)', async () => {
        // The synthesized timestamps must come from a frozen seed captured ONCE
        // (e.g. via useRef), not a fresh `Date.now()` per render. Otherwise,
        // when `recentPaths` is rebuilt by the parent on every render (a fresh
        // array literal with the same contents), the useMemo recomputes and
        // produces a NEW set of `lastUsedAt` values — feeding the resolver
        // identity invalidation cycle that R16a is fighting.
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        const baseProps = {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            favoriteDirectories: [],
            machineId: 'm-1',
            machinePlatform: 'unix' as const,
        };

        // First render: pass a fresh array literal.
        const screen = await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            ...baseProps,
            recentPaths: ['/repo', '/other'],
        } as any));

        // Wait at least 5ms so a `Date.now()` evaluated during the second render
        // would differ from the first render's `Date.now()`.
        await new Promise((resolve) => setTimeout(resolve, 5));

        // Re-render with a NEW array literal but the same contents.
        await screen.update(React.createElement(NewSessionPathSelectionContent, {
            ...baseProps,
            recentPaths: ['/repo', '/other'],
        } as any));

        expect(capturedPathSelectionListProps.length).toBeGreaterThanOrEqual(2);
        const first = (capturedPathSelectionListProps[0] as any).recents as Array<{ path: string; lastUsedAt: number }>;
        const second = (capturedPathSelectionListProps[capturedPathSelectionListProps.length - 1] as any).recents as Array<{ path: string; lastUsedAt: number }>;
        expect(first.map((r) => r.lastUsedAt)).toEqual(second.map((r) => r.lastUsedAt));
    });

    it('RUX-3: forwards the favorites toggle to PathSelectionList — isFavorite resolves the absolute path against favoriteDirectories', async () => {
        const onToggleFavoriteDirectory = vi.fn();
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/Users/leeroy',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            recentPaths: ['/Users/leeroy/recent'],
            // Mix shorthand + absolute to exercise resolution.
            favoriteDirectories: ['~/proj', '/Users/leeroy/abs-fav'],
            machineId: 'm-1',
            machinePlatform: 'unix',
            onToggleFavoriteDirectory,
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        const captured = capturedPathSelectionListProps[0] as any;
        // Both the shorthand and absolute favorites must be recognized as
        // favorites once resolved against the machine home dir.
        expect(typeof captured.isFavorite).toBe('function');
        expect(captured.isFavorite('/Users/leeroy/proj')).toBe(true);
        expect(captured.isFavorite('/Users/leeroy/abs-fav')).toBe(true);
        expect(captured.isFavorite('/Users/leeroy/recent')).toBe(false);
        // The toggle callback is forwarded so PathSelectionList rows can mutate.
        expect(typeof captured.onToggleFavorite).toBe('function');
        captured.onToggleFavorite('/Users/leeroy/recent');
        expect(onToggleFavoriteDirectory).toHaveBeenCalledWith('/Users/leeroy/recent');
    });

    it('RUX-3: treats Windows favorite paths with mixed separators and case as equivalent without matching home siblings', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        const props = {
            machineHomeDir: 'C:\\Users\\Alice',
            selectedPath: 'C:/Users/Alice/src/app',
            onCommit: vi.fn(),
            recentPaths: ['C:/Users/Alice/src/app'],
            favoriteDirectories: ['~\\src\\app', 'C:\\Users\\Alice\\ABS-FAV'],
            machineId: 'm-1',
            machinePlatform: 'windows',
            onToggleFavoriteDirectory: vi.fn(),
        } satisfies NewSessionPathSelectionContentProps;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, props));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        const captured = capturedPathSelectionListProps[0] as any;
        expect(typeof captured.isFavorite).toBe('function');
        expect(captured.isFavorite('C:/Users/Alice/src/app')).toBe(true);
        expect(captured.isFavorite('c:/users/alice/abs-fav')).toBe(true);
        expect(captured.isFavorite('C:/Users/Alice2/src/app')).toBe(false);
    });

    it('RUX-3: omits the favorites toggle callbacks when the orchestrator does not provide onToggleFavoriteDirectory', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/Users/leeroy',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            recentPaths: ['/Users/leeroy/recent'],
            favoriteDirectories: ['~/proj'],
            machineId: 'm-1',
            machinePlatform: 'unix',
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        const captured = capturedPathSelectionListProps[0] as any;
        expect(captured.onToggleFavorite).toBeUndefined();
        expect(captured.isFavorite).toBeUndefined();
    });

    it('RUX-8: forwards maxHeight to PathSelectionList so the popover body clamps to the available height', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            recentPaths: [],
            favoriteDirectories: [],
            machineId: 'm-1',
            machinePlatform: 'unix',
            maxHeight: 456,
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect((capturedPathSelectionListProps[0] as any).maxHeight).toBe(456);
    });

    it('RUX-8: omits maxHeight on PathSelectionList when none is provided (back-compat)', async () => {
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            recentPaths: [],
            favoriteDirectories: [],
            machineId: 'm-1',
            machinePlatform: 'unix',
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect((capturedPathSelectionListProps[0] as any).maxHeight).toBeUndefined();
    });

    it('forwards the pre-browse callback to PathSelectionList when provided', async () => {
        const onBeforeBrowseMachinePath = vi.fn();
        const { NewSessionPathSelectionContent } = await import('./NewSessionPathSelectionContent');

        capturedPathSelectionListProps.length = 0;

        await renderScreen(React.createElement(NewSessionPathSelectionContent, {
            machineHomeDir: '/home/me',
            selectedPath: '/repo',
            onCommit: vi.fn(),
            recentPaths: ['/repo'],
            favoriteDirectories: [],
            machineId: 'm-1',
            machinePlatform: 'unix',
            onBeforeBrowseMachinePath,
        } as any));

        expect(capturedPathSelectionListProps).toHaveLength(1);
        expect(capturedPathSelectionListProps[0]).toMatchObject({
            onBeforeBrowseMachinePath,
        });
    });
});
