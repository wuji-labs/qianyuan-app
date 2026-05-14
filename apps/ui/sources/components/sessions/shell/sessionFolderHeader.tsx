import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionFolderHeaderItem } from './sessionFolderShellTypes';
import {
    measureSessionFolderDropTargetBounds,
    type SessionFolderDropTarget,
} from './sessionFolderDragDrop';

const FOLDER_INDENT_STEP = 6;
const FOLDER_INDENT_CAP = 3;

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 2,
        paddingBottom: 3,
    },
    row: {
        minHeight: 30,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderRadius: 8,
        alignSelf: 'stretch',
    },
    dropTarget: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        opacity: 0,
    },
    content: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    actionButton: {
        width: 22,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
    },
    hidden: {
        opacity: 0,
    },
    visible: {
        opacity: 1,
    },
}));

export function FolderGroupHeader(props: Readonly<{
    item: SessionFolderHeaderItem;
    collapsed: boolean;
    onToggleCollapse: () => void;
    onFocus: () => void;
    onNewSession: () => void;
    onAddSubfolder: () => void | Promise<void>;
    onRename: () => void | Promise<void>;
    onDelete: () => void | Promise<void>;
    onRegisterDropTarget?: (target: SessionFolderDropTarget) => void;
    onUnregisterDropTarget?: (id: string) => void;
    disabled?: boolean;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [actionsHovered, setActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showActions = !isWeb || hovered || actionsHovered || menuOpen;
    const iconColor = props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary;
    const indent = Math.min(Math.max(0, props.item.depth), FOLDER_INDENT_CAP) * FOLDER_INDENT_STEP;
    const rowRef = React.useRef<View | null>(null);
    const dropTargetId = `folder:${props.item.folderId}`;

    React.useEffect(() => {
        return () => {
            props.onUnregisterDropTarget?.(dropTargetId);
        };
    }, [dropTargetId, props.onUnregisterDropTarget]);

    const menuItems = React.useMemo((): DropdownMenuItem[] => [
        {
            id: 'new-session',
            title: t('sessionsList.newSessionInFolder'),
            icon: <Ionicons name="add-circle-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'add-subfolder',
            title: t('sessionsList.addSubfolder'),
            icon: <Ionicons name="folder-open-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'rename',
            title: t('sessionsList.renameFolder'),
            icon: <Ionicons name="pencil-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'move',
            title: t('sessionsList.moveFolder'),
            icon: <Ionicons name="arrow-forward-circle-outline" size={16} color={iconColor} />,
            disabled: true,
        },
        {
            id: 'delete',
            title: t('sessionsList.deleteFolder'),
            icon: <Ionicons name="trash-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
    ], [iconColor, props.disabled]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (props.disabled) return;
        if (itemId === 'new-session') {
            props.onNewSession();
        } else if (itemId === 'add-subfolder') {
            await props.onAddSubfolder();
        } else if (itemId === 'rename') {
            await props.onRename();
        } else if (itemId === 'delete') {
            await props.onDelete();
        }
    }, [props]);

    return (
        <View style={styles.section}>
            <View
                ref={rowRef as React.Ref<View>}
                testID={`session-folder-header-${props.item.folderId}`}
                style={[styles.row, { paddingLeft: indent }]}
                onLayout={(event) => {
                    const layout = event.nativeEvent.layout;
                    void measureSessionFolderDropTargetBounds({
                        ref: rowRef.current,
                        fallback: {
                            x: layout.x,
                            y: layout.y,
                            width: layout.width,
                            height: layout.height,
                        },
                    }).then((bounds) => props.onRegisterDropTarget?.({
                        id: dropTargetId,
                        kind: 'folder',
                        folderId: props.item.folderId,
                        workspace: props.item.workspace,
                        bounds,
                    }));
                }}
                onPointerEnter={isWeb ? () => setHovered(true) : undefined}
                onPointerLeave={isWeb ? () => setHovered(false) : undefined}
            >
                <View
                    pointerEvents="none"
                    testID={`session-folder-drop-target-${props.item.folderId}`}
                    style={styles.dropTarget}
                />
                <Pressable
                    style={styles.actionButton}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        props.onToggleCollapse();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={props.collapsed ? t('common.expand') : t('common.collapse')}
                    hitSlop={8}
                >
                    <Ionicons
                        name={props.collapsed ? 'chevron-forward' : 'chevron-down'}
                        size={12}
                        color={iconColor}
                    />
                </Pressable>
                <Pressable
                    style={styles.content}
                    accessibilityRole="button"
                    accessibilityLabel={props.item.title}
                    disabled={props.disabled}
                    onPress={props.disabled ? undefined : props.onFocus}
                >
                    <Ionicons name="folder-outline" size={14} color={iconColor} />
                    <Text style={styles.title} numberOfLines={1}>{props.item.title}</Text>
                </Pressable>
                <View
                    onPointerEnter={isWeb ? () => setActionsHovered(true) : undefined}
                    onPointerLeave={isWeb ? () => setActionsHovered(false) : undefined}
                >
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={menuItems}
                        onSelect={handleMenuSelect}
                        placement="left"
                        variant="slim"
                        matchTriggerWidth={false}
                        maxWidthCap={240}
                        showCategoryTitles={false}
                        popoverPortalWebTarget="body"
                        trigger={({ toggle }) => (
                            <Pressable
                                testID={`session-folder-menu-trigger-${props.item.folderId}`}
                                style={[styles.actionButton, showActions ? styles.visible : styles.hidden]}
                                onPress={(event) => {
                                    event?.stopPropagation?.();
                                    toggle();
                                }}
                                onHoverIn={isWeb ? () => setActionsHovered(true) : undefined}
                                onHoverOut={isWeb ? () => setActionsHovered(false) : undefined}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.moreActions')}
                                hitSlop={8}
                            >
                                <Octicons name="kebab-horizontal" size={12} color={iconColor} />
                            </Pressable>
                        )}
                    />
                </View>
            </View>
        </View>
    );
}
