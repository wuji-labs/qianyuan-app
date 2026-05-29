import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';
import { createSessionModeOverrideSynchronizer } from './sessionModeOverrideSync';
import { createModelOverrideSynchronizer } from './modelOverrideSync';

type AcpRuntimeOverrideTarget = {
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, valueId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
};

export function createRuntimeOverrideSynchronizers(params: Readonly<{
  session: { getMetadataSnapshot: () => import('@/api/types').Metadata | null };
  runtime: AcpRuntimeOverrideTarget;
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  const modeSync = createSessionModeOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
    autoApplyFromMetadata: false,
  });
  const configOptionSync = createSessionConfigOptionOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
    autoApplyFromMetadata: false,
  });
  const modelSync = createModelOverrideSynchronizer({
    session: params.session,
    runtime: params.runtime,
    isStarted: params.isStarted,
    autoApplyFromMetadata: false,
  });

  return {
    syncFromMetadata: () => {
      modeSync.syncFromMetadata();
      modelSync.syncFromMetadata();
      configOptionSync.syncFromMetadata();
      if (params.isStarted()) {
        void flushPendingAfterStart();
      }
    },
    flushPendingAfterStart,
  };

  async function flushPendingAfterStart(): Promise<void> {
      await modeSync.flushPendingAfterStart();
      await modelSync.flushPendingAfterStart();
      await configOptionSync.flushPendingAfterStart();
  }
}

export const createAcpRuntimeOverrideSynchronizers = createRuntimeOverrideSynchronizers;
