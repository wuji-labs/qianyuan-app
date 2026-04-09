import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import type { DaemonServiceMode, DaemonServiceTargetMode } from '@/daemon/service/plan';

export type BackgroundServiceRepairPlan = Readonly<{
  currentReleaseChannel: PublicReleaseRingId;
  existingServices: readonly DaemonServiceListEntry[];
  actions: readonly BackgroundServiceRepairAction[];
  manualWarnings: readonly string[];
}>;

export type BackgroundServiceRepairAction =
  | Readonly<{
      kind: 'remove-service';
      service: Readonly<{
        label: string;
        releaseChannel: PublicReleaseRingId;
        targetMode: DaemonServiceTargetMode;
        instanceId: string;
      }>;
    }>
  | Readonly<{
      kind: 'install-default-following-service';
      releaseChannel: PublicReleaseRingId;
    }>;

export type BackgroundServiceRepairApplyRuntime = Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  mode: DaemonServiceMode;
  systemUser: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
}>;
