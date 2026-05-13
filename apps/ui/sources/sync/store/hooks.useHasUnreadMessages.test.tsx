import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

function makeRenderableSession(
  id: string,
  overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
  return {
    id,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 1,
    archivedAt: null,
    metadataVersion: 1,
    agentStateVersion: 0,
    metadata: null,
    thinking: false,
    thinkingAt: 0,
    presence: 1,
    ...overrides,
  };
}

describe('useHasUnreadMessages', () => {
  afterEach(() => {
    storage.setState({
      sessions: {},
      sessionListRenderables: {},
      sessionMessages: {},
      sessionPending: {},
      isDataReady: true,
    } as never);
    standardCleanup();
  });

  it('uses session-list row unread state when the full session is not hydrated', async () => {
    storage.setState({
      sessions: {},
      sessionListRenderables: {
        s1: makeRenderableSession('s1', { hasUnreadMessages: true }),
      },
      isDataReady: true,
    } as never);

    const { useHasUnreadMessages } = await import('./hooks');
    const hook = await renderHook(() => useHasUnreadMessages('s1'));

    expect(hook.getCurrent()).toBe(true);
    await hook.unmount();
  });

  it('derives ready attention from ready metadata and the read cursor', async () => {
    storage.setState({
      sessions: {
        s1: {
          id: 's1',
          seq: 10,
          lastViewedSessionSeq: 9,
          metadata: null,
        },
      },
      sessionMessages: {
        s1: {
          latestReadyEventSeq: 10,
          latestReadyEventAt: 2_000,
        },
      },
      sessionPending: {},
      sessionListRenderables: {},
      isDataReady: true,
    } as never);

    const { useSessionListAttentionState } = await import('./hooks');
    const hook = await renderHook(() => useSessionListAttentionState('s1', 'waiting'));

    expect(hook.getCurrent()).toBe('ready');
    await hook.unmount();
  });

  it('clears ready attention once the read cursor catches up', async () => {
    storage.setState({
      sessions: {
        s1: {
          id: 's1',
          seq: 10,
          lastViewedSessionSeq: 10,
          metadata: null,
        },
      },
      sessionMessages: {
        s1: {
          latestReadyEventSeq: 10,
          latestReadyEventAt: 2_000,
        },
      },
      sessionPending: {},
      sessionListRenderables: {},
      isDataReady: true,
    } as never);

    const { useSessionListAttentionState } = await import('./hooks');
    const hook = await renderHook(() => useSessionListAttentionState('s1', 'waiting'));

    expect(hook.getCurrent()).toBe('quiet');
    await hook.unmount();
  });

  it('uses renderable fallback state before full session hydration', async () => {
    storage.setState({
      sessions: {},
      sessionMessages: {},
      sessionPending: {},
      sessionListRenderables: {
        s1: makeRenderableSession('s1', { hasUnreadMessages: true }),
      },
      isDataReady: true,
    } as never);

    const { useSessionListAttentionState } = await import('./hooks');
    const hook = await renderHook(() => useSessionListAttentionState('s1', 'waiting'));

    expect(hook.getCurrent()).toBe('unread');
    await hook.unmount();
  });

  it('uses renderable ready fields for ready attention before full session hydration', async () => {
    storage.setState({
      sessions: {},
      sessionMessages: {},
      sessionPending: {},
      sessionListRenderables: {
        s1: makeRenderableSession('s1', {
          seq: 10,
          lastViewedSessionSeq: 9,
          hasUnreadMessages: true,
          latestReadyEventSeq: 10,
          latestReadyEventAt: 2_000,
        }),
      },
      isDataReady: true,
    } as never);

    const { useSessionListAttentionState } = await import('./hooks');
    const hook = await renderHook(() => useSessionListAttentionState('s1', 'waiting'));

    expect(hook.getCurrent()).toBe('ready');
    await hook.unmount();
  });

  it('keeps the row renderable stable when only streaming heartbeat fields change', async () => {
    storage.setState({
      sessions: {},
      sessionMessages: {},
      sessionPending: {},
      sessionListRenderables: {
        s1: makeRenderableSession('s1', {
          seq: 10,
          updatedAt: 1_000,
          thinking: true,
          thinkingAt: 1_000,
          metadata: {
            path: '/repo',
            summaryText: 'Working session',
          },
        }),
      },
      isDataReady: true,
    } as never);

    const { useSessionListRowRenderable } = await import('./hooks');
    let renderCount = 0;
    const hook = await renderHook(() => {
      renderCount += 1;
      return useSessionListRowRenderable('s1');
    });
    const initial = hook.getCurrent();

    await act(async () => {
      storage.setState({
        sessionListRenderables: {
          s1: makeRenderableSession('s1', {
            seq: 11,
            updatedAt: 1_500,
            thinking: true,
            thinkingAt: 1_500,
            metadata: {
              path: '/repo',
              summaryText: 'Working session',
            },
          }),
        },
      } as never);
    });

    expect(hook.getCurrent()).toBe(initial);
    expect(renderCount).toBe(1);
    await hook.unmount();
  });
});
