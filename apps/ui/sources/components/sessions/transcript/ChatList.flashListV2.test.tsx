import {
    flashListChatListHarnessState,
    createFlashListChatListWebElement,
    createFlashListChatListWebScroller,
    FlashListChatListWebElement,
    renderFlashListChatList,
    triggerFlashListChatListContentSizeChange,
    triggerFlashListChatListInitialFill,
    triggerFlashListChatListLoad,
    triggerFlashListChatListScroll,
    triggerFlashListChatListStartReached,
    withRenderedFlashListChatListWebScroller,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import * as React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { buildChatListNativeId } from './chatListNativeId';
import { __resetDefaultTranscriptItemHeightCacheForTests } from './measurement/transcriptItemHeightCache';
import { useTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let renderedFlatListCount = 0;
let renderedFlashListCount = 0;
let flashListRefHandle: any = null;
let renderedMessageViewProps: any[] = [];
let renderedToolCallsGroupRowProps: any[] = [];
let linearItemsCacheBuildCalls: Array<{ cacheHit: boolean; cacheProvided: boolean; signature: string }> = [];
let turnsCacheBuildCalls: Array<{ cacheHit: boolean; cacheProvided: boolean; signature: string }> = [];
let requireSelectionProviderForRenderedMessages = false;
const mountedTrees: ReactTestRenderer[] = [];

function getCapturedFlashListProps(): any {
    const props = flashListChatListHarnessState.flashListProps ?? capturedFlashListProps;
    expect(props).toBeTruthy();
    return props;
}

async function renderTrackedFlashListChatList(element: React.ReactElement) {
    const screen = await renderFlashListChatList(element, {
        flushOptions: { cycles: 0 },
    });
    mountedTrees.push(screen.tree);
    return screen;
}

function unmountTrackedFlashListChatList(screen: { tree: ReactTestRenderer }): void {
    act(() => {
        screen.tree.unmount();
    });
    const index = mountedTrees.indexOf(screen.tree);
    if (index >= 0) {
        mountedTrees.splice(index, 1);
    }
}

function expectScreenHasTestId(screen: { findByTestId: (testID: string) => unknown }, testID: string): void {
    expect(screen.findByTestId(testID)).toBeTruthy();
}

function countExactTestId(screen: { findAll: (predicate: (node: any) => boolean) => unknown[] }, testID: string): number {
    return screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === testID).length;
}

function countVisibleOlderLoadSpinners(screen: { findAll: (predicate: (node: any) => boolean) => unknown[] }): number {
    return screen.findAll((node) => node.props?.accessibilityRole === 'progressbar').length;
}

type FlashListFlushOptions = {
    turns?: number;
    frames?: number;
    advanceTimersMs?: number;
};

async function primeFlashListMetrics(
    layoutHeight: number,
    contentHeight: number,
    options: FlashListFlushOptions = {},
): Promise<void> {
    await triggerFlashListChatListInitialFill({
        layoutHeight,
        contentHeight,
        flushOptions: {
            turns: options.turns ?? 1,
            frames: options.frames,
            advanceTimersMs: options.advanceTimersMs,
        },
    });
}

async function scrollFlashListTo(contentOffsetY: number, options: FlashListFlushOptions & { trusted?: boolean } = {}): Promise<void> {
    await triggerFlashListChatListScroll(
        contentOffsetY,
        options.trusted === false ? {} : { isTrusted: true },
        {
            turns: options.turns ?? 1,
            frames: options.frames,
            advanceTimersMs: options.advanceTimersMs,
        },
    );
}

async function withWebFlashListFakeTimers<T>(now: number, run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ now: new Date(now) });
    try {
        return await run();
    } finally {
        vi.useRealTimers();
    }
}

async function settleNativeFlashListMount(screen: { settle: (options?: FlashListFlushOptions & { cycles?: number }) => Promise<void> }): Promise<void> {
    await triggerFlashListChatListLoad(12, { turns: 1 });
    await screen.settle({
        advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
        cycles: 1,
        turns: 2,
    });
}

function findTranscriptItemShell(screen: { findByTestId: (testID: string) => any }, itemId: string) {
    return screen.findByTestId(`transcript-item-${itemId}`);
}

function readStyleMinHeight(style: unknown): number | undefined {
    if (Array.isArray(style)) {
        for (const entry of style) {
            const value = readStyleMinHeight(entry);
            if (value !== undefined) return value;
        }
        return undefined;
    }
    if (style && typeof style === 'object' && 'minHeight' in style) {
        const value = (style as { minHeight?: unknown }).minHeight;
        return typeof value === 'number' ? value : undefined;
    }
    return undefined;
}

async function fireTranscriptItemShellLayout(
    shell: { props: { onLayout?: (event: unknown) => void } },
    height: number,
): Promise<void> {
    await act(async () => {
        shell.props.onLayout?.({
            nativeEvent: {
                layout: {
                    height,
                    width: 400,
                },
            },
        });
    });
}

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;
let transcriptTurnsState: any[] = [];
type SessionViewportTestSnapshot = {
    isPinned: boolean;
    offsetY: number;
    anchor?: {
        kind: 'message' | 'toolGroup' | 'item';
        messageId?: string | null;
        itemId: string;
        itemOffsetPx: number;
        capturedAtMs: number;
    } | null;
    lastUpdatedAt: number;
    source: 'default' | 'observed';
};
let sessionViewportByIdState = new Map<string, SessionViewportTestSnapshot>();

const settingValues: Record<string, any> = {};
const runtimeMockState = vi.hoisted(() => ({
    headerHeight: 0,
    platformOs: 'web' as 'web' | 'ios' | 'android',
    safeAreaTop: 0,
}));
const reducedMotionMockState = vi.hoisted(() => ({
    preferred: false,
}));
const markdownRuntimeMockState = vi.hoisted(() => ({
    preload: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    ready: true,
}));
type JumpToTranscriptSeqMockParams = Readonly<{
    getIndex: () => number | null;
    scrollToIndex: (index: number) => void;
}>;
const jumpToTranscriptSeqMockState = vi.hoisted(() => ({
    implementation: null as null | ((params: JumpToTranscriptSeqMockParams) => Promise<void> | void),
}));
const viewportControllerMockState = vi.hoisted(() => ({
    resolveInputs: [] as Array<Record<string, unknown>>,
}));

type SyncTuningMock = {
    transcriptForwardPrefetchThresholdPx: number;
    transcriptBackwardPrefetchThresholdPx: number;
    transcriptFlashListEstimatedItemSize: number;
    transcriptWebHotTailItemCount: number;
    transcriptWebInitialPinStabilizeMs: number;
    transcriptWebInitialPinRetryIntervalMs: number;
    transcriptWebInitialPinRetryMilestonesMs: readonly number[];
    transcriptOlderLoadSpinnerDelayMs: number;
    transcriptViewportAnchorCaptureDebounceMs: number;
    transcriptViewportAnchorOlderLookupMaxLoads: number;
    transcriptViewportAnchorRenderRetryMax: number;
    transcriptDerivedItemsCacheMaxSessions: number;
    transcriptItemHeightCacheMaxEntries: number;
    transcriptFlashListDrawDistance: number;
    transcriptMountSettleQuiescentWindowMs: number;
    transcriptMountSettleDimensionNoiseFloorPx: number;
    transcriptMountSettleBottomDistanceNoiseFloorPx: number;
    transcriptInitialFillBudgetMs: number;
    transcriptViewportTelemetryEnabled?: boolean;
    transcriptViewportTelemetryMaxEvents?: number;
    transcriptNativeMvcpOnlyMode?: boolean;
};

let syncTuningState: SyncTuningMock = {
    transcriptForwardPrefetchThresholdPx: 0,
    transcriptBackwardPrefetchThresholdPx: 0,
    transcriptFlashListEstimatedItemSize: 120,
    transcriptWebHotTailItemCount: 2,
    transcriptWebInitialPinStabilizeMs: 3000,
    transcriptWebInitialPinRetryIntervalMs: 250,
    transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
    transcriptOlderLoadSpinnerDelayMs: 300,
    transcriptViewportAnchorCaptureDebounceMs: 200,
    transcriptViewportAnchorOlderLookupMaxLoads: 1,
    transcriptViewportAnchorRenderRetryMax: 4,
    transcriptDerivedItemsCacheMaxSessions: 8,
    transcriptItemHeightCacheMaxEntries: 1024,
    transcriptFlashListDrawDistance: 0,
    transcriptMountSettleQuiescentWindowMs: 120,
    transcriptMountSettleDimensionNoiseFloorPx: 1,
    transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
    transcriptInitialFillBudgetMs: 2000,
};

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        renderedFlashListCount++;
        capturedFlashListProps = props;
        flashListChatListHarnessState.flashListProps = props;
        if (typeof ref === 'function') {
            ref(flashListRefHandle);
        } else if (ref && typeof ref === 'object') {
            ref.current = flashListRefHandle;
        }
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function'
                    ? props.ListFooterComponent()
                    : props.ListFooterComponent)
                : null;

        return React.createElement(
            'FlashList',
            { ...props, testID: 'flash-list' },
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    }),
    LayoutCommitObserver: ({ children, onCommitLayoutEffect }: any) => {
        React.useLayoutEffect(() => {
            onCommitLayoutEffect?.();
        });
        return React.createElement(React.Fragment, null, children);
    },
    useLayoutState: (initialState: any) => {
        const [state, setState] = React.useState(() => (
            typeof initialState === 'function' ? initialState() : initialState
        ));
        return [state, setState];
    },
    useRecyclingState: (initialState: any, deps: React.DependencyList, onReset?: () => void) => {
        const [state, setState] = React.useState(() => (
            typeof initialState === 'function' ? initialState() : initialState
        ));
        React.useLayoutEffect(() => {
            setState(typeof initialState === 'function' ? initialState() : initialState);
            onReset?.();
        }, deps);
        return [state, setState];
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Dimensions: {
                                        get: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
                                    },
                                    Platform: {
                                        get OS() {
                                                        return runtimeMockState.platformOs;
                                                    },
                                        select: (values: any) => values?.[runtimeMockState.platformOs] ?? values?.default,
                                    },
                                    Easing: {
                                        bezier: () => (t: number) => t,
                                        linear: (t: number) => t,
                                    },
                                    View: (props: any) => React.createElement('View', props, props.children),
                                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                    ActivityIndicator: () => React.createElement('ActivityIndicator'),
                                    FlatList: (_props: any) => {
                                            renderedFlatListCount++;
                                            return React.createElement('FlatList');
                                        },
                                }
    );
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => runtimeMockState.headerHeight,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: runtimeMockState.safeAreaTop, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSession: () => sessionState,
    useSessionChatFooterState: () => sessionState
        ? {
            controlledByUser: sessionState.agentState?.controlledByUser === true,
            localControl: null,
            permissionsInUiWhileLocal: false,
        }
        : null,
    useSessionTranscriptIds: () => ({
            ids: (sessionMessagesState.messages ?? []).map((m: any) => m.id),
            isLoaded: sessionMessagesState.isLoaded,
        }),
    useSessionMessagesById: () => Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
    useSessionMessagesReducerState: () => null,
    useSessionForkSupportSource: () => null,
    useSessionWorkspacePath: () => null,
    useForkedTranscriptSnapshot: () => null,
    useSessionPendingMessages: () => sessionPendingState,
    useSessionActionDrafts: () => sessionActionDraftsState,
    useSessionLatestThinkingMessageId: () => null,
    useSessionLatestThinkingMessageActivityAtMs: () => null,
    useMessage: (_sessionId: string, messageId: string) =>
        (sessionMessagesState.messages ?? []).find((message: any) => message.id === messageId) ?? null,
    useSetting: (key: string) => settingValues[key],
    getStorage: () => ({
        getState: () => ({
            sessionMessages: {
                [sessionState?.id ?? 'session-1']: {
                    messagesById: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
                    messagesMap: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
                },
            },
        }),
    }),
});
});

function buildMockChatListItems(opts: any): any[] {
    const items =
        opts?.includeCommittedMessages === false
            ? []
            : (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
                const m = opts?.messagesById?.[id];
                if (opts?.groupConsecutiveToolCalls === true && m?.kind === 'tool-call') {
                    return {
                        kind: 'tool-calls-group',
                        id: `toolCalls:linear:${id}`,
                        toolMessageIds: [id],
                        createdAt: m?.createdAt ?? 0,
                    };
                }
                return { kind: 'message', id, messageId: id, createdAt: m?.createdAt ?? 0, seq: null };
            });

    if ((opts?.pendingMessages ?? []).length > 0 || (opts?.discardedMessages ?? []).length > 0) {
        items.push({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: opts?.pendingMessages ?? [],
            discardedMessages: opts?.discardedMessages ?? [],
        });
    }

    for (const draft of opts?.actionDrafts ?? []) {
        items.push({
            kind: 'action-draft',
            id: `draft:${draft.id}`,
            draft,
        });
    }

    return items;
}

function buildMockLinearItemsSignature(opts: any): string {
    return JSON.stringify({
        actionDraftIds: (opts?.actionDrafts ?? []).map((draft: any) => draft.id),
        discardedCount: (opts?.discardedMessages ?? []).length,
        groupConsecutiveToolCalls: opts?.groupConsecutiveToolCalls === true,
        messageKeys: (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
            const message = opts?.messagesById?.[id];
            return [
                id,
                message?.kind ?? 'missing',
                message?.seq ?? null,
                message?.createdAt ?? null,
                message?.text ?? null,
            ];
        }),
        pendingCount: (opts?.pendingMessages ?? []).length,
    });
}

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildMockChatListItems,
    buildChatListItemsCached: (opts: any) => {
        const signature = buildMockLinearItemsSignature(opts);
        const cacheProvided = opts?.cache != null;
        const cacheHit = opts?.cache?.signature === signature;
        linearItemsCacheBuildCalls.push({ cacheHit, cacheProvided, signature });
        if (cacheHit) {
            return {
                cache: opts.cache,
                items: opts.cache.items,
            };
        }

        const items = buildMockChatListItems(opts);
        return {
            cache: { signature, items },
            items,
        };
    },
}));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
    ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter', { testID: 'chat-footer' }),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewProps.push(props);
        if (requireSelectionProviderForRenderedMessages && typeof props.message?.id === 'string') {
            useTranscriptSelectionRow(props.message.id);
        }
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: any) => {
        renderedMessageViewProps.push(props);
        if (requireSelectionProviderForRenderedMessages && typeof props.message?.id === 'string') {
            useTranscriptSelectionRow(props.message.id);
        }
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: any) => React.createElement('TranscriptMotionProvider', null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({}),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: any) => React.createElement('TranscriptEnterWrapper', null, children),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionMockState.preferred,
}));

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    isEnrichedMarkdownRuntimePreloaded: () => markdownRuntimeMockState.ready,
    preloadEnrichedMarkdownRuntime: markdownRuntimeMockState.preload,
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/utils/sessions/jumpToTranscriptSeq', () => ({
    jumpToTranscriptSeq: vi.fn(async (params: JumpToTranscriptSeqMockParams) => {
        if (jumpToTranscriptSeqMockState.implementation) {
            await jumpToTranscriptSeqMockState.implementation(params);
            return;
        }
        const index = params.getIndex();
        if (index != null) params.scrollToIndex(index);
    }),
}));

vi.mock('@/components/sessions/transcript/viewport/createTranscriptViewportController', async () => {
    const actual = await vi.importActual<typeof import('@/components/sessions/transcript/viewport/createTranscriptViewportController')>(
        '@/components/sessions/transcript/viewport/createTranscriptViewportController',
    );
    return {
        ...actual,
        createTranscriptViewportController: () => {
            const controller = actual.createTranscriptViewportController();
            return {
                getMode: controller.getMode,
                resolve: (input: Parameters<typeof controller.resolve>[0]) => {
                    viewportControllerMockState.resolveInputs.push(input as unknown as Record<string, unknown>);
                    return controller.resolve(input);
                },
            };
        },
    };
});

function buildMockTurnsSignature(opts: any): string {
    return JSON.stringify({
        groupToolCalls: opts?.groupToolCalls === true,
        ids: opts?.messageIdsOldestFirst ?? [],
        strategy: opts?.toolCallsGroupStrategy ?? null,
        turnIds: transcriptTurnsState.map((turn) => turn.id),
    });
}

vi.mock('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns', () => ({
    buildTranscriptTurnsCached: (opts: any) => {
        const signature = buildMockTurnsSignature(opts);
        const cacheProvided = opts?.cache != null;
        const cacheHit = opts?.cache?.signature === signature;
        turnsCacheBuildCalls.push({ cacheHit, cacheProvided, signature });
        if (cacheHit) return opts.cache;
        return {
            signature,
            turns: transcriptTurnsState,
        };
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => {
        renderedToolCallsGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
    ToolCallsGroupRowWithSessionCommon: (props: any) => {
        renderedToolCallsGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRowWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', async () => await import('./scroll/transcriptScrollPinController'));

vi.mock('@/components/sessions/transcript/scroll/shouldPrefetchOlderFromTop', async () => await import('./scroll/shouldPrefetchOlderFromTop'));

vi.mock('@/encryption/hex', () => ({
    decodeHex: () => new Uint8Array(),
    encodeHex: () => '',
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

// Mirrors the real `sync.onSessionViewportChange`/`markSessionLiveTailIntent` routing
// (see sources/sync/sync.ts) so component-level capture is persisted into a real
// `source: 'observed'` / `source: 'default'` snapshot. This lets a single test exercise the
// full web capture -> persist -> restore contract instead of pre-seeding the snapshot.
function routeSessionViewportChangeIntoTestStore(
    sessionId: string,
    state: { isPinned: boolean; offsetY: number; shouldRestoreViewport?: boolean; anchor?: SessionViewportTestSnapshot['anchor'] },
): void {
    if (!sessionId) return;
    if (state.shouldRestoreViewport !== true || state.isPinned === true) {
        sessionViewportByIdState.set(sessionId, {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: Date.now(),
            source: 'default',
        });
        return;
    }
    sessionViewportByIdState.set(sessionId, {
        isPinned: false,
        offsetY: state.offsetY,
        anchor: state.anchor ?? null,
        lastUpdatedAt: Date.now(),
        source: 'observed',
    });
}

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(),
        loadNewerMessages: vi.fn(),
        hasDeferredNewerMessages: () => false,
        getSyncTuning: () => syncTuningState,
        getSessionViewport: (sessionId: string) => sessionViewportByIdState.get(sessionId) ?? null,
        onSessionViewportChange: (sessionId: string, state: any) => routeSessionViewportChangeIntoTestStore(sessionId, state),
        markSessionLiveTailIntent: (sessionId: string) => routeSessionViewportChangeIntoTestStore(sessionId, { isPinned: true, offsetY: 0 }),
    },
}));

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', async () => await import('./thinking/resolveActiveThinkingMessageId'));

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/settings/settings')>();
    return {
        ...actual,
        settingsDefaults: {},
    };
});

vi.mock('./chatListNativeId', () => ({
    buildChatListNativeId: (sessionId: string, reactId: string) => `chat-list-${sessionId}-${reactId}`,
}));

vi.mock('@/components/ui/lists/useWebFlashListCrashFallback', () => ({
    useWebFlashListCrashFallback: () => false,
}));

vi.mock('@/components/sessions/transcript/segments/buildTranscriptHotColdSegments', async () => await import('./segments/buildTranscriptHotColdSegments'));

vi.mock('@/components/sessions/transcript/webTranscriptScrollMetrics', async () => await import('./webTranscriptScrollMetrics'));

vi.mock('@/components/sessions/transcript/web/WebTranscriptSplitFooter', async () => await import('./web/WebTranscriptSplitFooter'));

vi.mock('@/components/sessions/transcript/webTranscriptPrependAnchor', async () => await import('./webTranscriptPrependAnchor'));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScrollInset: (props: { testID?: string; onHeightChange?: (height: number) => void }) =>
        React.createElement('ComposerKeyboardScrollInset', {
            testID: props.testID ?? 'transcript-composer-keyboard-inset',
            onHeightChange: props.onHeightChange,
        }),
    ComposerKeyboardFloatingInset: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
        React.createElement('ComposerKeyboardFloatingInset', {
            testID: testID ?? 'transcript-jump-to-bottom-keyboard-offset',
        }, children),
}));

describe('ChatList (FlashList v2)', () => {
    beforeEach(() => {
        vi.resetModules();
        __resetDefaultTranscriptItemHeightCacheForTests();
        runtimeMockState.platformOs = 'web';
        capturedFlashListProps = null;
        flashListChatListHarnessState.flashListProps = null;
        renderedFlatListCount = 0;
        renderedFlashListCount = 0;
        renderedMessageViewProps = [];
        renderedToolCallsGroupRowProps = [];
        linearItemsCacheBuildCalls = [];
        turnsCacheBuildCalls = [];
        flashListRefHandle = null;
        mountedTrees.length = 0;
        sessionMessagesState = { messages: [], isLoaded: true };
        sessionPendingState = { messages: [] };
        sessionActionDraftsState = [];
        transcriptTurnsState = [];
        sessionViewportByIdState = new Map();
        runtimeMockState.headerHeight = 0;
        runtimeMockState.safeAreaTop = 0;
        reducedMotionMockState.preferred = false;
        markdownRuntimeMockState.ready = true;
        markdownRuntimeMockState.preload.mockReset();
        markdownRuntimeMockState.preload.mockImplementation(() => Promise.resolve());
        jumpToTranscriptSeqMockState.implementation = null;
        viewportControllerMockState.resolveInputs = [];
        sessionState = {
            id: 'session-1',
            seq: 0,
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
            agentState: null,
        };
        syncTuningState = {
            transcriptForwardPrefetchThresholdPx: 0,
            transcriptBackwardPrefetchThresholdPx: 0,
            transcriptFlashListEstimatedItemSize: 120,
            transcriptWebHotTailItemCount: 2,
            transcriptWebInitialPinStabilizeMs: 3000,
            transcriptWebInitialPinRetryIntervalMs: 250,
            transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
            transcriptOlderLoadSpinnerDelayMs: 300,
            transcriptViewportAnchorCaptureDebounceMs: 200,
            transcriptViewportAnchorOlderLookupMaxLoads: 1,
            transcriptViewportAnchorRenderRetryMax: 4,
            transcriptDerivedItemsCacheMaxSessions: 8,
            transcriptItemHeightCacheMaxEntries: 1024,
            transcriptFlashListDrawDistance: 0,
            transcriptMountSettleQuiescentWindowMs: 120,
            transcriptMountSettleDimensionNoiseFloorPx: 1,
            transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
            transcriptInitialFillBudgetMs: 2000,
        };
        for (const k of Object.keys(settingValues)) delete settingValues[k];
        settingValues.transcriptGroupingMode = 'linear';
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.transcriptListImplementation = 'flash_v2';
        requireSelectionProviderForRenderedMessages = false;
    });

    afterEach(async () => {
        // Prevent initial-pin stabilization timeouts from leaking across tests and mutating later
        // tests' mocked DOM scroll containers (especially when fake timers are advanced).
        for (const tree of mountedTrees) {
            act(() => {
                tree.unmount();
            });
        }
        mountedTrees.length = 0;
        try {
            vi.useRealTimers();
        } catch {
            // no-op
        }
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        telemetryMod.transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    });

    it('omits maintainVisibleContentPosition on web to avoid FlashList layout crashes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(renderedFlatListCount).toBe(0);
        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();
    });

    it('provides message selection context for transcript rows', async () => {
        requireSelectionProviderForRenderedMessages = true;
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(renderedMessageViewProps.map((messageProps) => messageProps.message?.id)).toEqual(['u1', 'a1']);
    });

    it('keeps drag scrolling from dismissing the keyboard on iOS', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(renderedFlatListCount).toBe(0);
        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(screen.getCapturedFlashListProps().keyboardShouldPersistTaps).toBe('handled');
        expect(screen.getCapturedFlashListProps().keyboardDismissMode).toBe('none');
    });

    it('defers native FlashList bottom pin until mount settle for fresh follow-bottom entries', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 2 });

            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);

            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 900,
                animated: false,
            });
        });
    });

    it('does not issue a default native materialization pin when first content becomes scrollable', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const syncMod = await import('@/sync/sync');
            vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
                loaded: 0,
                hasMore: false,
                status: 'no_more',
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 600, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await act(async () => {
                getCapturedFlashListProps().onContentSizeChange(0, 1200);
            });
            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 2 });

            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'content-size-change',
                type: 'auto-follow',
            }));
            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('skips automatic native follow-bottom writes in MVCP-only mode for short-to-long materialization', async () => {
        runtimeMockState.platformOs = 'ios';
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });
        const syncMod = await import('@/sync/sync');
        vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
            loaded: 0,
            hasMore: false,
            status: 'no_more',
        });
        const scrollToOffset = vi.fn();
        flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptNativeMvcpOnlyMode: true,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 600, { turns: 2 });

        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-write',
            writer: 'mvcp-skip',
            reason: 'initial-open',
            platform: 'ios',
            listImplementation: 'flash_v2',
            mode: 'follow-bottom',
            layoutHeight: 600,
            contentHeight: 600,
        }));
        telemetrySink.mockClear();

        await act(async () => {
            getCapturedFlashListProps().onContentSizeChange(0, 1200);
        });
        await screen.settle({ turns: 2 });

        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-write',
            writer: 'mvcp-skip',
            reason: 'content-size-change',
            platform: 'ios',
            listImplementation: 'flash_v2',
            mode: 'follow-bottom',
            layoutHeight: 600,
            contentHeight: 1200,
        }));
    });

    it('skips automatic native follow-bottom writes in MVCP-only mode for streaming appends while pinned', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 16,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptNativeMvcpOnlyMode: true,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 16,
            };
            sessionState = { ...sessionState, active: true };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'streaming' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(500, 1000, { turns: 2 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, turns: 1 });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'streaming' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'append' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await act(async () => {
                getCapturedFlashListProps().onContentSizeChange(0, 1300);
            });
            await screen.settle({ advanceTimersMs: 1, turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                writer: 'mvcp-skip',
                reason: 'stream-append',
                platform: 'ios',
                listImplementation: 'flash_v2',
                mode: 'follow-bottom',
                layoutHeight: 500,
                contentHeight: 1300,
            }));
        });
    });

    it('records passive native drift skips in MVCP-only mode', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 16,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptNativeMvcpOnlyMode: true,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 16,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            await scrollFlashListTo(900, { trusted: false, turns: 1 });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await scrollFlashListTo(0, { trusted: false, turns: 1 });
            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                writer: 'mvcp-skip',
                reason: 'passive-drift',
                platform: 'ios',
                listImplementation: 'flash_v2',
                mode: 'follow-bottom',
                layoutHeight: 100,
                contentHeight: 1000,
            }));
        });
    });

    it('records every native FlashList scroll observation for high-frequency viewport instrumentation', async () => {
        runtimeMockState.platformOs = 'ios';
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 32,
            sink: telemetrySink,
        });
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptNativeMvcpOnlyMode: true,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 32,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });
        telemetrySink.mockClear();

        await scrollFlashListTo(830, { trusted: false, turns: 1 });

        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-observed',
            reason: 'observed',
            platform: 'ios',
            listImplementation: 'flash_v2',
            mode: 'follow-bottom',
            offsetY: 830,
            layoutHeight: 100,
            contentHeight: 1000,
            distanceFromBottom: 70,
        }));
    });

    it('keeps explicit native jump-to-bottom writes in MVCP-only mode', async () => {
        runtimeMockState.platformOs = 'ios';
        const scrollToOffset = vi.fn();
        flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
        syncTuningState = { ...syncTuningState, transcriptNativeMvcpOnlyMode: true };
        settingValues.transcriptScrollJumpToBottomEnabled = true;
        settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });
        scrollToOffset.mockClear();

        await scrollFlashListTo(200, { trusted: true, turns: 1 });
        const jumpButton = screen.findAllByTestId('transcript-jump-to-bottom')[0] as { props?: { onPress?: () => void } };
        expect(typeof jumpButton.props?.onPress).toBe('function');
        await act(async () => {
            jumpButton.props?.onPress?.();
        });

        expect(scrollToOffset).toHaveBeenCalledWith({
            offset: 900,
            animated: false,
        });
    });

    it('keeps native jumpToSeq writes in MVCP-only mode', async () => {
        runtimeMockState.platformOs = 'ios';
        const scrollToIndex = vi.fn();
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex };
        syncTuningState = { ...syncTuningState, transcriptNativeMvcpOnlyMode: true };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} jumpToSeq={2} />);
        await screen.settle({ turns: 2 });

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 1,
            animated: true,
            viewPosition: 0.5,
        });
    });

    it('restores native unpinned entry snapshots in MVCP-only mode', async () => {
        runtimeMockState.platformOs = 'ios';
        const scrollToOffset = vi.fn();
        flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
        syncTuningState = { ...syncTuningState, transcriptNativeMvcpOnlyMode: true };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 120,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'observed',
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(scrollToOffset).toHaveBeenCalledWith({
            offset: 780,
            animated: false,
        });
    });

    it('coalesces native unpinned distance restores until the pending target is observed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 657,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(667, 35736, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 34412,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListContentSizeChange(400, 33818, { turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await scrollFlashListTo(33018, { trusted: false, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.settle({
                advanceTimersMs: 1000,
                cycles: 3,
                turns: 4,
            });

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 32494,
                animated: false,
            });

            await scrollFlashListTo(32494, { trusted: false, turns: 1 });
            scrollToOffset.mockClear();
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('keeps native unpinned distance restore pending when the target offset is observed with stale smaller content metrics', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 390,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(682, 2262, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 1190,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                1190,
                {
                    contentSize: { height: 2135 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );

            await triggerFlashListChatListContentSizeChange(400, 3140, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 2068,
                animated: false,
            });
            scrollToOffset.mockClear();

            await scrollFlashListTo(2068, { trusted: false, turns: 1 });
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('uses native scroll content basis for unpinned distance restores with composer inset', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 391,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            const inset = screen.findByTestId('transcript-composer-keyboard-inset') as {
                props?: { onHeightChange?: (height: number) => void };
            };
            await act(async () => {
                inset.props?.onHeightChange?.(134);
            });

            await primeFlashListMetrics(682, 2128, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 1055,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                1055,
                {
                    contentSize: { height: 2128 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );

            await triggerFlashListChatListContentSizeChange(400, 3006, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 1933,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                1933,
                {
                    contentSize: { height: 3006 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('keeps native unpinned distance restore pending when an early clamped target offset is observed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 429,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(682, 942, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 0,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                0,
                {
                    contentSize: { height: 942 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 3043, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 1932,
                animated: false,
            });
        });
    });

    it('restores native unpinned entry snapshots after session remounts in MVCP-only mode', async () => {
        runtimeMockState.platformOs = 'ios';
        const scrollToOffset = vi.fn();
        flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
        syncTuningState = { ...syncTuningState, transcriptNativeMvcpOnlyMode: true };
        sessionViewportByIdState.set('session-a', {
            isPinned: false,
            offsetY: 140,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'observed',
        });
        sessionViewportByIdState.set('session-b', {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'default',
        });

        const { ChatList } = await import('./ChatList');

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-u1', localId: null, createdAt: 1, seq: 1, text: 'session a' }],
        };
        const firstA = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });
        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 760, animated: false });
        unmountTrackedFlashListChatList(firstA);

        scrollToOffset.mockClear();
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'b-u1', localId: null, createdAt: 1, seq: 1, text: 'session b' }],
        };
        const firstB = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-b' }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });
        expect(scrollToOffset).not.toHaveBeenCalled();
        unmountTrackedFlashListChatList(firstB);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-u1', localId: null, createdAt: 1, seq: 1, text: 'session a' }],
        };
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 760, animated: false });
    });

    it('leaves native FlashList drawDistance unset by default', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps().drawDistance).toBeUndefined();
    });

    it('passes configured native FlashList drawDistance without affecting web', async () => {
        syncTuningState = { ...syncTuningState, transcriptFlashListDrawDistance: 1600 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        runtimeMockState.platformOs = 'web';
        const webScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        expect(webScreen.getCapturedFlashListProps().drawDistance).toBeUndefined();
        unmountTrackedFlashListChatList(webScreen);

        runtimeMockState.platformOs = 'ios';
        const nativeScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        expect(nativeScreen.getCapturedFlashListProps().drawDistance).toBe(1600);
    });

    it('keeps native first-paint placeholder until FlashList mount settle', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await triggerFlashListChatListLoad(12, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            await settleNativeFlashListMount(screen);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('releases native first-paint placeholder after the mount-settle budget when FlashList never stabilizes', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await triggerFlashListChatListLoad(12, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('releases native first-paint placeholder after the mount-settle budget when FlashList onLoad never fires', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('flushes a pending native bottom pin at the mount-settle deadline without replaying recycled same-content drift', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
            scrollToOffset.mockClear();

            await scrollFlashListTo(300, { trusted: false, turns: 1 });
            await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('retries pending native bottom pin when content grows after an unobserved mount-settle write', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: {
                        layout: {
                            height: 682,
                            width: 400,
                        },
                    },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 65127, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 64445, animated: false });
            scrollToOffset.mockClear();

            await triggerFlashListChatListContentSizeChange(400, 74324, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 73642, animated: false });
        });
    });

    it('keeps native first-paint placeholder until a deadline bottom pin is observed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await scrollFlashListTo(600, { trusted: false, turns: 2 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('retries an unobserved native mount-settle bottom pin in MVCP-only mode before releasing first paint', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            syncTuningState = {
                ...syncTuningState,
                transcriptNativeMvcpOnlyMode: true,
            };
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await triggerFlashListChatListScroll(
                0,
                {
                    contentSize: { height: 1200 },
                    layoutMeasurement: { height: 600 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledTimes(2);
            expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 600, animated: false });

            await scrollFlashListTo(600, { trusted: false, turns: 2 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('keeps recycled passive native mount observations outside replayable mount-settle corrections', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: {
                        layout: {
                            height: 682,
                            width: 400,
                        },
                    },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 9431, { turns: 1 });
            await triggerFlashListChatListScroll(
                4440.666666666667,
                {
                    contentSize: { height: 9153 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 8019, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith(expect.objectContaining({
                animated: false,
                offset: expect.any(Number),
            }));
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                7059,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            const autoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(autoFollowReasons).toEqual([]);
            expect(autoFollowReasons).not.toEqual(expect.arrayContaining([
                'content-size-change',
                'initial-open',
                'layout-change',
                'passive-drift',
            ]));
            expect(scrollToOffset).not.toHaveBeenCalled();

            const automaticNativeWrites = telemetrySink.mock.calls
                .map(([event]) => event)
                .filter((event) =>
                    event.type === 'scroll-write' &&
                    event.writer === 'native-scroll-to-offset' &&
                    ['content-size-change', 'initial-open', 'mount-settle', 'passive-drift', 'stream-append'].includes(event.reason)
                );
            expect(automaticNativeWrites.map((event) => event.reason)).toEqual(
                automaticNativeWrites.map(() => 'mount-settle'),
            );
            expect(automaticNativeWrites.length).toBeGreaterThanOrEqual(1);
        });
    });

    it('cancels a delayed native mount-settle retry when bottom is observed before the throttle fires', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 667.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 12415, { turns: 1 });
            await triggerFlashListChatListScroll(
                6078.666666666667,
                {
                    contentSize: { height: 12283 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10336, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                turns: 2,
            });
            await screen.update(<ChatList session={{ ...sessionState }} />);
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                4000,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            await act(async () => {
                vi.advanceTimersByTime(201);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('cancels a queued native mount-settle retry when bottom is observed before the microtask runs', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
            scrollToOffset.mockClear();

            await act(async () => {
                const props = getCapturedFlashListProps();
                props.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 300 },
                        contentSize: { height: 1200 },
                        layoutMeasurement: { height: 600 },
                    },
                });
                props.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 600 },
                        contentSize: { height: 1200 },
                        layoutMeasurement: { height: 600 },
                    },
                });
            });
            await screen.settle({ turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('retries native mount-settle when a stale off-bottom observation follows a stable bottom confirmation', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 667.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 12415, { turns: 1 });
            await triggerFlashListChatListScroll(
                6078.666666666667,
                {
                    contentSize: { height: 12283 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10336, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                turns: 2,
            });
            await screen.update(<ChatList session={{ ...sessionState }} />);
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                4000,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            expect(scrollToOffset).not.toHaveBeenCalled();
            await act(async () => {
                vi.advanceTimersByTime(201);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
        });
    });

    it('retries native mount-settle when a recycled observation follows bottom confirmation without a later bottom observation', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 547096, { turns: 1 });
            await triggerFlashListChatListScroll(
                435088.6666666667,
                {
                    contentSize: { height: 546964 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 546413,
                animated: false,
            });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await act(async () => {
                const flashListProps = getCapturedFlashListProps();
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 435088.6666666667 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                vi.advanceTimersByTime(1);
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 546281.6666666666 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                vi.advanceTimersByTime(1);
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 435088.6666666667 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
            });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'recycled-event',
                offsetY: 435088.6666666667,
                distanceFromBottom: 111193,
            }));

            vi.advanceTimersByTime(201);
            await Promise.resolve();
            await Promise.resolve();

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 546413,
                animated: false,
            });
        });
    });

    it('retries same-frame stale native observations outside accepted movement when no later bottom observation arrives', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 7810, { turns: 1 });
            await triggerFlashListChatListScroll(
                5655,
                {
                    contentSize: { height: 7676 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10547, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9864,
                animated: false,
            });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await act(async () => {
                const flashListProps = getCapturedFlashListProps();
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 8392 },
                        contentSize: { height: 10413 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 9730.666666666666 },
                        contentSize: { height: 10413 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 8392 },
                        contentSize: { height: 10413 },
                        layoutMeasurement: { height: 682 },
                    },
                });
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            await act(async () => {
                vi.advanceTimersByTime(201);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9864,
                animated: false,
            });
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'pending',
                offsetY: 8392,
                distanceFromBottom: 1339,
            }));
            expect(telemetrySink.mock.calls).not.toContainEqual([
                expect.objectContaining({
                    type: 'scroll-observed',
                    reason: 'observed',
                    offsetY: 8392,
                    distanceFromBottom: 1339,
                }),
            ]);
        });
    });

    it('retries same-timestamp stale native observations after bottom confirmation and content shrink', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 9613, { turns: 1 });
            await triggerFlashListChatListScroll(
                4684.666666666667,
                {
                    contentSize: { height: 9488 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 8020, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 7337,
                animated: false,
            });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await act(async () => {
                const flashListProps = getCapturedFlashListProps();
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 3091.6666666666665 },
                        contentSize: { height: 7895 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 7213 },
                        contentSize: { height: 7895 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 3091.6666666666665 },
                        contentSize: { height: 7895 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            await act(async () => {
                vi.advanceTimersByTime(201);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 7337,
                animated: false,
            });
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'pending',
                offsetY: 3091.6666666666665,
                distanceFromBottom: 4121,
            }));
            expect(telemetrySink.mock.calls).not.toContainEqual([
                expect.objectContaining({
                    type: 'scroll-observed',
                    reason: 'observed',
                    offsetY: 3091.6666666666665,
                    distanceFromBottom: 4121,
                }),
            ]);
        });
    });

    it('allows a stale-observation mount-settle retry while native mount settle remains active', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptMountSettleQuiescentWindowMs: 1000,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
            scrollToOffset.mockClear();

            await triggerFlashListChatListContentSizeChange(400, 1400, { turns: 1 });

            await act(async () => {
                const flashListProps = getCapturedFlashListProps();
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 300 },
                        contentSize: { height: 1400 },
                        layoutMeasurement: { height: 600 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 800 },
                        contentSize: { height: 1400 },
                        layoutMeasurement: { height: 600 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 300 },
                        contentSize: { height: 1400 },
                        layoutMeasurement: { height: 600 },
                    },
                });
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            await act(async () => {
                vi.advanceTimersByTime(201);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'pending',
                offsetY: 300,
                distanceFromBottom: 500,
            }));
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'recycled-event',
                offsetY: 300,
                distanceFromBottom: 500,
            }));
            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 800, animated: false });
        });
    });

    it('classifies stale native observations after bottom confirmation outside accepted movement', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 547096, { turns: 1 });
            await triggerFlashListChatListScroll(
                435088.6666666667,
                {
                    contentSize: { height: 546964 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 546413,
                animated: false,
            });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await act(async () => {
                getCapturedFlashListProps().onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 435088.6666666667 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
            });
            vi.advanceTimersByTime(1);
            await act(async () => {
                const flashListProps = getCapturedFlashListProps();
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 546281.6666666666 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 435088.6666666667 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
                flashListProps.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 546281.6666666666 },
                        contentSize: { height: 546964 },
                        layoutMeasurement: { height: 682 },
                    },
                });
            });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'recycled-event',
                offsetY: 435088.6666666667,
                distanceFromBottom: 111193,
            }));
            expect(telemetrySink.mock.calls).not.toContainEqual([
                expect.objectContaining({
                    type: 'scroll-observed',
                    reason: 'observed',
                    offsetY: 435088.6666666667,
                    distanceFromBottom: 111193,
                }),
            ]);
            vi.advanceTimersByTime(201);
            await Promise.resolve();
            await Promise.resolve();

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('does not let native touch-start alone suppress stale mount bottom correction', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 667.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 12415, { turns: 1 });
            await triggerFlashListChatListScroll(
                6078.666666666667,
                {
                    contentSize: { height: 12283 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10336, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            screen.getCapturedFlashListProps().onTouchStart?.({});
            await triggerFlashListChatListScroll(
                4000,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            vi.advanceTimersByTime(251);
            await Promise.resolve();
            await Promise.resolve();

            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
        });
    });

    it('treats clamped native bottom observations as confirming pending mount-settle pins', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 942, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 259,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                133,
                {
                    contentSize: { height: 815 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                12,
                {
                    contentSize: { height: 815 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                133,
                {
                    contentSize: { height: 815 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            vi.advanceTimersByTime(201);
            await Promise.resolve();
            await Promise.resolve();

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('does not run a delayed native mount-settle retry after same-session jumpToSeq starts', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 667.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 12415, { turns: 1 });
            await triggerFlashListChatListScroll(
                6078.666666666667,
                {
                    contentSize: { height: 12283 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10336, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                turns: 2,
            });
            await screen.update(<ChatList session={{ ...sessionState }} />);
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                4000,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            await act(async () => {
                screen.tree.update(<ChatList session={{ ...sessionState }} jumpToSeq={1} />);
            });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('shows native first-paint placeholder when row-shell measurements are warm on a cold remount', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const cold = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(cold, 'transcript-first-paint-placeholder')).toBe(1);

        await fireTranscriptItemShellLayout(findTranscriptItemShell(cold, 'a1'), 148);
        unmountTrackedFlashListChatList(cold);

        const warm = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(warm, 'a1').props.style)).toBe(148);
        expect(countExactTestId(warm, 'transcript-first-paint-placeholder')).toBe(1);
    });

    it('suppresses native first-paint placeholder for a warm keep-alive instance', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState }} isWarmKeepAliveInstance={true} />,
        );

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('omits first-paint placeholder for web FlashList', async () => {
        runtimeMockState.platformOs = 'web';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('keeps web transcripts covered until the enriched Markdown runtime is ready', async () => {
        runtimeMockState.platformOs = 'web';
        markdownRuntimeMockState.ready = false;
        let resolvePreload: (() => void) | null = null;
        const preloadPromise = new Promise<void>((resolve) => {
            resolvePreload = () => {
                markdownRuntimeMockState.ready = true;
                resolve();
            };
        });
        markdownRuntimeMockState.preload.mockImplementation(() => preloadPromise);
        sessionMessagesState = {
            isLoaded: true,
            messages: [{
                kind: 'agent-text',
                id: 'a1',
                localId: null,
                createdAt: 1,
                text: '## Forensics\n\n`session-id` details',
            }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

        expect(resolvePreload).not.toBeNull();
        await act(async () => {
            resolvePreload?.();
        });
        await screen.settle({ turns: 1 });

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('uses static first-paint placeholder for reduced motion', async () => {
        runtimeMockState.platformOs = 'ios';
        reducedMotionMockState.preferred = true;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
        expect(countExactTestId(screen, 'transcript-first-paint-placeholder:spinner')).toBe(0);
    });

    it('applies cached row-shell minHeight before layout and releases it after layout', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'a1'), 148);
        unmountTrackedFlashListChatList(first);

        const second = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        const secondShell = findTranscriptItemShell(second, 'a1');

        expect(readStyleMinHeight(secondShell.props.style)).toBe(148);
        expect(second.getCapturedFlashListProps().estimatedItemSize).toBeUndefined();
        expect(second.getCapturedFlashListProps().overrideItemLayout).toBeUndefined();

        await fireTranscriptItemShellLayout(secondShell, 172);
        await second.settle({ turns: 1 });

        expect(readStyleMinHeight(findTranscriptItemShell(second, 'a1').props.style)).toBeUndefined();
        unmountTrackedFlashListChatList(second);

        const third = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(third, 'a1').props.style)).toBe(172);
    });

    it('keys cached row-shell heights by transcript layout width bucket', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const narrow = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await triggerFlashListChatListInitialFill({
            contentHeight: 1200,
            layoutHeight: 600,
            layoutWidth: 320,
            flushOptions: { turns: 1 },
        });
        await fireTranscriptItemShellLayout(findTranscriptItemShell(narrow, 'a1'), 148);
        unmountTrackedFlashListChatList(narrow);

        const wide = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await triggerFlashListChatListInitialFill({
            contentHeight: 1200,
            layoutHeight: 600,
            layoutWidth: 768,
            flushOptions: { turns: 1 },
        });

        expect(readStyleMinHeight(findTranscriptItemShell(wide, 'a1').props.style)).toBeUndefined();
        unmountTrackedFlashListChatList(wide);

        const narrowAgain = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await triggerFlashListChatListInitialFill({
            contentHeight: 1200,
            layoutHeight: 600,
            layoutWidth: 320,
            flushOptions: { turns: 1 },
        });

        expect(readStyleMinHeight(findTranscriptItemShell(narrowAgain, 'a1').props.style)).toBe(148);
    });

    it('does not cache active streaming rows as stable row-shell heights', async () => {
        sessionState = {
            ...sessionState,
            active: true,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'streaming reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'a1'), 180);
        unmountTrackedFlashListChatList(first);

        const second = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(second, 'a1').props.style)).toBeUndefined();
    });

    it('does not cache running tool-call rows as stable row-shell heights when they are not latest activity', async () => {
        sessionState = {
            ...sessionState,
            active: true,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                {
                    kind: 'tool-call',
                    id: 'tool-1',
                    localId: null,
                    createdAt: 1,
                    seq: 1,
                    tool: { id: 'tool-1', name: 'shell', state: 'running', input: { command: 'pwd' } },
                },
                { kind: 'agent-text', id: 'a-latest', localId: null, createdAt: 2, seq: 2, text: 'still working' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'tool-1'), 220);
        unmountTrackedFlashListChatList(first);

        const second = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(second, 'tool-1').props.style)).toBeUndefined();
    });

    it('reuses module-level linear derived items on cold A-to-B-to-A remounts', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };

        const { ChatList } = await import('./ChatList');
        const firstA = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        unmountTrackedFlashListChatList(firstA);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'b-user', localId: null, createdAt: 1, text: 'session b' }],
        };
        const firstB = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-b' }} />);
        unmountTrackedFlashListChatList(firstB);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);

        expect(linearItemsCacheBuildCalls.at(-1)).toMatchObject({
            cacheProvided: true,
            cacheHit: true,
        });
    });

    it('reuses module-level turn derived items on cold A-to-B-to-A remounts', async () => {
        settingValues.transcriptGroupingMode = 'turns';
        const sessionATurn = { id: 'turn:a', userMessageId: 'a-user', content: [{ kind: 'message', messageId: 'a-user' }] };
        const sessionBTurn = { id: 'turn:b', userMessageId: 'b-user', content: [{ kind: 'message', messageId: 'b-user' }] };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };
        transcriptTurnsState = [sessionATurn];

        const { ChatList } = await import('./ChatList');
        const firstA = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        unmountTrackedFlashListChatList(firstA);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'b-user', localId: null, createdAt: 1, text: 'session b' }],
        };
        transcriptTurnsState = [sessionBTurn];
        const firstB = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-b' }} />);
        unmountTrackedFlashListChatList(firstB);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };
        transcriptTurnsState = [sessionATurn];
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);

        expect(turnsCacheBuildCalls.at(-1)).toMatchObject({
            cacheProvided: true,
            cacheHit: true,
        });
    });

    it('invalidates module-level linear derived items when a session structure changes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'before' }],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        unmountTrackedFlashListChatList(first);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'after' }],
        };
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);

        expect(linearItemsCacheBuildCalls.at(-1)).toMatchObject({
            cacheProvided: true,
            cacheHit: false,
        });
    });

    it('uses bounded coarse FlashList item types for divergent transcript row shapes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u-short', localId: null, createdAt: 1, text: 'short' },
                { kind: 'user-text', id: 'u-long', localId: null, createdAt: 2, text: 'long '.repeat(120) },
                { kind: 'agent-text', id: 'a-short', localId: null, createdAt: 3, text: 'short reply' },
                { kind: 'agent-text', id: 'a-long', localId: null, createdAt: 4, text: 'long reply '.repeat(120) },
                { kind: 'agent-text', id: 'a-thinking', localId: null, createdAt: 5, text: 'thinking', isThinking: true },
                { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 6, tool: { name: 'shell' }, children: [] },
            ],
        };
        transcriptTurnsState = [{
            id: 'turn:tool',
            userMessageId: 'u-short',
            content: [{ kind: 'tool_calls', id: 'turn-tool-group', toolMessageIds: ['tool-1'] }],
        }];

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        const getItemType = screen.getCapturedFlashListProps().getItemType;

        expect(typeof getItemType).toBe('function');

        const samples = [
            { kind: 'message', id: 'u-short', messageId: 'u-short', createdAt: 1, seq: null },
            { kind: 'message', id: 'u-long', messageId: 'u-long', createdAt: 2, seq: null },
            { kind: 'message', id: 'a-short', messageId: 'a-short', createdAt: 3, seq: null },
            { kind: 'message', id: 'a-long', messageId: 'a-long', createdAt: 4, seq: null },
            { kind: 'message', id: 'a-thinking', messageId: 'a-thinking', createdAt: 5, seq: null },
            { kind: 'message', id: 'tool-1', messageId: 'tool-1', createdAt: 6, seq: null },
            { kind: 'tool-calls-group', id: 'toolCalls:linear:tool-1', toolMessageIds: ['tool-1'], createdAt: 6 },
            { kind: 'turn', id: 'turn:tool', turn: transcriptTurnsState[0] },
            { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [{}], discardedMessages: [] },
            { kind: 'action-draft', id: 'draft:1', draft: { id: 'draft-1' } },
            { kind: 'fork-divider', id: 'fork:1', parentSessionId: 'parent', childSessionId: 'child', parentCutoffSeqInclusive: 2 },
        ];
        const types = samples.map((sample, index) => getItemType(sample, index));

        expect(types[0]).not.toBe(types[1]);
        expect(types[2]).not.toBe(types[3]);
        expect(types[4]).not.toBe(types[2]);
        expect(types[5]).not.toBe(types[2]);
        expect(types[6]).not.toBe(types[5]);
        expect(types[10]).not.toBe(types[9]);
        expect(new Set(types).size).toBeLessThanOrEqual(12);
    });

    it('loads older messages when scrolled near the top (without requiring onStartReached)', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(100);

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('loads older messages near the top even when onScroll is not marked isTrusted (web)', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();

        await primeFlashListMetrics(600, 1200, { turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await scrollFlashListTo(100, { trusted: false });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('does not prefetch older messages while pinned at the bottom even when the top threshold is large', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 1200, { turns: 2, frames: 2 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await scrollFlashListTo(600);

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
    });

    it('keeps the older-load spinner hidden for fast proactive prefetch', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadSpinnerDelayMs: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await scrollFlashListTo(100);

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ turns: 1 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
    });

    it('shows the older-load spinner when proactive prefetch is slow', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadSpinnerDelayMs: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await scrollFlashListTo(100);

            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            await screen.settle({ advanceTimersMs: 300, cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            await screen.settle({ advanceTimersMs: 200, cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ turns: 1 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
    });

    it('shows the older-load spinner when the user reaches the edge during prefetch', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await scrollFlashListTo(100);

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            await triggerFlashListChatListStartReached({ turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ turns: 1 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
    });

    it('waits for web scroll metrics to settle before prefetching older messages during initial fill', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        const scrollEl: any = {
            scrollHeight: 100,
            clientHeight: 400,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 0,
            querySelectorAll: () => [],
            parentElement: null,
            isConnected: true,
        };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                expect(capturedFlashListProps).toBeTruthy();

                scrollEl.scrollHeight = 1600;
                await triggerFlashListChatListInitialFill({
                    layoutHeight: 100,
                    contentHeight: 100,
                    flushOptions: { turns: 3 },
                });

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(screen.getCapturedFlashListProps()).toBeTruthy();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
                useImmediateAnimationFrame: false,
            },
        );
    });

    it('ignores a web onStartReached misfire while the transcript is still pinned at the bottom', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1600,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 1000,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200, { turns: 1 });

                await scrollFlashListTo(600);

                loadOlderMessagesMock.mockClear();

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('ignores a web onStartReached event outside the configured older prefetch threshold', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 60,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 40 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200, { turns: 1 });
                expect(getCapturedFlashListProps().onStartReachedThreshold).toBeCloseTo(40 / 600, 4);
                await scrollFlashListTo(60);

                loadOlderMessagesMock.mockClear();

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('preserves the web viewport when older messages prepend above the current scroll position', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1800;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(700);
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-dom-restore',
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    previousOffsetY: 100,
                    targetOffsetY: 700,
                    layoutHeight: 600,
                    contentHeight: 1800,
                }));
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('continues preserving the web viewport if content grows again after the prepend commit', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1400;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(300);

                scrollEl.scrollHeight = 1800;
                await primeFlashListMetrics(600, 1800);

                expect(scrollEl.scrollTop).toBe(700);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('preserves the web viewport when the user keeps scrolling upward while older messages are still loading', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollTop = 60;
                await scrollFlashListTo(60);

                scrollEl.scrollHeight = 1400;
                resolveLoadOlder?.({ loaded: 5, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(260);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('keeps tracking the original web prepend anchor when it is temporarily unmounted during a large prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const visibleAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 120, bottom: 220 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [visibleAnchor],
        });

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(4100);

                visibleAnchor.setRect({ top: 300, bottom: 400 });
                scrollEl.scrollHeight = 5300;
                scrollEl.setQuerySelectorAll('[data-testid]', [visibleAnchor]);
                await primeFlashListMetrics(600, 5300);

                expect(scrollEl.scrollTop).toBe(4280);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('recovers the captured web prepend item when scrollHeight growth overshoots the original viewport anchor', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });

        const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 40, bottom: 340 });
        const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [itemAnchor, messageAnchor],
        });

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                itemAnchor.setRect({ top: 140, bottom: 440 });
                messageAnchor.setRect({ top: 220, bottom: 280 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
            }),
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                    index: 0,
                    animated: false,
                    viewPosition: 0,
                });
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-scroll-to-index',
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    targetOffsetY: 0,
                }));
                expect(scrollEl.scrollTop).toBe(4000);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('recovers by stable anchor identity when the captured turn wrapper id changes across the prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const staleItemAnchor = createFlashListChatListWebElement('transcript-item-turn:stale', { top: 20, bottom: 360 });
        const stableMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [staleItemAnchor, stableMessageAnchor],
        });

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                stableMessageAnchor.setRect({ top: 150, bottom: 210 });
                scrollEl.setQuerySelectorAll('[data-testid]', [stableMessageAnchor]);
            }),
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                    index: 0,
                    animated: false,
                    viewPosition: 0,
                });
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('uses native bottom-maintenance settings after mount settle without a mid-settle threshold flip', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(screen.getCapturedFlashListProps()).not.toBeNull();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToTopThreshold).toBeUndefined();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.animateAutoScrollToBottom).toBe(false);
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBe(0);

            await primeFlashListMetrics(600, 1200, { turns: 4 });

            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBe(0);

            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBe(72 / 600);
        });
    });

    it('omits native bottom maintenance for unpinned entry restores', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 420,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();

            await primeFlashListMetrics(600, 1200, { turns: 2 });

            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 180,
                animated: false,
            });
        });
    });

    it('defers the initial native viewport pin until mount settle and only pins real streamed growth', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'long markdown' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 600,
                animated: false,
            });
            const settledAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(settledAutoFollowReasons).not.toContain('initial-open');
            scrollToOffset.mockClear();

            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            scrollToOffset.mockClear();

            viewportControllerMockState.resolveInputs = [];
            await primeFlashListMetrics(600, 1800, { advanceTimersMs: 1, turns: 1 });

            const remeasureAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(remeasureAutoFollowReasons).not.toContain('initial-open');
            expect(remeasureAutoFollowReasons).not.toContain('content-size-change');
            expect(scrollToOffset).not.toHaveBeenCalled();

            sessionState = {
                ...sessionState,
                active: true,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'long markdown' },
                    { kind: 'assistant-text', id: 'a2', localId: null, createdAt: 3, text: 'streamed token' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await primeFlashListMetrics(600, 1900, { advanceTimersMs: 1, turns: 1 });
            const streamedGrowthAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(streamedGrowthAutoFollowReasons).toContain('stream-append');
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 1300,
                animated: false,
            });
        });
    });

    it('does not treat native pin callback churn as new transcript activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptNativeMvcpOnlyMode: false,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'long markdown' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);

            viewportControllerMockState.resolveInputs = [];
            syncTuningState = {
                ...syncTuningState,
                transcriptNativeMvcpOnlyMode: true,
            };
            await act(async () => {
                screen.tree.update(<ChatList session={{ ...sessionState }} />);
            });
            await screen.settle({ turns: 2 });

            const autoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(autoFollowReasons).not.toContain('initial-open');
        });
    });

    it('does not re-render native FlashList for post-fill content-size updates', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 1200, { turns: 4 });
        const rendersAfterInitialFill = renderedFlashListCount;

        await act(async () => {
            screen.getCapturedFlashListProps().onContentSizeChange?.(400, 1210);
        });
        await screen.settle({ cycles: 1, turns: 1 });

        expect(renderedFlashListCount).toBe(rendersAfterInitialFill);
    });

    it('releases native bottom follow on the first drag away from the tail', async () => {
        runtimeMockState.platformOs = 'ios';
        const onViewportChange = vi.fn();
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
        );

        await primeFlashListMetrics(100, 1000, { turns: 1 });
        onViewportChange.mockClear();

        await scrollFlashListTo(850, { trusted: true, turns: 1 });

        expect(onViewportChange).toHaveBeenLastCalledWith({
            isPinned: false,
            offsetY: 50,
            shouldRestoreViewport: true,
        });
    });

    it('keeps the native jump button hidden after non-user scroll drift while bottom follow is armed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            onViewportChange.mockClear();
            await scrollFlashListTo(0, { trusted: false, turns: 1 });

            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));
            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 1 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 900,
                animated: false,
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });

            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });
    });

    it('does not treat firstListPaint as stable settle for passive native drift', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            onViewportChange.mockClear();

            await scrollFlashListTo(0, { trusted: false, turns: 1 });

            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));
        });
    });

    it('does not repin recycled native drift before React observes mount settle as stable', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(682, 1810, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await triggerFlashListChatListScroll(
                1128,
                {
                    contentSize: { height: 1810 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 35663, { turns: 1 });
            await triggerFlashListChatListScroll(
                34980,
                {
                    contentSize: { height: 35663 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            vi.setSystemTime(new Date(350));
            flashListRefHandle.scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs.splice(0);

            await triggerFlashListChatListScroll(
                1012,
                {
                    contentSize: { height: 35433 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'passive-drift',
                type: 'auto-follow',
            }));
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                cycles: 1,
                turns: 2,
            });

            expect(viewportControllerMockState.resolveInputs).toContainEqual(expect.objectContaining({
                reason: 'mount-settle',
                type: 'auto-follow',
            }));
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: expect.any(Number),
                animated: false,
            });
        });
    });

    it('does not replay native mount-settle after recycled bottom-then-wrong observations', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 9431, { turns: 1 });
            await triggerFlashListChatListScroll(
                4440.666666666667,
                {
                    contentSize: { height: 9153 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 8019, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 7336,
                animated: false,
            });
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                7059,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'mount-settle',
                type: 'auto-follow',
            }));
            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('ignores passive native drift after quiescent settle without new committed activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            await scrollFlashListTo(900, { trusted: false, turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            onViewportChange.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await scrollFlashListTo(0, { trusted: false, turns: 1 });

            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 1 });
            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'passive-drift',
                type: 'auto-follow',
            }));
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                shouldRestoreViewport: false,
            }));
        });
    });

    it('memoizes maintainVisibleContentPosition to avoid prop churn (FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} bottomNotice={null} />);

        const first = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
        expect(first).toBeUndefined();

        await screen.update(<ChatList session={{ ...sessionState }} bottomNotice={null} />);

        const second = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
        expect(second).toBe(first);

        // Unmount handled by afterEach to ensure stabilization timers are cancelled.
    });

    it('renders ListHeaderComponent above items and ChatFooter as ListFooterComponent (non-inverted FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        const flashListProps = screen.getCapturedFlashListProps();
        const headerEl = flashListProps.ListHeaderComponent;
        const footerEl = flashListProps.ListFooterComponent;

        // The header owns the optional older-loading affordance, not surrounding chrome spacing.
        expect(typeof headerEl?.props?.isLoadingOlder).toBe('boolean');
        // The footer can be wrapped by the web hot-tail split, but it must still render ChatFooter.
        expect(footerEl).toBeTruthy();
        expectScreenHasTestId(screen, 'chat-footer');

        // Render sanity: FlashList still mounts in tree.
        expectScreenHasTestId(screen, 'flash-list');
    });

    it('extends the transcript footer with the composer keyboard inset', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expectScreenHasTestId(screen, 'chat-footer');
        expectScreenHasTestId(screen, 'transcript-composer-keyboard-inset');
    });

    it('does not reserve header chrome space inside the transcript list header', async () => {
        runtimeMockState.headerHeight = 88;
        runtimeMockState.safeAreaTop = 20;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        const duplicatedChromeSpacerHeight = runtimeMockState.headerHeight + runtimeMockState.safeAreaTop + 32;
        const duplicatedChromeSpacers = screen.findAll((node) => {
            const style = node.props?.style;
            if (Array.isArray(style)) {
                return style.some((entry) => entry?.height === duplicatedChromeSpacerHeight);
            }
            return style?.height === duplicatedChromeSpacerHeight;
        });
        expect(duplicatedChromeSpacers).toHaveLength(0);
    });

    it('keeps a compact top gutter before the first transcript row', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        const compactTopGutters = screen.findAll((node) => node.props?.style?.height === 12);
        expect(compactTopGutters.length).toBeGreaterThanOrEqual(1);
    });

    it('renders only cold history inside the web FlashList data and moves the live tail into the footer', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one' },
                { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'two' },
                { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, text: 'three' },
                { kind: 'user-text', id: 'u4', localId: null, createdAt: 4, text: 'four' },
            ],
        };
        syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 2 };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect((screen.getCapturedFlashListProps().data ?? []).map((item: any) => item.id)).toEqual(['u1', 'u2']);
        expectScreenHasTestId(screen, 'transcript-web-hot-tail');
        expectScreenHasTestId(screen, 'transcript-web-hot-tail-item-u3');
        expectScreenHasTestId(screen, 'transcript-web-hot-tail-item-u4');
        expectScreenHasTestId(screen, 'chat-footer');
    });

    it('pins via DOM scroll on web without calling scrollToOffset when DOM pinning is possible', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTop: 0,
            scrollTo: vi.fn(() => {
                throw new Error('should not call scrollTo (RNW overrides scrollTo signature)');
            }),
            querySelectorAll: () => [],
            parentElement: null,
        };

        const fakeDocument: any = { getElementById: vi.fn(() => scrollEl) };
        const fakeWindow: any = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };
        (globalThis as any).document = fakeDocument;
        (globalThis as any).window = fakeWindow;

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect((scrollEl as any).scrollTop).toBeGreaterThan(0);
                expect(scrollEl.scrollTo).not.toHaveBeenCalled();
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('does not fall back to scrollToOffset on web when DOM pinning is unavailable (prevents mount jitter)', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            null,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => null) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('continues initial web stabilization for delayed DOM height growth', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 0,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(900);

                    scrollEl.scrollHeight = 1400;
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(1300);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses configured early initial web stabilization retry milestones', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 1500,
                transcriptWebInitialPinRetryIntervalMs: 2000,
                transcriptWebInitialPinRetryMilestonesMs: [700],
            };
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 0,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(900);

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 600 });
                    scrollEl.scrollHeight = 1400;

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 100 });

                    expect(scrollEl.scrollTop).toBe(1300);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses the short stabilization fallback when tuning is malformed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: Number.NaN,
            };
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 0,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(900);

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 1600 });
                    scrollEl.scrollHeight = 1400;
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps the settled web bottom unchanged during initial stabilization retries', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                querySelectorAll: () => [],
                parentElement: null,
            };

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(1000);
                    scrollEl.scrollTop = 1000;

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(1000);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('restores an observed unpinned session on entry without auto-pinning it', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 420,
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(480);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('persists an observed unpinned snapshot when a real web scroll-up collapses the ref-based distance to zero', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            // Route the emit through the real sync viewport routing (as SessionView does) so this test
            // exercises the full web capture -> persist -> restore contract end to end.
            const onViewportChange = vi.fn((state: any) => routeSessionViewportChangeIntoTestStore('session-1', state));
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            // The live DOM scroller reports a genuine reading position above the tail
            // (scrollTop 500 of a 1100 max), so the true distance from bottom is 600.
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 500,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    // The web hot/cold split can leave the FlashList content height collapsed to the
                    // layout height while the tail renders in the footer, so the ref-based distance
                    // computation yields 0 even though the user has scrolled up.
                    await primeFlashListMetrics(100, 100, { turns: 1 });
                    onViewportChange.mockClear();

                    // The real DOM scroller is at a genuine mid-transcript reading position even though
                    // FlashList's collapsed hot/cold content reports its own scroll offset as 0.
                    scrollEl.scrollTop = 500;
                    // A genuine scrollbar-drag / keyboard scroll-up: RNW does not always mark the
                    // synthetic scroll event as trusted and there is no preceding pointer event.
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });

                    // The user released bottom-follow: the stored intent must be an observed
                    // restore snapshot with the true distance from bottom, not a live-tail re-pin.
                    expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                        isPinned: false,
                        offsetY: 600,
                        shouldRestoreViewport: true,
                    }));

                    const stored = sessionViewportByIdState.get('session-1');
                    expect(stored).toMatchObject({ source: 'observed', isPinned: false, offsetY: 600 });
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );

            // Returning to the session after a switch restores the saved reading position from the
            // observed snapshot the web scroll-up just produced (not the bottom).
            const restoredScrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 1100,
            });
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            await withFlashListChatListWebScrollerDom(
                restoredScrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(restoredScrollEl.scrollTop).toBe(500);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => restoredScrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('shows the jump-to-bottom affordance on web when unpinned even without new activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            settingValues.transcriptScrollJumpToBottomEnabled = true;
            settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 500,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 100, { turns: 1 });

                    // Scroll up without any new activity arriving.
                    scrollEl.scrollTop = 500;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });

                    // Even with newActivityCount === 0, an unpinned web transcript should expose the
                    // jump-to-bottom affordance so the user can return to the live tail.
                    expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('restores a materialized session-switch anchor after tail growth while away', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                anchor: {
                    kind: 'message',
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'new tail while hidden' },
                ],
            };

            const itemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 160, bottom: 260 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 170, bottom: 220 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 0,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1200, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 1 });

                    expect(scroller.scrollTop).toBe(120);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('preserves the stored entry anchor when reporting initial unpinned viewport state', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            const storedAnchor = {
                kind: 'message' as const,
                messageId: 'm2',
                itemId: 'm2',
                itemOffsetPx: 40,
                capturedAtMs: 1,
            };
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                anchor: storedAnchor,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const itemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 160, bottom: 260 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 170, bottom: 220 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 0,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1200, { turns: 2, frames: 1 });

                    expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                        shouldRestoreViewport: true,
                        anchor: storedAnchor,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('captures a viewport anchor on scroll settle without capturing every scroll frame', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 125,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 80, bottom: 180 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 90, bottom: 150 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 500,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1000, { turns: 1 });

                    onViewportChange.mockClear();
                    scroller.scrollTop = 500;
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });
                    scroller.scrollTop = 520;
                    await scrollFlashListTo(520, { trusted: true, turns: 1 });

                    expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                        anchor: expect.anything(),
                    }));

                    await act(async () => {
                        vi.advanceTimersByTime(124);
                    });

                    expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                        anchor: expect.anything(),
                    }));

                    await act(async () => {
                        vi.advanceTimersByTime(1);
                    });

                    expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                        anchor: expect.objectContaining({
                            kind: 'message',
                            messageId: 'm1',
                            itemId: 'm1',
                            itemOffsetPx: 80,
                        }),
                        shouldRestoreViewport: true,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses configured zero anchor render retries before falling back to distance restore', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebHotTailItemCount: 0,
                transcriptViewportAnchorRenderRetryMax: 0,
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 300,
                anchor: {
                    kind: 'message',
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2 });

                    expect(scroller.scrollTop).toBe(600);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('forces the final viewport anchor capture when the session unmounts before scroll settle', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 70, bottom: 170 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 80, bottom: 140 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 500,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1000, { turns: 1 });

                    onViewportChange.mockClear();
                    scroller.scrollTop = 500;
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });
                    await screen.unmount();

                    expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                        anchor: expect.objectContaining({
                            messageId: 'm1',
                            itemId: 'm1',
                            itemOffsetPx: 70,
                        }),
                        shouldRestoreViewport: true,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('forces the final viewport anchor capture before a surviving list changes session id', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 70, bottom: 170 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 80, bottom: 140 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 500,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1000, { turns: 1 });

                    onViewportChange.mockClear();
                    scroller.scrollTop = 500;
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });
                    await screen.update(
                        <ChatList
                            session={{ ...sessionState, id: 'session-2' }}
                            onViewportChange={onViewportChange}
                        />,
                    );

                    expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                        anchor: expect.objectContaining({
                            messageId: 'm1',
                            itemId: 'm1',
                            itemOffsetPx: 70,
                        }),
                        shouldRestoreViewport: true,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('ignores recycled native scroll offsets before the next session has measured its transcript', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let activeSessionId = 'session-1';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();
            await scrollFlashListTo(400, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 500,
                source: 'observed',
            });

            sessionViewportByIdState.set('session-2', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            activeSessionId = 'session-2';
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'alpha' },
                    { kind: 'agent-text', id: 'b2', localId: null, createdAt: 2, seq: 2, text: 'beta' },
                ],
            };

            await screen.update(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ turns: 1 });
            onViewportChange.mockClear();

            await scrollFlashListTo(400, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-2')).toMatchObject({
                isPinned: false,
                offsetY: 200,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                offsetY: 500,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('does not let passive native bottom drift erase a restored unpinned session viewport', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let activeSessionId = 'session-1';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 700,
                animated: false,
            });

            onViewportChange.mockClear();
            await scrollFlashListTo(900, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 200,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
        });
    });

    it('preserves passive native movement near the bottom after the user leaves the tail', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            const dateNowSpy = vi.spyOn(Date, 'now');
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            try {
                dateNowSpy.mockReturnValue(0);
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
                );

                await primeFlashListMetrics(100, 1000, { turns: 4 });
                await scrollFlashListTo(850, { trusted: true, turns: 1 });

                onViewportChange.mockClear();
                dateNowSpy.mockReturnValue(1000);
                await scrollFlashListTo(830, { trusted: false, turns: 1 });

                expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                    isPinned: false,
                    offsetY: 70,
                    shouldRestoreViewport: true,
                }));
            } finally {
                dateNowSpy.mockRestore();
            }
        });
    });

    it('persists passive native movement after a restored unpinned viewport is applied', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 700,
                animated: false,
            });

            await scrollFlashListTo(700, { trusted: false, turns: 1 });
            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(600, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 300,
                source: 'observed',
            });
            expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                isPinned: false,
                offsetY: 300,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('does not capture stale native anchors for passive unpinned movement', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 0 })),
                getAbsoluteLastScrollOffset: vi.fn(() => 700),
                getLayout: vi.fn(() => ({ x: 0, y: 720, width: 320, height: 80 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 700,
                animated: false,
            });

            await scrollFlashListTo(700, { trusted: false, turns: 1 });
            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(600, { trusted: false, turns: 1 });
            await vi.advanceTimersByTimeAsync(syncTuningState.transcriptViewportAnchorCaptureDebounceMs + 1);

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 300,
                anchor: null,
                source: 'observed',
            });
            expect(flashListRefHandle.computeVisibleIndices).not.toHaveBeenCalled();
        });
    });

    it('does not let delayed passive native bottom drift erase a newly unpinned session viewport', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();
            await scrollFlashListTo(800, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });

            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(900, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
        });
    });

        it('ignores delayed native jumps to recycled top offsets after the user unpins', async () => {
            await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();
            await scrollFlashListTo(800, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });

            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(0, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                offsetY: 900,
                shouldRestoreViewport: true,
            }));
            });
        });

        it('retries native stored viewport restore when content grows before the target scroll is observed', async () => {
            await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 800, animated: false });
            scrollToOffset.mockClear();

            await scrollFlashListTo(600, { trusted: false, turns: 1 });
            await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1000, animated: false });
            });
        });

        it('defers automatic native follow-bottom pins until mount settle is stable', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const scrollToOffset = vi.fn();
                flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    ],
                };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-1' }} />,
                );

                await primeFlashListMetrics(100, 1000, { turns: 4 });
                expect(scrollToOffset).not.toHaveBeenCalled();
                await settleNativeFlashListMount(screen);

                expect(scrollToOffset).toHaveBeenCalledWith({ offset: 900, animated: false });
            });
        });

        it('uses native drag intent to release bottom follow when scroll events are not trusted', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            onViewportChange.mockClear();
            screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            await scrollFlashListTo(800, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });
            expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                isPinned: false,
                offsetY: 100,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('coarsely scrolls to a materialized anchor and applies fine correction after the row mounts', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 0 };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 300,
                anchor: {
                    kind: 'message',
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2 });

                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                        index: 1,
                        animated: false,
                        viewPosition: 0,
                    });
                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();

                    const itemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 160, bottom: 260 });
                    const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 170, bottom: 220 });
                    messageAnchor.parentElement = itemAnchor;
                    scroller.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);

                    await primeFlashListMetrics(100, 1001, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 1, runOnlyPendingTimers: true });

                    expect(scroller.scrollTop).toBe(120);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('resolves anchor indexes by message id across message, tool-group, and turn rows', async () => {
        const cases: Array<{
            label: string;
            configure: () => void;
            expectedIndex: number;
            messageId: string;
        }> = [
            {
                label: 'message',
                expectedIndex: 1,
                messageId: 'm2',
                configure: () => {
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ],
                    };
                },
            },
            {
                label: 'tool-group',
                expectedIndex: 0,
                messageId: 'tool-1',
                configure: () => {
                    settingValues.transcriptGroupToolCalls = true;
                    settingValues.toolViewTimelineChromeMode = 'activity_feed';
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 1, seq: 1, tool: { name: 'shell' } },
                        ],
                    };
                },
            },
            {
                label: 'turn',
                expectedIndex: 0,
                messageId: 'tool-2',
                configure: () => {
                    settingValues.transcriptGroupingMode = 'turns';
                    transcriptTurnsState = [{
                        id: 'turn-1',
                        userMessageId: 'm1',
                        content: [{ kind: 'tool_calls', id: 'turn-tools', toolMessageIds: ['tool-2'] }],
                    }];
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                            { kind: 'tool-call', id: 'tool-2', localId: null, createdAt: 2, seq: 2, tool: { name: 'shell' } },
                        ],
                    };
                },
            },
        ];

        for (const testCase of cases) {
            runtimeMockState.platformOs = 'ios';
            renderedFlashListCount = 0;
            renderedMessageViewProps = [];
            renderedToolCallsGroupRowProps = [];
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState = new Map();
            settingValues.transcriptGroupingMode = 'linear';
            settingValues.transcriptGroupToolCalls = false;
            settingValues.toolViewTimelineChromeMode = 'cards';
            transcriptTurnsState = [];
            testCase.configure();
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 999,
                anchor: {
                    kind: 'message',
                    messageId: testCase.messageId,
                    itemId: 'stale-row-id',
                    itemOffsetPx: 24,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(100, 1000, { turns: 2 });

            expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                index: testCase.expectedIndex,
                animated: false,
                viewOffset: -24,
            });
            await screen.unmount();
        }
    });

    it('records native entry-anchor restore through the viewport executor', async () => {
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });
        syncTuningState = {
            ...syncTuningState,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 999,
            anchor: {
                kind: 'message',
                messageId: 'm2',
                itemId: 'm2',
                itemOffsetPx: 24,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
            index: 1,
            animated: false,
            viewOffset: -24,
        }));
        expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'first-paint',
                sessionId: 'session-1',
                shouldFollowBottom: false,
            }),
        ]));
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-write',
            writer: 'native-scroll-to-index',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            targetOffsetY: 1,
            nativeMountSettleStable: expect.any(Boolean),
        }));

        flashListRefHandle.scrollToIndex.mockClear();
        await act(async () => {
            getCapturedFlashListProps().onScrollToIndexFailed?.({
                averageItemLength: 100,
                index: 1,
            });
        });
        await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
            index: 1,
            animated: false,
            viewOffset: -24,
        }));
    });

    it('falls back to the nearest earlier materialized row when an anchored turn message disappears', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();
        runtimeMockState.platformOs = 'ios';
        settingValues.transcriptGroupingMode = 'turns';
        transcriptTurnsState = [
            { id: 'turn-1', userMessageId: 'm1', content: [] },
            { id: 'turn-3', userMessageId: 'm3', content: [] },
        ];
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            ],
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 999,
            anchor: {
                kind: 'message',
                messageId: 'm2',
                itemId: 'stale-turn-id',
                itemOffsetPx: 24,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 0,
            animated: false,
            viewOffset: -24,
        });
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('lets jumpToSeq take priority over a stored viewport anchor', async () => {
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 400,
            anchor: {
                kind: 'message',
                messageId: 'm1',
                itemId: 'm1',
                itemOffsetPx: 20,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} jumpToSeq={2} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 1,
            animated: true,
            viewPosition: 0.5,
        });
        expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'jump-to-seq',
                sessionId: 'session-1',
                seq: 2,
            }),
        ]));
        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalledWith(expect.objectContaining({
            viewOffset: 20,
        }));
    });

    it('ignores stale async jump commands after the session identity changes', async () => {
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        let releaseJump: (() => void) | null = null;
        jumpToTranscriptSeqMockState.implementation = async (params) => {
            await new Promise<void>((resolve) => {
                releaseJump = resolve;
            });
            params.scrollToIndex(1);
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState, id: 'session-1' }} jumpToSeq={2} />,
        );
        await act(async () => {
            await Promise.resolve();
        });
        expect(releaseJump).not.toBeNull();

        sessionState = { ...sessionState, id: 'session-2' };
        await act(async () => {
            screen.tree.update(<ChatList session={{ ...sessionState }} />);
        });

        await act(async () => {
            releaseJump?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
    });

    it('uses bounded older lookup before falling back to distance when an anchor is missing', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 150,
                anchor: {
                    kind: 'message',
                    messageId: 'missing',
                    itemId: 'missing',
                    itemOffsetPx: 20,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 4 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
                    expect(scroller.scrollTop).toBe(750);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses configured zero older lookup budget before falling back to distance restore', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorOlderLookupMaxLoads: 0,
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 150,
                anchor: {
                    kind: 'message',
                    messageId: 'missing',
                    itemId: 'missing',
                    itemOffsetPx: 20,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });

                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                    expect(scroller.scrollTop).toBe(750);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not apply anchor lookup fallback after the user scrolls during lookup', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'no_more' }) => void) | null = null;
            const loadOlderPromise = new Promise<{ loaded: number; hasMore: boolean; status: 'no_more' }>((resolve) => {
                resolveLoadOlder = resolve;
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 150,
                anchor: {
                    kind: 'message',
                    messageId: 'missing',
                    itemId: 'missing',
                    itemOffsetPx: 20,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });
            loadOlderMessagesMock.mockImplementation(() => loadOlderPromise);

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });
                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                    scroller.scrollTop = 550;
                    getCapturedFlashListProps().onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
                    resolveLoadOlder?.({ loaded: 0, hasMore: false, status: 'no_more' });
                    await screen.settle({ turns: 4 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
                    expect(scroller.scrollTop).toBe(550);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not let initial web pin retry override an anchor restore', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'm1',
                    itemOffsetPx: 30,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 120, bottom: 220 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 130, bottom: 180 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });
                    expect(scroller.scrollTop).toBe(90);

                    scroller.scrollHeight = 1400;
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 3000 });

                    expect(scroller.scrollTop).toBe(90);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not restore a stale entry viewport after bottom follow is rearmed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 420,
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 100,
                scrollTop: 0,
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} followBottomIntentKey={0} />,
                    );
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    await screen.update(<ChatList session={{ ...sessionState }} followBottomIntentKey={1} />);

                    scrollEl.scrollHeight = 1000;
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not re-pin during the initial web stabilize window after the user scrolls away from bottom', async () => {
        await withWebFlashListFakeTimers(250, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                scrollTo: ({ top }: { top: number }) => {
                    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                },
                querySelectorAll: () => [],
                parentElement: null,
            };

            const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // Initial stabilization pins to bottom.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

                    // User scrolls away slightly from bottom.
                    scrollEl.scrollTop = 900;
                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
                    });

                    // Even though stabilization retries are scheduled, we must not fight the user's scroll.
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('cancels scheduled bottom pin when thinking expansion changes locally', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'thinking', isThinking: true },
                ],
            };
            settingValues.sessionThinkingDisplayMode = 'inline';
            settingValues.sessionThinkingInlinePresentation = 'summary';

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();

            await primeFlashListMetrics(100, 1000, { turns: 1 });
            scrollToOffset.mockClear();

            await act(async () => {
                getCapturedFlashListProps()?.onScrollBeginDrag?.();
                getCapturedFlashListProps()?.onContentSizeChange?.(0, 1200);
            });

            const thinkingProps = renderedMessageViewProps.find((props) => props?.message?.id === 't1');
            expect(typeof thinkingProps?.onThinkingExpandedChange).toBe('function');

            await act(async () => {
                thinkingProps.onThinkingExpandedChange(true);
            });

            await screen.settle({ runAllTimers: true, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('cancels scheduled bottom pin when tool group expansion changes locally', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 1, tool: { name: 'shell' } }],
            };
            settingValues.transcriptGroupingMode = 'linear';
            settingValues.transcriptGroupToolCalls = true;
            settingValues.toolViewTimelineChromeMode = 'activity_feed';

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();
            getCapturedFlashListProps();

            const toolGroupProps = renderedToolCallsGroupRowProps[0];
            expect(typeof toolGroupProps?.onSetExpanded).toBe('function');

            await primeFlashListMetrics(100, 1000, { turns: 1 });
            scrollToOffset.mockClear();

            await act(async () => {
                getCapturedFlashListProps()?.onScrollBeginDrag?.();
                getCapturedFlashListProps()?.onContentSizeChange?.(0, 1200);
            });

            await act(async () => {
                toolGroupProps.onSetExpanded({
                    toolCallsGroupId: toolGroupProps.toolCallsGroupId,
                    toolMessageIds: toolGroupProps.toolMessageIds,
                    expanded: true,
                });
            });

            await screen.settle({ runAllTimers: true, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('re-pins to the bottom for passive mount-time web scroll drift while follow mode is still desired', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                scrollTo: ({ top }: { top: number }) => {
                    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.max(0, Math.min(top, max));
                },
                querySelectorAll: () => [],
                parentElement: null,
            };

            const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // The initial mount pin puts us at the bottom.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

                    await act(async () => {
                        // Establish scroll metrics used by FlashList distance-from-bottom math.
                        await primeFlashListMetrics(100, 1000, { turns: 1 });

                        // First, we're at the bottom (distanceFromBottom = 0).
                        await scrollFlashListTo(900, { trusted: false, turns: 1 });

                        // FlashList/web can apply a programmatic scroll adjustment during mount (no wheel/touch intent).
                        // Simulate being nudged away from bottom by ~400px.
                        scrollEl.scrollTop = 492;
                        await scrollFlashListTo(492, { trusted: false, turns: 1 });
                    });

                    // Passive mount-time drift should be corrected back to the visual bottom while follow mode remains desired.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps bottom follow when passive web scroll drift occurs without user intent', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect(getCapturedFlashListProps()).not.toBeNull();
                flashListRefHandle.scrollToOffset.mockClear();

                await act(async () => {
                    // Establish scroll metrics used by onScroll distance-from-bottom math.
                    await primeFlashListMetrics(100, 1000, { turns: 1 });
                    // Simulate a passive drift away from the bottom without any user gesture or new activity.
                    scrollEl.scrollTop = 0;
                    await scrollFlashListTo(0, { trusted: false, turns: 2 });
                });

                expect(scrollEl.scrollTop).toBe(900);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('keeps the visual bottom pinned when existing web content remeasures without user activity', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 900,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                flashListRefHandle.scrollToOffset.mockClear();

                await primeFlashListMetrics(100, 1000, { turns: 1 });
                await scrollFlashListTo(900, { trusted: false, turns: 1 });

                scrollEl.scrollHeight = 1400;

                await primeFlashListMetrics(100, 1400, { turns: 1 });
                await scrollFlashListTo(900, { trusted: false, turns: 2 });

                expect(scrollEl.scrollTop).toBe(1300);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('preserves visual bottom distance when followed web content grows near the bottom', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 892,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                flashListRefHandle.scrollToOffset.mockClear();

                await primeFlashListMetrics(100, 1000, { turns: 1 });
                scrollEl.scrollTop = 892;
                await scrollFlashListTo(892, { trusted: false, turns: 1 });

                scrollEl.scrollHeight = 1400;

                await primeFlashListMetrics(100, 1400, { turns: 1 });

                expect(scrollEl.scrollTop).toBe(1292);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('rearms web bottom follow when the user scrolls back near the streaming tail', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 0,
            };

            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 900,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, max));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    flashListRefHandle.scrollToOffset.mockClear();

                    await primeFlashListMetrics(100, 1000, { turns: 1 });
                    scrollEl.scrollTop = 900;
                    await scrollFlashListTo(900, { trusted: false, turns: 1 });

                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: -320, stopPropagation: vi.fn() });
                    });
                    scrollEl.scrollTop = 600;
                    await scrollFlashListTo(600, { trusted: true, turns: 1 });

                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: 250, stopPropagation: vi.fn() });
                    });
                    scrollEl.scrollTop = 850;
                    await scrollFlashListTo(850, { trusted: true, turns: 1 });

                    scrollEl.scrollHeight = 1400;
                    await primeFlashListMetrics(100, 1400, { turns: 1 });
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 300 });

                    expect(scrollEl.scrollTop).toBe(1250);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('pins using the current session nativeID when multiple transcript lists exist in the DOM (web)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const wrongScroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 2000,
            scrollTop: 111,
        });
        const rightScroller = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 3000,
            scrollTop: 0,
        });
        const rightScrollerBottom = Math.max(0, rightScroller.scrollHeight - rightScroller.clientHeight);
        const currentSessionNativeIdPrefix = buildChatListNativeId(sessionState.id, '');

        await withFlashListChatListWebScrollerDom(
            wrongScroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                // If DOM pinning accidentally targets the first `[data-testid="transcript-chat-list"]` in the
                // document, it would pin the wrong scroller. We must always pin the current session's list.
                expect(wrongScroller.scrollTop).toBe(111);
                expect(rightScroller.scrollTop).toBe(rightScrollerBottom);
            },
            {
                document: {
                    querySelector: () => wrongScroller,
                    getElementById: (id: string) => (id.startsWith(currentSessionNativeIdPrefix) ? rightScroller : null),
                },
                window: { getComputedStyle: () => ({ overflowY: 'auto' }) },
            },
        );
    });
});
