import type { FastifyReply } from "fastify";

import {
    dbReadinessChecksCounter,
    dbReadinessDurationHistogram,
} from "@/app/monitoring/metrics2";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

const MONITORING_SERVICE_NAME = 'happier-server';
const DB_READINESS_ERROR = 'Database connectivity failed';
const DB_READINESS_TIMEOUT_MS_ENV = 'HAPPIER_DB_READINESS_TIMEOUT_MS';
const DEFAULT_DB_READINESS_TIMEOUT_MS = 1_000;

type DbReadinessResult = "ok" | "error";
type DbReadinessReason = "none" | "db_error" | "db_timeout" | "backpressure" | "unknown";

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

export function createHealthyMonitoringResponse() {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: MONITORING_SERVICE_NAME,
    };
}

async function checkDatabaseReadiness() {
    await withDbReadinessTimeout(db.$queryRaw`SELECT 1`, resolveDbReadinessTimeoutMs());
}

function isPrismaPoolTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const maybeCode = (error as { code?: unknown }).code;
    return maybeCode === 'P2024' || error.message.toLowerCase().includes('connection pool');
}

function isPrismaOperationTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const maybeCode = (error as { code?: unknown }).code;
    return maybeCode === 'P1008' || maybeCode === 'P2028';
}

function classifyDbReadinessReason(error: unknown): DbReadinessReason {
    if (error instanceof DbReadinessTimeoutError) {
        return "db_timeout";
    }

    if (isPrismaPoolTimeout(error)) {
        return "backpressure";
    }

    if (isPrismaOperationTimeout(error)) {
        return "db_timeout";
    }

    return error instanceof Error ? "db_error" : "unknown";
}

function recordDbReadinessTelemetry(result: DbReadinessResult, reason: DbReadinessReason, startedAtMs: number): void {
    const elapsedSeconds = Math.max(0, Date.now() - startedAtMs) / 1000;
    dbReadinessChecksCounter.inc({ result, reason });
    dbReadinessDurationHistogram.observe({ result, reason }, elapsedSeconds);
}

function resolveDbReadinessLogContext(error: unknown): Readonly<{ errorName?: string; errorCode?: string }> {
    if (!(error instanceof Error)) return {};
    const maybeCode = (error as { code?: unknown }).code;
    return {
        ...(error.name ? { errorName: error.name } : {}),
        ...(typeof maybeCode === "string" && maybeCode ? { errorCode: maybeCode } : {}),
    };
}

export async function sendDatabaseReadinessResponse(reply: FastifyReply): Promise<void> {
    const startedAtMs = Date.now();
    try {
        await checkDatabaseReadiness();
        recordDbReadinessTelemetry("ok", "none", startedAtMs);
        reply.send(createHealthyMonitoringResponse());
    } catch (error) {
        const reason = classifyDbReadinessReason(error);
        recordDbReadinessTelemetry("error", reason, startedAtMs);
        log(
            { module: 'health', level: 'error', reason, ...resolveDbReadinessLogContext(error) },
            'Database readiness check failed',
        );
        reply.code(503).send({
            status: 'error',
            timestamp: new Date().toISOString(),
            service: MONITORING_SERVICE_NAME,
            error: DB_READINESS_ERROR,
            reason,
        });
    }
}
