import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import type { DaemonSessionMarker } from './sessionRegistry';
import { hashProcessCommand } from './sessionRegistry';
import type { TrackedSession } from './types';
import type { Credentials } from '@/persistence';
import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeProjectRoots } from '@/runtime/resolvePackagedRuntimeEntrypoint';
import {
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './processSupervision/sessionRunnerRespawnDescriptor';

type AdoptSessionsFromMarkersResult = Readonly<{
  adopted: number;
  eligible: number;
  adoptedPids: ReadonlyArray<number>;
  respawnRestoreErrors: ReadonlyArray<{
    pid: number;
    happySessionId: string;
    message: string;
  }>;
}>;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePathLike(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function resolveCliRuntimeRootFromEntrypoint(pathLike: string | undefined): string | null {
  const normalized = normalizeOptionalString(pathLike);
  if (!normalized) return null;

  const normalizedPath = normalizePathLike(normalized);
  const packageDistMarker = '/package-dist/';
  const distMarker = '/dist/';
  const srcMarker = '/src/';
  const packageDistIndex = normalizedPath.indexOf(packageDistMarker);
  if (packageDistIndex >= 0) {
    return normalizedPath.slice(0, packageDistIndex);
  }
  const distIndex = normalizedPath.indexOf(distMarker);
  if (distIndex >= 0) {
    return normalizedPath.slice(0, distIndex);
  }
  const srcIndex = normalizedPath.indexOf(srcMarker);
  if (srcIndex >= 0) {
    return normalizedPath.slice(0, srcIndex);
  }
  return null;
}

function resolveOwnedLiveDaemonSessionRuntimeRoots(): string[] {
  const ownedRoots = new Set<string>();

  const subprocessEntrypointRoot = resolveCliRuntimeRootFromEntrypoint(
    normalizeOptionalString(process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT),
  );
  if (subprocessEntrypointRoot) {
    ownedRoots.add(subprocessEntrypointRoot);
  }

  for (const runtimeRoot of resolvePackagedRuntimeProjectRoots()) {
    ownedRoots.add(normalizePathLike(runtimeRoot));
  }

  ownedRoots.add(normalizePathLike(projectPath()));
  return [...ownedRoots];
}

export function isOwnedLiveDaemonSessionProcessCommand(command: string): boolean {
  const normalizedCommand = normalizeOptionalString(command);
  if (!normalizedCommand) return false;

  const ownedRoots = resolveOwnedLiveDaemonSessionRuntimeRoots();
  if (ownedRoots.length === 0) return false;

  const normalizedProcessCommand = normalizePathLike(normalizedCommand);
  return ownedRoots.some((ownedRoot) => normalizedProcessCommand.includes(ownedRoot));
}

export function adoptSessionsFromMarkers(params: {
  markers: DaemonSessionMarker[];
  happyProcesses: HappyProcessInfo[];
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
}): AdoptSessionsFromMarkersResult {
  const happyPidToType = new Map(params.happyProcesses.map((p) => [p.pid, p.type] as const));
  const happyPidToCommandHash = new Map(params.happyProcesses.map((p) => [p.pid, hashProcessCommand(p.command)] as const));

  let adopted = 0;
  let eligible = 0;
  const adoptedPids: number[] = [];
  const respawnRestoreErrors: Array<{ pid: number; happySessionId: string; message: string }> = [];

  for (const marker of params.markers) {
    // Safety: avoid PID reuse adopting an unrelated process. Only adopt if PID currently looks
    // like a Happy session process (best-effort cross-platform via ps-list classification).
    const procType = happyPidToType.get(marker.pid);
    if (!procType || !ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(procType)) {
      continue;
    }
    eligible++;

    // Stronger PID reuse safety: require the marker's observed command hash to match what is currently running.
    if (!marker.processCommandHash) {
      continue;
    }
    const currentHash = happyPidToCommandHash.get(marker.pid);
    if (!currentHash || currentHash !== marker.processCommandHash) {
      continue;
    }

    if (params.pidToTrackedSession.has(marker.pid)) continue;

    const respawnParsed = SessionRunnerRespawnDescriptorV1Schema.safeParse((marker as any).respawn);
    let spawnOptions;
    if (respawnParsed.success) {
      try {
        spawnOptions = buildSpawnSessionOptionsFromRespawnDescriptorV1(respawnParsed.data, {
          encryptionMaterial: params.credentials?.encryption,
        });
      } catch (error) {
        respawnRestoreErrors.push({
          pid: marker.pid,
          happySessionId: marker.happySessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    params.pidToTrackedSession.set(marker.pid, {
      startedBy: marker.startedBy ?? 'reattached',
      happySessionId: marker.happySessionId,
      happySessionMetadataFromLocalWebhook: marker.metadata,
      ...(spawnOptions ? { spawnOptions } : {}),
      pid: marker.pid,
      processCommandHash: marker.processCommandHash,
      ...(typeof marker.processCommand === 'string' ? { processCommand: marker.processCommand } : {}),
      reattachedFromDiskMarker: true,
    });
    adoptedPids.push(marker.pid);
    adopted++;
  }

  return { adopted, eligible, adoptedPids, respawnRestoreErrors };
}
