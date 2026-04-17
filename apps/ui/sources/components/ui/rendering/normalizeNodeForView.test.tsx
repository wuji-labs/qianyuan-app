import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (values: Record<string, unknown>) => values.ios ?? values.default ?? null,
        },
    });
});

describe('normalizeNodeForView', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('does not wrap non-text icon components (AgentIcon) in Text', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        function AgentIcon(_props: any) {
            return null;
        }
        AgentIcon.displayName = 'AgentIcon';

        const node = React.createElement(AgentIcon, { size: 14 });
        const normalized = normalizeNodeForView(node);

        // If we wrapped this element, we'd get a different React element.
        expect(normalized).toBe(node);
    });

    it('does not wrap icon-like components in Text', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        function Ionicons(_props: any) {
            return null;
        }
        Ionicons.displayName = 'Ionicons';

        const node = React.createElement(Ionicons, { name: 'flash-outline', size: 16 });
        const normalized = normalizeNodeForView(node);

        expect(normalized).toBe(node);
    });
});
