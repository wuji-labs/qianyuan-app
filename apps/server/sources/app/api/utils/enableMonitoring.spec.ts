import Fastify from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify as HappierFastify } from '../types';

const mockQueryRaw = vi.fn();

vi.mock('@/storage/db', () => ({
    db: { $queryRaw: mockQueryRaw },
}));

// Logging is a process-output boundary; keep expected failure-path tests quiet.
vi.mock('@/utils/logging/log', () => ({
    log: vi.fn(),
}));

function createMonitoringApp(): HappierFastify {
    return Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
}

describe('enableMonitoring (unit)', () => {
    const originalDbReadinessTimeoutMs = process.env.HAPPIER_DB_READINESS_TIMEOUT_MS;

    beforeEach(() => {
        mockQueryRaw.mockReset();
    });

    afterEach(() => {
        if (originalDbReadinessTimeoutMs === undefined) {
            delete process.env.HAPPIER_DB_READINESS_TIMEOUT_MS;
        } else {
            process.env.HAPPIER_DB_READINESS_TIMEOUT_MS = originalDbReadinessTimeoutMs;
        }
        vi.useRealTimers();
    });

    it('returns process liveness for /live without querying the database', async () => {
        mockQueryRaw.mockRejectedValue(new Error('SQLITE_CANTOPEN: cannot open database'));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/live' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { status?: string; timestamp?: string; service?: string };
            expect(body.status).toBe('ok');
            expect(body.service).toBe('happier-server');
            expect(typeof body.timestamp).toBe('string');
            expect(mockQueryRaw).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it.each(['/health', '/ready', '/health/db'])('returns 503 with a database connectivity error body when %s query fails', async (url) => {
        mockQueryRaw.mockRejectedValueOnce(new Error('SQLITE_CANTOPEN: cannot open database'));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.error).toBe('Database connectivity failed');
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns 503 when database readiness exceeds the configured timeout', async () => {
        vi.useFakeTimers();
        process.env.HAPPIER_DB_READINESS_TIMEOUT_MS = '25';
        mockQueryRaw.mockReturnValueOnce(new Promise(() => {}));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const response = app.inject({ method: 'GET', url: '/ready' });
            await vi.advanceTimersByTimeAsync(25);

            const res = await response;
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.error).toBe('Database connectivity failed');
        } finally {
            await app.close().catch(() => {});
        }
    });
});
