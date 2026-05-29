import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import type { SessionEndMutationV1 } from './sessionMutationTypes';

vi.mock('axios');

const mutation = {
    v: 1,
    sessionId: 's1',
    mutationId: 'm1',
    source: 'session_end',
    observedAt: 1_000,
} satisfies SessionEndMutationV1;

describe('deliverSessionEndMutation', () => {
    beforeEach(() => {
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.get).mockRejectedValue(new Error('session-end proof unavailable'));
    });

    it('keeps connected session-end delivery unconfirmed when HTTP fails', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('offline'));
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'retryable',
            reason: 'session_end_http_unavailable',
        }));

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    });

    it('preserves legacy session-end emit without confirming unsupported HTTP delivery', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'unsupported_capability',
            reason: 'session_end_http_unsupported_without_legacy_proof',
        }));

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    });

    it('confirms unsupported HTTP session-end when legacy socket delivery is proven inactive from v1 list state', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        vi.mocked(axios.get)
            .mockRejectedValueOnce({ response: { status: 404 } })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    sessions: [
                        { id: 's1', active: false },
                    ],
                },
            } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'delivered',
            path: 'legacy_socket_proof',
        }));

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
        expect(vi.mocked(axios.get).mock.calls.map(([url]) => String(url))).toEqual([
            expect.stringContaining('/v2/sessions/s1'),
            expect.stringContaining('/v1/sessions'),
        ]);
    });

    it('confirms legacy session-end proof when unsupported HTTP uses a direct status shape', async () => {
        vi.mocked(axios.post).mockRejectedValue({ status: 501 });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: { session: { id: 's1', active: false } },
        } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'delivered',
            path: 'legacy_socket_proof',
        }));

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
        expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toEqual(expect.stringContaining('/v2/sessions/s1'));
    });

    it('keeps unsupported HTTP session-end unconfirmed when proof still shows the session active', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: { session: { id: 's1', active: true } },
        } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'unsupported_capability',
            reason: 'session_end_http_unsupported_without_legacy_proof',
        }));

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
    });

    it('throws authentication errors from HTTP confirmation', async () => {
        const authError = { response: { status: 401 } };
        vi.mocked(axios.post).mockRejectedValue(authError);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).rejects.toBe(authError);

        expect(socket.emit).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
    });

    it('confirms disconnected session-end delivery through HTTP', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: true } } as never);
        const socket = {
            connected: false,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'delivered',
            path: 'http',
        }));

        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual({ time: 1_000 });
    });

    it('confirms accepted no-op HTTP session-end responses', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: false } } as never);
        const socket = {
            connected: false,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'delivered',
            path: 'http',
        }));
    });
});
