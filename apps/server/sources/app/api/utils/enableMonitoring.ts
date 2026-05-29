import { db } from "@/storage/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram } from "@/app/monitoring/metrics2";
import { log } from "@/utils/logging/log";

const MONITORING_SERVICE_NAME = 'happier-server';
const DB_READINESS_ERROR = 'Database connectivity failed';
const DB_READINESS_TIMEOUT_MS_ENV = 'HAPPIER_DB_READINESS_TIMEOUT_MS';
const DEFAULT_DB_READINESS_TIMEOUT_MS = 1_000;

class DbReadinessTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Database readiness check timed out after ${timeoutMs}ms`);
        this.name = 'DbReadinessTimeoutError';
    }
}

function resolveDbReadinessTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = env[DB_READINESS_TIMEOUT_MS_ENV];
    if (configured === undefined || configured.trim() === '') {
        return DEFAULT_DB_READINESS_TIMEOUT_MS;
    }

    const parsed = Number(configured);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DB_READINESS_TIMEOUT_MS;
}

async function withDbReadinessTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new DbReadinessTimeoutError(timeoutMs));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

function createHealthyMonitoringResponse() {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: MONITORING_SERVICE_NAME,
    };
}

async function checkDatabaseReadiness() {
    await withDbReadinessTimeout(db.$queryRaw`SELECT 1`, resolveDbReadinessTimeoutMs());
}

export function enableMonitoring(app: Fastify) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status }, duration);
    });

    const livenessHandler = async (_request: FastifyRequest) => createHealthyMonitoringResponse();

    const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
            await checkDatabaseReadiness();
            reply.send(createHealthyMonitoringResponse());
        } catch (error) {
            log({ module: 'health', level: 'error' }, `Health check failed: ${error}`);
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: MONITORING_SERVICE_NAME,
                error: DB_READINESS_ERROR
            });
        }
    };

    app.get('/health', readinessHandler);
    app.get('/live', livenessHandler);
    app.get('/ready', readinessHandler);
    app.get('/health/db', readinessHandler);
}
