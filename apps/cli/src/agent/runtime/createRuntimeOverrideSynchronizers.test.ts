import { describe, expect, it, vi } from 'vitest';

import * as acpRuntimeOverrideSynchronizers from './createAcpRuntimeOverrideSynchronizers';

describe('createRuntimeOverrideSynchronizers exports', () => {
  it('exposes the canonical export while keeping the ACP alias', () => {
    expect(typeof acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers).toBe('function');
    expect(acpRuntimeOverrideSynchronizers.createAcpRuntimeOverrideSynchronizers).toBe(
      acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers,
    );
  });

  it('applies pending model overrides before model-scoped config overrides after startup', async () => {
    const calls: string[] = [];
    let resolveModelApply!: () => void;
    const modelApply = new Promise<void>((resolve) => {
      resolveModelApply = resolve;
    });
    const setSessionModel = vi.fn(async (modelId: string) => {
      calls.push(`model:${modelId}`);
      await modelApply;
    });
    const setSessionConfigOption = vi.fn(async (configId: string, valueId: string) => {
      calls.push(`config:${configId}:${valueId}`);
    });

    const sync = acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers({
      session: {
        getMetadataSnapshot: () => ({
          modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
          sessionConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 11,
            overrides: {
              fast: { updatedAt: 11, value: true },
            },
          },
        } as any),
      },
      runtime: {
        setSessionMode: vi.fn(async () => {}),
        setSessionModel,
        setSessionConfigOption,
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(calls).toEqual(['model:gpt-5.5']);

    resolveModelApply();
    await sync.flushPendingAfterStart();
    expect(calls).toEqual(['model:gpt-5.5', 'config:fast:true']);
  });
});
