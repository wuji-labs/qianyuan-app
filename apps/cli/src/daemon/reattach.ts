import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import type { DaemonSessionMarker } from './sessionRegistry';
import { hashProcessCommand } from './sessionRegistry';
import type { TrackedSession } from './types';
import type { Credentials } from '@/persistence';
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
