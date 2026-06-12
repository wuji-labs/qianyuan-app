import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  SessionRunnerRespawnDescriptorV1Schema,
  type RespawnDescriptorEncryptionMaterial,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

const DaemonSessionMarkerSchema = z.object({
  pid: z.number().int().positive(),
  happySessionId: z.string(),
  happyHomeDir: z.string(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  flavor: z.enum(CATALOG_AGENT_IDS).optional(),
  startedBy: z.enum(['daemon', 'terminal']).optional(),
  cwd: z.string().optional(),
  // Process identity safety (PID reuse mitigation). Hash of the observed process command line.
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Optional debug-only sample of the observed command (best-effort; may be truncated by ps-list).
  processCommand: z.string().optional(),
  metadata: z.any().optional(),
  // Safe daemon respawn inputs (no secrets). Used to reconstruct SpawnSessionOptions after reattach.
  respawn: SessionRunnerRespawnDescriptorV1Schema.optional(),
});

export type DaemonSessionMarker = z.infer<typeof DaemonSessionMarkerSchema>;

export function hashProcessCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function currentDaemonSessionsDir(): string {
  return join(configuration.happyHomeDir, 'tmp', resolveReleaseRingScopedBasename('daemon-sessions', configuration.publicReleaseRing));
}

function legacyDaemonSessionsDir(): string | null {
  return configuration.publicReleaseRing === 'stable' ? null : join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
}

function markerReadDirs(): string[] {
  const currentDir = currentDaemonSessionsDir();
  const legacyDir = legacyDaemonSessionsDir();
  return legacyDir ? [currentDir, legacyDir] : [currentDir];
}

function markerPathsForPid(pid: number): string[] {
  return markerReadDirs().map((dir) => join(dir, `pid-${pid}.json`));
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      await rename(tmpPath, filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // On Windows, rename may fail if destination exists.
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        try {
          await unlink(filePath);
        } catch {
          // ignore unlink failure (e.g. ENOENT)
        }
        await rename(tmpPath, filePath);
        return;
      }
      throw e;
    }
  } catch (e) {
    // Best-effort cleanup to avoid leaving behind orphaned temp files on failure.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

export async function writeSessionMarker(marker: Omit<DaemonSessionMarker, 'createdAt' | 'updatedAt' | 'happyHomeDir'> & { createdAt?: number; updatedAt?: number }): Promise<void> {
  const currentDir = currentDaemonSessionsDir();
  await ensureDir(currentDir);
  const now = Date.now();
  const filePath = join(currentDir, `pid-${marker.pid}.json`);

  let createdAtFromDisk: number | undefined;
  for (const candidatePath of markerPathsForPid(marker.pid)) {
    try {
      const raw = await readFile(candidatePath, 'utf-8');
      const existing = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
      if (existing.success) {
        createdAtFromDisk = existing.data.createdAt;
        break;
      }
    } catch (e) {
      // ignore ENOENT (new marker); log other errors for diagnostics
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Could not read existing session marker pid-${marker.pid}.json to preserve createdAt`, e);
      }
    }
  }

  const payload: DaemonSessionMarker = DaemonSessionMarkerSchema.parse({
    ...marker,
    happyHomeDir: configuration.happyHomeDir,
    createdAt: marker.createdAt ?? createdAtFromDisk ?? now,
    updatedAt: now,
  });
  await writeJsonAtomic(filePath, payload);
}

/**
 * Rewrite an existing marker's respawn descriptor from updated spawn options,
 * preserving all other marker fields (identity, metadata, process hash).
 *
 * Needed after in-place session mutations that do NOT respawn the runner —
 * e.g. a hot-applied connected-service auth switch updates the tracked
 * session's bindings in memory only; without refreshing the durable marker a
 * daemon restart restores the spawn-time bindings and treats real switch
 * requests as 'unchanged' while the runtime auth has actually moved on.
 *
 * No-op when no marker exists for the pid (nothing to refresh).
 */
export async function refreshSessionMarkerRespawn(params: Readonly<{
  pid: number;
  spawnOptions: SpawnSessionOptions;
  encryptionMaterial?: RespawnDescriptorEncryptionMaterial;
}>): Promise<void> {
  let existing: DaemonSessionMarker | null = null;
  for (const candidatePath of markerPathsForPid(params.pid)) {
    try {
      const raw = await readFile(candidatePath, 'utf-8');
      const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        existing = parsed.data;
        break;
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Could not read session marker pid-${params.pid}.json for respawn refresh`, e);
      }
    }
  }
  if (!existing) return;

  const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
    params.spawnOptions,
    params.encryptionMaterial ? { encryptionMaterial: params.encryptionMaterial } : undefined,
  );
  if (!respawn) return;

  const { happyHomeDir: _happyHomeDir, updatedAt: _updatedAt, ...rest } = existing;
  await writeSessionMarker({
    ...rest,
    respawn,
  });
}

export async function removeSessionMarker(pid: number): Promise<void> {
  for (const filePath of markerPathsForPid(pid)) {
    try {
      await unlink(filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        logger.debug(`[sessionRegistry] Failed to remove session marker pid-${pid}.json`, e);
      }
    }
  }
}

export async function listSessionMarkers(): Promise<DaemonSessionMarker[]> {
  const markersByPid = new Map<number, DaemonSessionMarker>();

  for (const dir of markerReadDirs()) {
    await ensureDir(dir);
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
      const full = join(dir, name);
      try {
        const raw = await readFile(full, 'utf-8');
        const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          logger.debug(`[sessionRegistry] Failed to parse session marker ${name}`, parsed.error);
          continue;
        }
        // Extra safety: only accept markers for our home dir.
        if (parsed.data.happyHomeDir !== configuration.happyHomeDir) continue;
        if (!markersByPid.has(parsed.data.pid)) {
          markersByPid.set(parsed.data.pid, parsed.data);
        }
      } catch (e) {
        logger.debug(`[sessionRegistry] Failed to read or parse session marker ${name}`, e);
        // ignore unreadable marker
      }
    }
  }

  return Array.from(markersByPid.values());
}
