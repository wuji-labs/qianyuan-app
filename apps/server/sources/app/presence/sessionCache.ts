import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";
import { checkSessionAccess } from "@/app/share/accessControl";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { createSessionPresenceUpdateManyArgs } from "./sessionPresenceWritePlan";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    pendingThinking: boolean | null;
    userId: string;
    sessionId: string;
    active: boolean;
    thinking: boolean | null;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
    active: boolean;
}

const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

function readShutdownFlushTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS;
    if (raw === undefined || raw.trim() === "") {
        return DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    }

    return parsed;
}

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private batchTimer: NodeJS.Timeout | null = null;
    private dbFlushEnabled = false;
    private flushInFlight: Promise<void> | null = null;
    private dbFlushBackoffUntil = 0;
    private nextCleanupAt = 0;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;
    private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;
    private readonly DB_FLUSH_BACKOFF_INTERVAL = 30 * 1000;

    constructor() {}

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        
        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing updates: ${error}`);
            });
        }, this.BATCH_INTERVAL);
    }

    enableDbFlush(): void {
        if (this.dbFlushEnabled) return;
        this.dbFlushEnabled = true;
        this.startBatchTimer();
    }

    invalidateMachine(machineId: string): void {
        this.machineCache.delete(machineId);
    }

    private shouldBackoffDbFlush(error: unknown): boolean {
        return isRetryableSqliteWriteError(error);
    }

    private maybeCleanup(now: number): void {
        if (this.nextCleanupAt && now < this.nextCleanupAt) return;
        this.cleanup(now);
        this.nextCleanupAt = now + this.CLEANUP_INTERVAL;
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        this.maybeCleanup(now);
        const cacheKey = `${sessionId}:${userId}`;
        const cached = this.sessionCache.get(cacheKey);
        
        // Check cache first
        if (cached && cached.validUntil > now) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const access = await checkSessionAccess(userId, sessionId);
            
            if (access) {
                const lastActiveAt = access.sessionLastActiveAt ?? null;
                if (!lastActiveAt) {
                    const session = await db.session.findUnique({
                        where: { id: sessionId },
                        select: { lastActiveAt: true, active: true },
                    });
                    if (!session?.lastActiveAt) {
                        // Fail closed: presence should not mark unknown sessions as valid.
                        return false;
                    }

                    // Cache the result
                    this.sessionCache.set(cacheKey, {
                        validUntil: now + this.CACHE_TTL,
                        lastUpdateSent: session.lastActiveAt.getTime(),
                        pendingUpdate: null,
                        pendingThinking: null,
                        userId,
                        sessionId,
                        active: session.active,
                        thinking: null,
                    });
                    return true;
                }

                // Cache the result
                this.sessionCache.set(cacheKey, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: lastActiveAt.getTime(),
                    pendingUpdate: null,
                    pendingThinking: null,
                    userId,
                    sessionId,
                    active: access.sessionActive ?? true,
                    thinking: null,
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating session ${sessionId}: ${error}`);
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        this.maybeCleanup(now);
        const cached = this.machineCache.get(machineId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });
            
            if (machine) {
                if (machine.revokedAt || machine.replacedByMachineId) {
                    // Fail closed: revoked/forgotten/replaced machines are treated as invalid for presence.
                    this.machineCache.delete(machineId);
                    return false;
                }

                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId,
                    active: machine.active
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating machine ${machineId}: ${error}`);
            return false;
        }
    }

    queueSessionUpdate(sessionId: string, userId: string, timestamp: number, thinking?: boolean): boolean {
        this.maybeCleanup(Date.now());
        const cacheKey = `${sessionId}:${userId}`;
        const cached = this.sessionCache.get(cacheKey);
        if (!cached) {
            return false; // Should validate first
        }
        const nextThinking = typeof thinking === "boolean" ? thinking : null;

        if (nextThinking !== null && cached.thinking !== nextThinking) {
            cached.pendingUpdate = timestamp;
            cached.pendingThinking = nextThinking;
            cached.thinking = nextThinking;
            cached.active = true;
            return true;
        }

        // If the session is currently marked inactive, force a DB write to flip it back to active
        // even if `lastActiveAt` is already recent (e.g. after a restart or previously-buggy writes).
        if (!cached.active) {
            cached.pendingUpdate = timestamp;
            cached.pendingThinking = nextThinking;
            cached.active = true;
            return true;
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            cached.pendingThinking = nextThinking;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    isSessionObservedActive(sessionId: string, now = Date.now()): boolean {
        this.maybeCleanup(now);
        for (const entry of this.sessionCache.values()) {
            if (entry.sessionId !== sessionId) continue;
            if (entry.validUntil <= now) continue;
            if (entry.active || entry.pendingUpdate !== null) {
                return true;
            }
        }
        return false;
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        this.maybeCleanup(Date.now());
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // If the machine is currently marked inactive, force a DB write to flip it back to active
        // even if `lastActiveAt` is already recent (e.g. after a restart or previously-buggy writes).
        if (!cached.active) {
            cached.pendingUpdate = timestamp;
            cached.active = true;
            return true;
        }

        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    markSessionUpdateSent(sessionId: string, userId: string, timestamp: number): void {
        const cacheKey = `${sessionId}:${userId}`;
        const cached = this.sessionCache.get(cacheKey);
        if (!cached) return;
        cached.lastUpdateSent = timestamp;
        cached.pendingUpdate = null;
        cached.pendingThinking = null;
        cached.active = true;
    }

    markSessionInactive(sessionId: string, userId: string, timestamp: number): void {
        const cacheKey = `${sessionId}:${userId}`;
        this.sessionCache.delete(cacheKey);
        for (const [entryKey, entry] of this.sessionCache.entries()) {
            if (entry.sessionId !== sessionId) continue;
            this.sessionCache.delete(entryKey);
        }
    }

    markMachineUpdateSent(machineId: string, timestamp: number): void {
        const cached = this.machineCache.get(machineId);
        if (!cached) return;
        cached.lastUpdateSent = timestamp;
        cached.pendingUpdate = null;
        cached.active = true;
    }

    private flushPendingUpdates(): Promise<void> {
        // Avoid overlapping flushes (interval ticks, shutdown-triggered flush, etc.). On SQLite, overlapping
        // presence writes can cause lock contention that delays control-plane requests (e.g. machine registration).
        if (this.flushInFlight) {
            return this.flushInFlight;
        }

        const flushPromise = this.flushPendingUpdatesInternal().finally(() => {
            if (this.flushInFlight === flushPromise) {
                this.flushInFlight = null;
            }
        });
        this.flushInFlight = flushPromise;
        return flushPromise;
    }

    private async flushPendingUpdatesInternal(): Promise<void> {
        const now = Date.now();
        if (now < this.dbFlushBackoffUntil) return;
        let shouldAbortFlush = false;

        const sessionUpdatesById = new Map<string, { timestamp: number; thinking: boolean | null; entries: SessionCacheEntry[] }>();
        const machineUpdates: { machineId: string; timestamp: number; entry: MachineCacheEntry }[] = [];
        
        // Collect session updates
        for (const entry of this.sessionCache.values()) {
            if (entry.pendingUpdate !== null) {
                const timestamp = entry.pendingUpdate;
                const existing = sessionUpdatesById.get(entry.sessionId);
                if (!existing) {
                    sessionUpdatesById.set(entry.sessionId, { timestamp, thinking: entry.pendingThinking, entries: [entry] });
                } else {
                    if (timestamp >= existing.timestamp) {
                        existing.timestamp = timestamp;
                        existing.thinking = entry.pendingThinking;
                    }
                    existing.entries.push(entry);
                }
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate !== null) {
                machineUpdates.push({
                    machineId,
                    timestamp: entry.pendingUpdate,
                    entry,
                });
            }
        }
        
        // Flush session presence updates (best-effort).
        if (sessionUpdatesById.size > 0) {
            let okCount = 0;
            try {
                const operations = Array.from(sessionUpdatesById.entries()).flatMap(([sessionId, update]) =>
                    createSessionPresenceUpdateManyArgs({
                        sessionId,
                        timestamp: update.timestamp,
                        thinking: update.thinking,
                    }).map((args) => db.session.updateMany(args)),
                );
                await db.$transaction(operations);

                for (const update of sessionUpdatesById.values()) {
                    for (const entry of update.entries) {
                        entry.lastUpdateSent = update.timestamp;
                        // Preserve newer queued updates that arrived while awaiting the DB write.
                        // The flush snapshot uses the pendingUpdate value observed at collection time.
                        const pending = entry.pendingUpdate;
                        entry.pendingUpdate = pending !== null && pending > update.timestamp ? pending : null;
                        if (entry.pendingUpdate === null) {
                            entry.pendingThinking = null;
                        }
                        entry.active = true;
                    }
                }
                okCount = sessionUpdatesById.size;
            } catch (error) {
                // Keep every pending update in the failed transaction so the next flush retries the full batch.
                for (const update of sessionUpdatesById.values()) {
                    for (const entry of update.entries) {
                        entry.pendingUpdate = Math.max(entry.pendingUpdate ?? 0, update.timestamp);
                    }
                }
                log(
                    { module: 'session-cache', level: 'error' },
                    `Error updating sessions: ${error}`,
                );
                if (this.shouldBackoffDbFlush(error)) {
                    this.dbFlushBackoffUntil = Date.now() + this.DB_FLUSH_BACKOFF_INTERVAL;
                    shouldAbortFlush = true;
                }
            }

            log({ module: 'session-cache' }, `Flushed ${okCount}/${sessionUpdatesById.size} session updates`);
        }

        if (shouldAbortFlush) {
            return;
        }
        
        // Flush machine presence updates (best-effort).
        if (machineUpdates.length > 0) {
            let okCount = 0;
            try {
                const operations = machineUpdates.map((update) =>
                    db.machine.updateMany({
                        where: {
                            accountId: update.entry.userId,
                            id: update.machineId,
                            revokedAt: null,
                            replacedByMachineId: null,
                        },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    }),
                );
                await db.$transaction(operations);

                for (const update of machineUpdates) {
                    update.entry.lastUpdateSent = update.timestamp;
                    // Preserve newer queued updates that arrived while awaiting the DB write.
                    const pending = update.entry.pendingUpdate;
                    update.entry.pendingUpdate = pending !== null && pending > update.timestamp ? pending : null;
                    update.entry.active = true;
                }
                okCount = machineUpdates.length;
            } catch (error) {
                // Keep every pending update in the failed transaction so the next flush retries the full batch.
                for (const update of machineUpdates) {
                    update.entry.pendingUpdate = Math.max(update.entry.pendingUpdate ?? 0, update.timestamp);
                }
                log(
                    { module: 'session-cache', level: 'error' },
                    `Error updating machines: ${error}`,
                );
                if (this.shouldBackoffDbFlush(error)) {
                    this.dbFlushBackoffUntil = Date.now() + this.DB_FLUSH_BACKOFF_INTERVAL;
                }
            }

            log({ module: 'session-cache' }, `Flushed ${okCount}/${machineUpdates.length} machine updates`);
        }
    }

    private async flushPendingUpdatesForShutdown(timeoutMs: number): Promise<void> {
        const flushPromise = this.flushPendingUpdates();
        let timeout: ReturnType<typeof setTimeout> | null = null;

        try {
            const result = await Promise.race([
                flushPromise.then(() => "flushed" as const),
                new Promise<"timed-out">((resolve) => {
                    timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
                    timeout.unref?.();
                }),
            ]);

            if (result === "timed-out") {
                log(
                    { module: 'session-cache', level: 'warn' },
                    `Timed out waiting ${timeoutMs}ms for final presence flush during shutdown`,
                );
            }
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error flushing final updates: ${error}`);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    // Cleanup old cache entries periodically
    cleanup(now = Date.now()): void {
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }
    }

    async shutdown(): Promise<void> {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        const shouldFlush = this.dbFlushEnabled;
        this.dbFlushEnabled = false;
        this.dbFlushBackoffUntil = 0;
        this.nextCleanupAt = 0;
        
        try {
            // Flush any remaining updates, but do not let shutdown hang forever behind a stuck DB write.
            if (shouldFlush) {
                await this.flushPendingUpdatesForShutdown(readShutdownFlushTimeoutMs());
            }
        } finally {
            // Ensure shutdown is a hard stop: cache entries must not leak across lifetimes
            // (and tests should not share state through the singleton).
            this.sessionCache.clear();
            this.machineCache.clear();
        }
    }
}

// Global instance
export const activityCache = new ActivityCache();
