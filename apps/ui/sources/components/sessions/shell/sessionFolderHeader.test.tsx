import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { FolderGroupHeader } from './sessionFolderHeader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

function childTreeContainsType(root: ReactTestInstance, type: string): boolean {
    return root.children.some((child) => (
        typeof child === 'object'
        && child !== null
        && (
            child.type === type
            || childTreeContainsType(child, type)
        )
    ));
}

function flattenStyleValue(style: unknown, key: string): unknown {
    if (Array.isArray(style)) {
        return style.reduce<unknown>((value, entry) => {
            const next = flattenStyleValue(entry, key);
            return next === undefined ? value : next;
        }, undefined);
    }
    if (style && typeof style === 'object' && key in style) {
        return (style as Record<string, unknown>)[key];
    }
    return undefined;
}

describe('FolderGroupHeader', () => {
    it('starts first-level folders with the workspace child indentation', async () => {
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        const dropTarget = screen.findByTestId('session-folder-drop-target-folder-a');
        expect(dropTarget).not.toBeNull();
        if (!dropTarget) throw new Error('expected folder drop target');

        expect(flattenStyleValue(dropTarget.parent?.props.style, 'paddingLeft')).toBe(20);
    });

    it('does not nest pressable controls inside another pressable on web', async () => {
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        for (const pressable of screen.findAllByType('Pressable' as never)) {
            expect(childTreeContainsType(pressable, 'Pressable')).toBe(false);
        }
    });

    it('shows the folder outline only while it is the active drop target', async () => {
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
                activeDropTargetId={null}
            />,
        );

        const dropTarget = screen.findByTestId('session-folder-drop-target-folder-a');
        expect(dropTarget).not.toBeNull();
        if (!dropTarget) throw new Error('expected folder drop target');
        expect(flattenStyleValue(dropTarget.props.style, 'opacity')).toBe(0);

        await act(async () => {
            dropTarget.parent?.props.onPointerEnter?.();
        });

        expect(flattenStyleValue(dropTarget.props.style, 'opacity')).toBe(0);

        await screen.update(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
                activeDropTargetId="folder:folder-a"
            />,
        );

        expect(flattenStyleValue(dropTarget.props.style, 'opacity')).toBe(1);
    });
});
