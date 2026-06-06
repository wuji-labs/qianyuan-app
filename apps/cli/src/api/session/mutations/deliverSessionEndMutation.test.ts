import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import type { SessionEndMutationV1 } from './sessionMutationTypes';
import type { SessionMutationDeliveryOutcome } from './sessionMutationOutboxFailureHandling';

vi.mock('axios');

const mutation = {
    v: 1,
    sessionId: 's1',
    mutationId: 'm1',
    source: 'session_end',
    observedAt: 1_000,
} satisfies SessionEndMutationV1;

const originalSessionEndDeliveryConcurrency = process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY;

describe('deliverSessionEndMutation', () => {
    beforeEach(() => {
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.get).mockRejectedValue(new Error('session-end proof unavailable'));
    });

    afterEach(() => {
        if (originalSessionEndDeliveryConcurrency === undefined) {
            delete process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY;
        } else {
            process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY = originalSessionEndDeliveryConcurrency;
        }
    });

    it('uses HTTP as the primary path without duplicate legacy socket delivery when HTTP succeeds', async () => {
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: true } } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'delivered',
            path: 'http',
        }));

        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    });

    it('limits concurrent session-end deliveries across outboxes', async () => {
        process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY = '1';
        let active = 0;
        let maxActive = 0;
        const releases: Array<() => void> = [];
        vi.mocked(axios.post).mockImplementation(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => {
                releases.push(resolve);
            });
            active -= 1;
            return { status: 200, data: { success: true, applied: true } } as never;
        });
        const socket = {
            connected: false,
            emit: vi.fn(),
        };
        const secondMutation = { ...mutation, sessionId: 's2', mutationId: 'm2' } satisfies SessionEndMutationV1;

        const first = deliverSessionEndMutation({ token: 'tok', socket, mutation });
        const second = deliverSessionEndMutation({ token: 'tok', socket, mutation: secondMutation });

        await expect.poll(() => releases.length).toBe(1);
        expect(maxActive).toBe(1);
        releases.shift()?.();
        await first;
        await expect.poll(() => releases.length).toBe(1);
        expect(maxActive).toBe(1);
        releases.shift()?.();
        await second;
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

        expect(socket.emit).not.toHaveBeenCalled();
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

    it('confirms unsupported HTTP session-end from the socket acknowledgement before proof polling', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        vi.mocked(axios.get).mockResolvedValue({
            status: 200,
            data: { session: { id: 's1', active: true } },
        } as never);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                applied: true,
                time: 1_000,
                active: false,
                activeAt: null,
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastRuntimeIssue: null,
            })),
        };

        const outcome = await deliverSessionEndMutation({ token: 'tok', socket, mutation });
        const outboxOutcome: SessionMutationDeliveryOutcome = outcome;

        expect(outboxOutcome).toEqual(expect.objectContaining({
            status: 'delivered',
            path: 'legacy_socket_ack',
        }));

        expect(socket.emitWithAck).toHaveBeenCalledWith('session-end', { sid: 's1', time: 1_000 });
        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
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

        expect(socket.emit).not.toHaveBeenCalled();
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

    it('keeps disconnected unsupported HTTP session-end retryable until legacy socket fallback can run', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = {
            connected: false,
            emit: vi.fn(),
        };

        await expect(deliverSessionEndMutation({ token: 'tok', socket, mutation })).resolves.toEqual(expect.objectContaining({
            status: 'retryable',
            reason: 'session_end_http_unavailable',
        }));

        expect(socket.emit).not.toHaveBeenCalled();
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
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
