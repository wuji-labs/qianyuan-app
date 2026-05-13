import React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import type { SessionFolderViewModeV1 } from './sessionFolderShellTypes';

export function SessionListViewMenuButton(props: Readonly<{
    folderViewMode: SessionFolderViewModeV1;
    onFolderViewModeChange: (mode: SessionFolderViewModeV1) => void;
    hideInactiveSessions: boolean;
    onHideInactiveSessionsChange: (next: boolean) => void;
    disabled?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const iconColor = props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary;

    const items = React.useMemo((): DropdownMenuItem[] => [
        {
            id: props.folderViewMode === 'tree' ? 'folder-view-off' : 'folder-view-tree',
            testID: 'session-folder-view-toggle',
            title: props.folderViewMode === 'tree'
                ? t('sessionsList.folderViewOff')
                : t('sessionsList.folderViewTree'),
            icon: <Ionicons name="folder-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: props.hideInactiveSessions ? 'show-inactive' : 'hide-inactive',
            title: props.hideInactiveSessions
                ? t('sessionsList.showInactiveSessions')
                : t('sessionsList.hideInactiveSessions'),
            icon: <Ionicons name="filter-outline" size={16} color={iconColor} />,
        },
    ], [iconColor, props.disabled, props.folderViewMode, props.hideInactiveSessions]);

    const handleSelect = React.useCallback((itemId: string) => {
        if (itemId === 'folder-view-tree') {
            props.onFolderViewModeChange('tree');
            return;
        }
        if (itemId === 'folder-view-off') {
            props.onFolderViewModeChange('off');
            return;
        }
        if (itemId === 'hide-inactive') {
            props.onHideInactiveSessionsChange(true);
            return;
        }
        if (itemId === 'show-inactive') {
            props.onHideInactiveSessionsChange(false);
        }
    }, [props]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={handleSelect}
            selectedId={props.folderViewMode === 'tree' ? 'folder-view-tree' : 'folder-view-off'}
            placement="left"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={260}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <Pressable
                    testID="session-list-ordering-menu-trigger"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionsList.viewOptions')}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        toggle();
                    }}
                    hitSlop={8}
                >
                    <Ionicons name="filter-outline" size={15} color={iconColor} />
                </Pressable>
            )}
        />
    );
}
