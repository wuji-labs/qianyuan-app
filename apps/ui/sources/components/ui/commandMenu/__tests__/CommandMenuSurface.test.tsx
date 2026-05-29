import * as React from 'react';
import { View } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenuSurface } from '../CommandMenuSurface';
import type { CommandMenuAnchor } from '../commandMenuTypes';

type CapturedPopoverProps = Readonly<{
    open: boolean;
    children: React.ReactNode | ((renderProps: Readonly<{ maxHeight: number; maxWidth: number; placement: string }>) => React.ReactNode);
    portal?: Readonly<{
        web?: boolean | Readonly<{ target?: string }>;
        native?: boolean;
        matchAnchorWidth?: boolean;
        anchorAlign?: string;
    }>;
}>;

const capturedPopoverProps: { current: CapturedPopoverProps | null } = { current: null };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Popover positioning/portaling is covered by the Popover suite; this surface test verifies
// the command menu passes the modal-aware portal contract into that positioning primitive.
vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
    },
    Popover: React.memo((props: CapturedPopoverProps) => {
        capturedPopoverProps.current = props;
        if (!props.open) return null;
        const content = typeof props.children === 'function'
            ? props.children({ maxHeight: 240, maxWidth: 400, placement: 'top' })
            : props.children;
        return React.createElement(View, { testID: 'command-menu-surface-popover' }, content);
    }),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: React.memo((props: { children: React.ReactNode }) => {
        return React.createElement(View, {}, props.children);
    }),
}));

const RECT_ANCHOR: CommandMenuAnchor = {
    kind: 'rect',
    rect: { left: 100, top: 200, height: 18 },
    coordinateSpace: 'window',
};

describe('CommandMenuSurface', () => {
    beforeEach(() => {
        capturedPopoverProps.current = null;
    });

    it('lets Popover choose the modal-aware web portal target', async () => {
        await renderScreen(
            <CommandMenuSurface
                open
                anchor={RECT_ANCHOR}
                onRequestClose={() => {}}
                testID="command-menu-surface"
            >
                <View testID="command-menu-content" />
            </CommandMenuSurface>,
        );

        expect(capturedPopoverProps.current?.portal).toEqual({
            web: true,
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
        });
    });
});
