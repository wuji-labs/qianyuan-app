import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from './routeRootTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installRouteRootCommonModuleMocks();

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => {}),
}));

const persistSnapshotMock = vi.fn(async (..._args: unknown[]) => {});
const persistIntentMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('@/utils/system/preRestartBugReportSnapshot', () => ({
  persistPreRestartBugReportSnapshot: persistSnapshotMock,
}));

vi.mock('@/utils/system/restartBugReportIntent', () => ({
  persistRestartBugReportIntent: persistIntentMock,
}));

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AppCrashRecoveryBoundary', () => {
  it('renders children when no error is thrown', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
          <>{React.createElement('ChildOk')}</>
        </AppCrashRecoveryBoundary>);
    expect(screen.findByType('ChildOk' as any)).toBeTruthy();
  });

  it('renders a crash fallback when a child throws during render', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    expect(screen.tree.toJSON()).not.toBeNull();
    expect(screen.findByTestId('app-blocking-logo')).toBeTruthy();
    expect(screen.findByTestId('app-crash-restart')).toBeTruthy();
    expect(screen.findByTestId('app-crash-report-bug')).toBeTruthy();
    expect(screen.findByTestId('app-crash-copy-details')).toBeTruthy();
  });

  it('renders the crash fallback inside a full-height scroll view', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    const { ScrollView } = await import('react-native');
    const scrollView = screen.findByType(ScrollView);
    expect(scrollView.props.style).toEqual(expect.objectContaining({ flex: 1 }));
    expect(scrollView.props.contentContainerStyle).toEqual(expect.objectContaining({ flexGrow: 1 }));
  });

  it('hosts the native crash fallback in a full-screen modal so it paints above stuck native screens', async () => {
    // iOS evidence (issue-2, T4h 2026-06-12): the boundary caught a FlashList crash, mounted its
    // fallback into the root view, but the screen kept showing the dead previous frame because a
    // natively-presented screen container stayed on top. Hosting the fallback in a RN Modal
    // presents it above any stuck native view controllers.
    const reactNative = await import('react-native');
    const platform = reactNative.Platform as { OS: string };
    const originalOs = platform.OS;
    platform.OS = 'ios';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
      const Thrower = () => {
        throw new Error('boom');
      };
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
            <Thrower />
          </AppCrashRecoveryBoundary>);

      const modal = screen.findByType(reactNative.Modal as any);
      expect(modal).toBeTruthy();
      expect(modal.props.visible).toBe(true);
      expect(modal.props.transparent).not.toBe(true);
      // The recovery UI must live inside the modal host, not next to it.
      expect(modal.findByProps({ testID: 'app-crash-restart' })).toBeTruthy();
    } finally {
      platform.OS = originalOs;
      consoleError.mockRestore();
    }
  });

  it('does not wrap the web crash fallback in a modal host', async () => {
    const reactNative = await import('react-native');
    expect((reactNative.Platform as { OS: string }).OS).toBe('web');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
      const Thrower = () => {
        throw new Error('boom');
      };
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
            <Thrower />
          </AppCrashRecoveryBoundary>);

      expect(screen.findAll((node) => node.type === (reactNative.Modal as any))).toHaveLength(0);
      expect(screen.findByTestId('app-crash-restart')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('invokes onRestart when the restart button is pressed', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };
    const onRestart = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    const restartButton = screen.findByTestId('app-crash-restart');
    expect(restartButton).not.toBeNull();
    if (!restartButton) {
      throw new Error('missing restart button');
    }
    await act(async () => {
      restartButton.props.onPress?.();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('persists a pre-restart snapshot and restarts when the report bug button is pressed', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRestart = vi.fn();

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    const reportBugButton = screen.findByTestId('app-crash-report-bug');
    expect(reportBugButton).not.toBeNull();
    if (!reportBugButton) {
      throw new Error('missing report bug button');
    }
    await act(async () => {
      reportBugButton.props.onPress?.();
      await flushPromises();
    });

    expect(persistSnapshotMock).toHaveBeenCalledTimes(1);
    expect(persistIntentMock).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
