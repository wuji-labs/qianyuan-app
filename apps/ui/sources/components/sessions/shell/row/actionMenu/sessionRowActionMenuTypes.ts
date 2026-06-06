import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';

export type SessionRowMoreMenuBuildParams = Readonly<{
    target: SessionActionTarget;
    iconColor: string;
    folderMoveMenuItems?: readonly DropdownMenuItem[];
    canMoveToFolder?: boolean;
}>;

export type SessionRowActionMenuState = Readonly<{
    tagMenuItems: DropdownMenuItem[];
    handleTagMenuSelect: (tagId: string) => void;
    handleTagMenuCreate: (query: string) => void;
    moreMenuItems: DropdownMenuItem[];
    handleMoreMenuSelect: (itemId: string) => Promise<void>;
    contextMenuItems: DropdownMenuItem[];
    handleContextMenuSelect: (itemId: string) => void;
    mutatingSession: boolean;
}>;
