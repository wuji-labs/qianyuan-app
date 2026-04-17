import type { IModal } from '@/modal';
import { describe, expect, it, vi } from 'vitest';

const showModalMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: showModalMock,
        },
    }).module;
});

describe('openMachinePathBrowserModal', () => {
    it('opens the path browser without modal-card chrome so it renders its own inline modal shell', async () => {
        const { openMachinePathBrowserModal } = await import('./openMachinePathBrowserModal');

        const promise = openMachinePathBrowserModal({
            machineId: 'machine-1',
            serverId: 'server-1',
            title: 'Pick a working directory',
        });

        expect(showModalMock).toHaveBeenCalledTimes(1);
        const firstCall = showModalMock.mock.calls[0];
        if (!firstCall) {
            throw new Error('Expected Modal.show to be called');
        }
        const config = firstCall[0] as {
            chrome?: unknown;
            component?: unknown;
            props?: Record<string, unknown>;
            onRequestClose?: () => void;
        };

        expect(config.chrome).toBeUndefined();
        expect(config.component).toBeTypeOf('function');
        expect(config.props).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            title: 'Pick a working directory',
            selectionMode: 'directory',
        }));

        config.onRequestClose?.();
        await expect(promise).resolves.toBeNull();
    });
});
