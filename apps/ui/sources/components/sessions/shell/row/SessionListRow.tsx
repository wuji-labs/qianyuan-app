import React from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';

import type {
    TreeDropResult,
    TreeInstructionVisual,
} from '@/components/ui/treeDragDrop';
import { SessionItem } from '../SessionItem';
import {
    useSessionInlineDrag,
    type SessionInlineDragVisualSharedValues,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolveDropResultEvent,
} from '../useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from '../SessionListHeaderFrame';
import { SessionListDropIndicator } from '../SessionListDropIndicator';

export type SessionListRowProps = Readonly<
    React.ComponentProps<typeof SessionItem> & {
        sessionKey: string | null;
        treeRowId: string;
        groupKey: string;
        onDragStart: (sessionKey: string) => void;
        resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => TreeDropResult;
        onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
        onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
        isDragActive: boolean;
        isBeingDragged: boolean;
        dataIndex: number;
        dropVisual: SessionInlineDragVisualSharedValues;
        activeDropVisual: TreeInstructionVisual;
        onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
        onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    }
>;

export const SessionListRow = React.memo(function SessionListRow(props: SessionListRowProps) {
    const {
        sessionKey,
        treeRowId,
        groupKey,
        onDragStart,
        onDropResult,
        onDragUpdate,
        resolveDropResult,
        isDragActive,
        isBeingDragged,
        dataIndex,
        dropVisual,
        activeDropVisual,
        onRegisterTreeRowBounds,
        onUnregisterTreeRowBounds,
        ...itemProps
    } = props;

    const wrapperRef = React.useRef<View>(null);

    const getCellWrapper = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        const el = wrapperRef.current as any;
        if (!el || typeof el !== 'object' || !('parentElement' in el)) return null;
        return el.parentElement as HTMLElement | null;
    }, []);

    const handleDragStart = React.useCallback((sk: string) => {
        if (typeof itemProps.onNativeContextMenuOpenChange === 'function') {
            itemProps.onNativeContextMenuOpenChange(false);
        }
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        }
        onDragStart(sk);
    }, [getCellWrapper, itemProps.onNativeContextMenuOpenChange, onDragStart]);

    const handleDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
        onDropResult(event);
    }, [getCellWrapper, onDropResult]);

    const isWeb = Platform.OS === 'web';
    const isIos = Platform.OS === 'ios';
    const isNative = Platform.OS !== 'web';
    const inlineDragEnabled = true;
    const onNativeContextMenuOpenChange = itemProps.onNativeContextMenuOpenChange;
    const handleLongPressActivated = React.useCallback(() => {
        if (isWeb || typeof onNativeContextMenuOpenChange !== 'function' || isDragActive) return;
        onNativeContextMenuOpenChange(true);
    }, [isDragActive, isWeb, onNativeContextMenuOpenChange]);

    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled: inlineDragEnabled,
        sessionKey,
        groupKey,
        onDragStart: handleDragStart,
        onDropResult: handleDropResult,
        onDragUpdate,
        resolveDropResult,
        dataIndex,
        dropVisual,
        activateAfterLongPressMs: isWeb ? undefined : 350,
        onLongPressActivated: !isWeb && typeof onNativeContextMenuOpenChange === 'function'
            ? () => handleLongPressActivated()
            : undefined,
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const cellWrapper = getCellWrapper();
        if (!cellWrapper) return;
        if (isBeingDragged) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        } else {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
    }, [isBeingDragged, getCellWrapper]);

    React.useEffect(() => {
        return () => {
            onUnregisterTreeRowBounds(treeRowId);
        };
    }, [onUnregisterTreeRowBounds, treeRowId]);

    const rowPointerEvents = Platform.OS === 'web' && isDragActive && !isBeingDragged
        ? 'none' as const
        : 'auto' as const;

    const sessionItem = (
        <SessionItem
            {...itemProps}
            reorderHandleGesture={isWeb ? gesture : undefined}
            isBeingDragged={isBeingDragged}
        />
    );

    const rowNode = (
        <Animated.View
            ref={wrapperRef}
            collapsable={false}
            style={animatedStyle}
            pointerEvents={rowPointerEvents}
            onLayout={() => onRegisterTreeRowBounds(treeRowId, wrapperRef.current)}
        >
            <SessionListDropIndicator
                targetId={treeRowId}
                visual={activeDropVisual}
            />
            {sessionItem}
        </Animated.View>
    );

    if (isNative && gesture) {
        return (
            <GestureDetector gesture={gesture}>
                {rowNode}
            </GestureDetector>
        );
    }

    return rowNode;
});
