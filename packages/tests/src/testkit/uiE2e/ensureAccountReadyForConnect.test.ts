import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAccountReadyForConnect, type EnsureAccountReadyForConnectPage } from './ensureAccountReadyForConnect';

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
  roleCounts?: Record<string, number[]>;
}>): EnsureAccountReadyForConnectPage & {
  clickCalls: Record<string, number>;
} {
  const testIdCalls = new Map<string, number>();
  const roleCalls = new Map<string, number>();
  const testIdCounts = params.testIdCounts ?? {};
  const roleCounts = params.roleCounts ?? {};
  const clickCalls: Record<string, number> = {};

  const nextCount = (map: Map<string, number>, source: Record<string, number[]>, key: string): number => {
    const idx = map.get(key) ?? 0;
    map.set(key, idx + 1);
    const sequence = source[key] ?? [0];
    return sequence[Math.min(idx, sequence.length - 1)] ?? 0;
  };

  const makeLocator = (key: string, source: Record<string, number[]>, calls: Map<string, number>): Locator => ({
    count: async () => nextCount(calls, source, key),
    click: async () => {
      clickCalls[key] = (clickCalls[key] ?? 0) + 1;
    },
  } as unknown as Locator);

  return {
    clickCalls,
    getByTestId: ((testId) => makeLocator(String(testId), testIdCounts, testIdCalls)) as Page['getByTestId'],
    getByRole: ((_role, options) => makeLocator(String(options?.name ?? ''), roleCounts, roleCalls)) as Page['getByRole'],
    waitForTimeout: async () => {},
  };
}

describe('ensureAccountReadyForConnect', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes when account is already in a ready state without create-account CTA', async () => {
    const page = createFakePage({
      testIdCounts: {
        'session-getting-started-kind-create_session': [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(0);
    expect(page.clickCalls['Create account'] ?? 0).toBe(0);
  });

  it('passes when the signed-in shell is visible via role-based controls', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('clicks the testID create-account CTA when present, then waits for ready state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1],
        'session-getting-started-kind-connect_machine': [0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(1);
  });

  it('falls back to the role-based create-account CTA when testID is absent', async () => {
    const page = createFakePage({
      roleCounts: {
        'Create account': [1],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['Create account'] ?? 0).toBe(1);
  });

  it('throws when no ready state appears in time', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300);

    const page = createFakePage({});
    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).rejects.toThrow(
      'Account did not reach a ready UI state within 250ms.',
    );
  });
});
