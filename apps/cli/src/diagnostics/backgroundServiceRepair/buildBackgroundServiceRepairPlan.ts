import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';

import type { BackgroundServiceRepairAction, BackgroundServiceRepairPlan } from './types';

function isCompatibleDefaultService(params: Readonly<{
  service: DaemonServiceListEntry;
  currentReleaseChannel: PublicReleaseRingId;
}>): boolean {
  return params.service.targetMode === 'default-following' && params.service.releaseChannel === params.currentReleaseChannel;
}

export function buildBackgroundServiceRepairPlan(params: Readonly<{
  currentReleaseChannel: PublicReleaseRingId;
  services: readonly DaemonServiceListEntry[];
}>): BackgroundServiceRepairPlan {
  const compatibleDefaultService = params.services.find((service) => isCompatibleDefaultService({
    service,
    currentReleaseChannel: params.currentReleaseChannel,
  })) ?? null;

  const actions: BackgroundServiceRepairAction[] = [];
  const removableServices = compatibleDefaultService
    ? params.services.filter((service) => service.label !== compatibleDefaultService.label)
    : [...params.services];

  for (const service of removableServices) {
    actions.push({
      kind: 'remove-service',
      service: {
        label: service.label,
        releaseChannel: service.releaseChannel,
        targetMode: service.targetMode,
        instanceId: service.serverId,
      },
    });
  }

  if (!compatibleDefaultService && params.services.length > 0) {
    actions.push({
      kind: 'install-default-following-service',
      releaseChannel: params.currentReleaseChannel,
    });
  }

  return {
    currentReleaseChannel: params.currentReleaseChannel,
    existingServices: [...params.services],
    actions,
    manualWarnings: [],
  };
}
