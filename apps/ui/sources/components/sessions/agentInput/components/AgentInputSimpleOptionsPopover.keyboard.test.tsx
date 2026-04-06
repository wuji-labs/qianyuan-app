import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

let capturedSurfaceProps: any = null;

vi.mock('@/components/sessions/agentInput/selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: any) => {
        // Render the popover body immediately; we only care about the surface wiring.
        return props.children({ maxHeight: 200 });
    },
}));

vi.mock('./AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: any) => {
        capturedSurfaceProps = props;
        return React.createElement('AgentInputPopoverSurface', props, props.children);
    },
}));

vi.mock('@/components/sessions/agentInput/selection/AgentInputSelectionSimpleList', () => ({
    AgentInputSelectionSimpleList: () => null,
}));

describe('AgentInputSimpleOptionsPopover', () => {
    it('uses keyboardShouldPersistTaps=\"always\" so the first tap works when the composer TextInput is focused (iOS)', async () => {
        capturedSurfaceProps = null;
        const { AgentInputSimpleOptionsPopover } = await import('./AgentInputSimpleOptionsPopover');

        await renderScreen(
            <AgentInputSimpleOptionsPopover
                open
                anchorRef={{ current: null }}
                title={null}
                options={[{ id: 'a', label: 'A' }]}
                selectedOptionId={null}
                onSelect={() => {}}
                onRequestClose={() => {}}
            />
        );

        expect(capturedSurfaceProps?.keyboardShouldPersistTaps).toBe('always');
    });
});
