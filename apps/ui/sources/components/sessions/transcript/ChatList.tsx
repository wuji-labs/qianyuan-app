import * as React from 'react';
import {
    getStorage,
    useForkedTranscriptSnapshot,
    useMessage,
    useSessionChatFooterState,
    useSessionActionDrafts,
    useSessionLatestThinkingMessageId,
    useSessionLatestThinkingMessageActivityAtMs,
    useSessionMessages,
    useSessionMessagesById,
    useSessionPendingMessages,
    useSessionTranscriptIds,
    useSetting,
} from '@/sync/domains/state/storage';
import { Dimensions, FlatList, PixelRatio, Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FlashList, LayoutCommitObserver, useRecyclingState } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { useCallback } from 'react';
import { MessageView, MessageViewWithSessionCommon } from './MessageView';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { ChatFooter, type ChatFooterDirectControlState } from './ChatFooter';
import { buildChatListItems, buildChatListItemsCached, type ChatListItem, type ChatListItemsBuildCache } from '@/components/sessions/chatListItems';
import { buildForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import { insertForkDividersIntoTranscriptItems } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { ForkDividerRow } from '@/components/sessions/transcript/forkContext/ForkDividerRow';
import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { jumpToTranscriptSeq } from '@/utils/sessions/jumpToTranscriptSeq';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildTranscriptTurnsCached, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { resolveTranscriptMotionConfig } from '@/components/sessions/transcript/motion/resolveTranscriptMotionConfig';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { reduceTranscriptScrollPinState, type TranscriptScrollPinState } from '@/components/sessions/transcript/scroll/transcriptScrollPinController';
import {
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryListImplementation,
    resolveTranscriptViewportTelemetryPlatform,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryScrollWriter,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    createTranscriptViewportController,
    type TranscriptViewportController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportController';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import { shouldPrefetchOlderFromTop } from '@/components/sessions/transcript/scroll/shouldPrefetchOlderFromTop';
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import { resolveInitialWebPinRetryDelays } from '@/components/sessions/transcript/scroll/resolveInitialWebPinRetryDelays';
import { resolveWebPinRetryTimeoutMs } from '@/components/sessions/transcript/scroll/resolveWebPinRetryTimeoutMs';
import { resolveSessionEntryBottomFollow } from '@/components/sessions/transcript/scroll/resolveSessionEntryBottomFollow';
import { resolveTranscriptBottomFollowIntent } from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    isEnrichedMarkdownRuntimePreloaded,
    preloadEnrichedMarkdownRuntime,
} from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { deriveTranscriptInteractionFromSession, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { buildChatListNativeId } from './chatListNativeId';
import { useWebFlashListCrashFallback } from '@/components/ui/lists/useWebFlashListCrashFallback';
import {
    TranscriptMessageSelectionBoundary,
    useOptionalTranscriptSelectionState,
} from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
import { resolveWebHotColdScrollDecision } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import {
    isMessageRolledBack,
    readSessionRollbackRangesV1,
    resolveTranscriptRollbackActions,
    type TranscriptRollbackAction,
    type SessionRollbackRangeV1,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    resolveWebTranscriptMaxScrollTop,
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { resolveWebBottomFollowAdjustment } from '@/components/sessions/transcript/scroll/resolveWebBottomFollowAdjustment';
import { WebTranscriptSplitFooter } from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    ComposerKeyboardFloatingInset,
    ComposerKeyboardScrollInset,
} from '@/components/sessions/keyboardAvoidance';
import {
    captureWebTranscriptPrependAnchor,
    captureWebTranscriptViewportAnchor,
    refreshWebTranscriptPrependAnchor,
    restoreWebTranscriptPrependAnchor,
    restoreWebTranscriptViewportAnchor,
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptPrependAnchor,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import {
    captureNativeTranscriptViewportAnchor,
    planNativeTranscriptViewportAnchorRestore,
} from '@/components/sessions/transcript/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/transcriptViewportAnchorResolution';
import {
    clearSessionUiTelemetryMarks,
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { LruMap } from '@/utils/cache/lruMap';
import {
    buildTranscriptItemHeightSignatureKey,
    getDefaultTranscriptItemHeightCache,
    type TranscriptItemHeightCache,
    type TranscriptItemHeightValiditySignature,
} from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { resolveTranscriptRowShellHeight } from '@/components/sessions/transcript/measurement/resolveTranscriptRowShellHeight';
import {
    buildTranscriptRowShellSignature,
    resolveTranscriptRowItemType,
    type TranscriptRowShellItem,
} from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import {
    createTranscriptMountSettlePinCoordinator,
    type TranscriptMountSettlePinCoordinator,
    type TranscriptMountSettleTuning,
} from '@/components/sessions/transcript/scroll/transcriptMountSettlePinCoordinator';
import {
    hasTranscriptSessionCommonProps,
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

type ScrollableChatListRef = Readonly<{
    scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
}>;

type ChatTranscriptListItem = TranscriptRowShellItem;

type PendingNativeEntryViewportRestore = Readonly<{
    contentHeight?: number;
    issuedAtMs: number;
    kind: 'anchor' | 'distance';
    layoutHeight?: number;
    offsetY: number;
    sessionId: string;
    targetOffsetY?: number;
    targetOffsetYWasClamped?: boolean;
}>;

const EMPTY_MESSAGES_BY_ID: Readonly<Record<string, Message>> = Object.freeze({});
const TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS = 200;
const TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS = 250;
const TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS = 500;
const TRANSCRIPT_NATIVE_PASSIVE_RECYCLED_JUMP_VIEWPORT_MULTIPLIER = 4;
const TRANSCRIPT_NATIVE_PASSIVE_RECYCLED_JUMP_THRESHOLD_MULTIPLIER = 8;
const TRANSCRIPT_NATIVE_BOTTOM_CONFIRMATION_RECYCLED_EVENT_WINDOW_MS = 32;
const TRANSCRIPT_NATIVE_MOUNT_SETTLE_SAME_OFFSET_WAKE_RETRY_LIMIT = 3;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_FALLBACK = 0.75;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX = 4;
const TRANSCRIPT_WEB_INITIAL_PIN_STABILIZE_FALLBACK_MS = 1500;
const TRANSCRIPT_WEB_INITIAL_PIN_RETRY_INTERVAL_FALLBACK_MS = 250;
const TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS = 8;
const TRANSCRIPT_ROW_WIDTH_BUCKET_PX = 64;

function resolveIndexScrollWriter(params: Readonly<{
    platform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
    listImplementation: string;
}>): TranscriptViewportTelemetryScrollWriter {
    if (params.platform === 'web') return 'web-scroll-to-index';
    if (params.listImplementation === 'flatlist_legacy') return 'legacy-scroll-to-index';
    return 'native-scroll-to-index';
}

function resolveNativeScrollEventMetric(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function withTranscriptViewportCommandAnimation(
    command: TranscriptViewportCommand,
    animated: boolean,
): TranscriptViewportCommand {
    switch (command.kind) {
        case 'pin-bottom':
        case 'scroll-offset':
        case 'restore-offset':
        case 'restore-index':
        case 'jump-to-seq':
            return { ...command, animated };
        case 'none':
        case 'skip-native-js-pin':
            return command;
    }
}

type TranscriptDerivedItemsCacheEntry = {
    linearItemsCache: ChatListItemsBuildCache | null;
    turnsCache: TranscriptTurnsBuildCache | null;
};

const transcriptDerivedItemsCacheBySessionId = new LruMap<string, TranscriptDerivedItemsCacheEntry>({
    maxEntries: TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS,
});

function resolveTranscriptDerivedItemsCacheMaxSessions(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS;
    }
    return Math.max(1, Math.min(64, Math.trunc(value)));
}

function readTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
): TranscriptDerivedItemsCacheEntry {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId);
    if (existing) return existing;
    const entry: TranscriptDerivedItemsCacheEntry = {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, entry);
    return entry;
}

function writeTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
    patch: Partial<TranscriptDerivedItemsCacheEntry>,
): void {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId) ?? {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, {
        ...existing,
        ...patch,
    });
}

type EntryAnchorRestoreAttempt = 'restored' | 'pending' | 'missing_anchor' | 'distance_fallback';

type LoadOlderOptions = Readonly<{
    loadingIndicatorDelayMs?: number;
    showLoadingIndicator?: boolean;
}>;

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

function readSessionViewportForEntry(sessionId: string) {
    return typeof sync.getSessionViewport === 'function' ? sync.getSessionViewport(sessionId) : null;
}

function buildRollbackActionsInputSignature(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string {
    let signature = '';
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) {
            signature += `${messageId}:missing|`;
            continue;
        }
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : '';
        signature += `${message.id}:${message.kind}:${seq}`;
        if (message.kind === 'user-text') {
            signature += `:${message.text}`;
        }
        signature += '|';
    }
    return signature;
}

function buildStableJsonSignature(value: unknown): string {
    try {
        return JSON.stringify(value ?? null) ?? 'null';
    } catch {
        return String(value);
    }
}

function useStableValueBySignature<T>(value: T, signature: string): T {
    const ref = React.useRef<{ signature: string; value: T }>({ signature, value });
    if (ref.current.signature !== signature) {
        ref.current = { signature, value };
    }
    return ref.current.value;
}

function resolveTranscriptRowWidthBucket(width: unknown): string {
    const normalizedWidth = typeof width === 'number' && Number.isFinite(width)
        ? Math.max(1, Math.trunc(width))
        : 1;
    const bucket = Math.max(
        TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
        Math.ceil(normalizedWidth / TRANSCRIPT_ROW_WIDTH_BUCKET_PX) * TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
    );
    return `width:${bucket}`;
}

function resolveInitialTranscriptRowWidthBucket(): string {
    return resolveTranscriptRowWidthBucket(Dimensions.get('window')?.width);
}

function resolveFontScaleKey(): string {
    const fontScale = typeof PixelRatio.getFontScale === 'function'
        ? PixelRatio.getFontScale()
        : Dimensions.get('window')?.fontScale;
    const normalized = typeof fontScale === 'number' && Number.isFinite(fontScale)
        ? Math.max(0.5, fontScale)
        : 1;
    return `font:${Math.round(normalized * 100)}`;
}

function resolveTranscriptMountSettleTuning(): TranscriptMountSettleTuning {
    const tuning = sync.getSyncTuning();
    return {
        quiescentWindowMs: tuning.transcriptMountSettleQuiescentWindowMs,
        dimensionNoiseFloorPx: tuning.transcriptMountSettleDimensionNoiseFloorPx,
        bottomDistanceNoiseFloorPx: tuning.transcriptMountSettleBottomDistanceNoiseFloorPx,
    };
}

function resolveNativePassiveBottomDriftNoiseFloorPx(pinThresholdPx: number): number {
    const configured = resolveTranscriptMountSettleTuning().bottomDistanceNoiseFloorPx;
    const normalized = typeof configured === 'number' && Number.isFinite(configured)
        ? Math.max(0, Math.trunc(configured))
        : 0;
    return Math.min(Math.max(0, Math.trunc(pinThresholdPx)), normalized);
}

export type TranscriptViewportChangeState = Readonly<{
    isPinned: boolean;
    offsetY: number;
    shouldRestoreViewport: boolean;
    anchor?: SessionViewportAnchorSnapshot | null;
}>;

export const ChatList = React.memo((props: {
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    isWarmKeepAliveInstance?: boolean;
}) => {
    React.useEffect(() => {
        fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'ChatList.preloadEnrichedMarkdownRuntime' });
    }, []);

    const fork = useForkedTranscriptSnapshot(props.session.id);
    const { ids: childMessageIdsOldestFirst, isLoaded } = useSessionTranscriptIds(props.session.id);
    const childMessagesById = useSessionMessagesById(props.session.id);
    const forkedTranscriptEnabled = fork != null;
    const swrFallbackCandidateEnabled = !forkedTranscriptEnabled && childMessageIdsOldestFirst.length === 0;
    const { messages: swrCommittedMessages } = useSessionMessages(props.session.id, { enabled: swrFallbackCandidateEnabled });
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.session.id);
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;

    const swrFallbackEnabled = !forkedTranscriptEnabled
        && childMessageIdsOldestFirst.length === 0
        && swrCommittedMessages.length > 0;
    const swrFallbackMessageIdsOldestFirst = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessageIdsOldestFirst;
        return swrCommittedMessages.map((message) => message.id);
    }, [childMessageIdsOldestFirst, swrCommittedMessages, swrFallbackEnabled]);
    const swrFallbackMessagesById = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessagesById;
        const out: Record<string, Message> = {};
        for (const message of swrCommittedMessages) {
            out[message.id] = message;
        }
        return out;
    }, [childMessagesById, swrCommittedMessages, swrFallbackEnabled]);

    const forkContextNeedsPrefetch = React.useMemo(() => {
        if (!fork) return false;
        return fork.segments.some((seg) =>
            seg.isReadOnlyContext === true &&
            typeof seg.cutoffSeqInclusive === 'number' &&
            Number.isFinite(seg.cutoffSeqInclusive) &&
            seg.cutoffSeqInclusive >= 0 &&
            (seg.messageIdsOldestFirst?.length ?? 0) === 0
        );
    }, [fork]);

    React.useEffect(() => {
        if (!forkContextNeedsPrefetch) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(props.session.id), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkContextNeedsPrefetch, props.session.id]);

    const forkAwareMessageDescriptors = React.useMemo(() => {
        if (!forkedTranscriptEnabled || !fork) return null;
        return buildForkAwareMessageDescriptors(fork);
    }, [fork, forkedTranscriptEnabled]);
    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messageIdsOldestFirst as string[];
        }
        return swrFallbackMessageIdsOldestFirst;
    }, [forkAwareMessageDescriptors, swrFallbackMessageIdsOldestFirst]);
    const messagesById = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messagesById as Record<string, Message>;
        }
        return swrFallbackMessagesById;
    }, [forkAwareMessageDescriptors, swrFallbackMessagesById]);
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(props.session.metadata ?? null),
        [props.session.metadata],
    );
    const stableSessionMetadata = useStableValueBySignature(props.session.metadata, sessionMetadataSignature);

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const derivedItemsCacheMaxSessions = resolveTranscriptDerivedItemsCacheMaxSessions(
        sync.getSyncTuning().transcriptDerivedItemsCacheMaxSessions,
    );
    const derivedItemsCacheEntry = readTranscriptDerivedItemsCacheEntry(
        props.session.id,
        derivedItemsCacheMaxSessions,
    );
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return buildTranscriptTurnsCached({
            cache: derivedItemsCacheEntry.turnsCache,
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls,
            toolCallsGroupStrategy,
            forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
            forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
            forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
        });
    }, [forkAwareMessageDescriptors, groupingMode, messageIdsOldestFirst, messagesById, groupToolCalls, toolCallsGroupStrategy]);

    React.useEffect(() => {
        if (groupingMode !== 'turns' || !turnsCache) return;
        writeTranscriptDerivedItemsCacheEntry(props.session.id, derivedItemsCacheMaxSessions, {
            turnsCache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, props.session.id, turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return buildChatListItemsCached({
            cache: derivedItemsCacheEntry.linearItemsCache,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages,
            discardedMessages: discardedPendingMessages,
            actionDrafts,
            groupConsecutiveToolCalls: groupToolCalls,
            forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
            forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
            forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
        });
    }, [actionDrafts, forkAwareMessageDescriptors, groupingMode, groupToolCalls, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages]);

    React.useEffect(() => {
        if (groupingMode === 'turns' || !linearCache) return;
        writeTranscriptDerivedItemsCacheEntry(props.session.id, derivedItemsCacheMaxSessions, {
            linearItemsCache: linearCache.cache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, linearCache, props.session.id]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        if (groupingMode !== 'turns') {
            const base = linearCache?.items ?? buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages, discardedMessages: discardedPendingMessages, actionDrafts });
            if (!forkedTranscriptEnabled || !fork) return base;
            return insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
        }

        const trailing = buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages,
            discardedMessages: discardedPendingMessages,
            actionDrafts,
            includeCommittedMessages: false,
        });

        const turns = turnsCache?.turns ?? [];
        const turnItems: ChatTranscriptListItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
        const base = [...turnItems, ...trailing];
        if (!forkedTranscriptEnabled || !fork) return base;
        return insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
    }, [actionDrafts, fork, forkedTranscriptEnabled, groupingMode, linearCache, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, turnsCache]);

    const latestCommittedActivityKey =
        messageIdsOldestFirst.length > 0 ? messageIdsOldestFirst[messageIdsOldestFirst.length - 1]! : null;
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((stableSessionMetadata as Record<string, unknown> | null | undefined) ?? null),
        [sessionMetadataSignature, stableSessionMetadata],
    );
    const rollbackActionsInputSignature = React.useMemo(
        () => buildRollbackActionsInputSignature({ messageIdsOldestFirst, messagesById }),
        [messageIdsOldestFirst, messagesById],
    );
    const rollbackActionsByMessageId = React.useMemo(
        () => resolveTranscriptRollbackActions({
            session: props.session,
            messageIdsOldestFirst,
            messagesById,
            rollbackRanges,
        }),
        [
            props.session.accessLevel,
            props.session.active,
            props.session.sessionTurns,
            sessionMetadataSignature,
            rollbackActionsInputSignature,
            rollbackRanges,
        ],
    );

    const latestThinkingMessageId = useSessionLatestThinkingMessageId(props.session.id);
    const latestThinkingMessageActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(props.session.id);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (props.session.thinking !== true) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const t = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(t);
    }, [latestThinkingMessageActivityAtMs, props.session.thinking, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: props.session.thinking === true,
            latestThinkingMessageId,
            latestCommittedMessageId: latestCommittedActivityKey,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedActivityKey, latestThinkingMessageActivityAtMs, latestThinkingMessageId, props.session.thinking, staleMs, thinkingPulseNow]);

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.active, props.session.presence]);
    const internalMessagesById = forkedTranscriptEnabled ? messagesById : EMPTY_MESSAGES_BY_ID;

    return (
        <TranscriptMessageSelectionBoundary
            key={props.session.id}
            sessionId={props.session.id}
            eligibleMessageIdsInOrder={messageIdsOldestFirst}
            enabled={transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true}
        >
            <ChatListInternal
                metadata={stableSessionMetadata}
                sessionId={props.session.id}
                sessionSeq={props.session.seq ?? 0}
                sessionActive={props.session.active === true}
                groupingMode={groupingMode}
                forkedTranscriptEnabled={forkedTranscriptEnabled}
                items={groupedItems}
                messagesById={internalMessagesById}
                forkMessageMetadataById={forkAwareMessageDescriptors?.metadataByMessageId ?? null}
                committedMessagesCount={messageIdsOldestFirst.length}
                latestCommittedActivityKey={latestCommittedActivityKey}
                activeThinkingMessageId={activeThinkingMessageId}
                rollbackRanges={rollbackRanges}
                rollbackActionsByMessageId={rollbackActionsByMessageId}
                isLoaded={isLoaded}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControlFooter={props.directControlFooter}
                approvalRequests={props.approvalRequests}
                interaction={interaction}
                jumpToSeq={props.jumpToSeq ?? null}
                followBottomIntentKey={props.followBottomIntentKey ?? null}
                onViewportChange={props.onViewportChange}
                isWarmKeepAliveInstance={props.isWarmKeepAliveInstance === true}
                forkCommon={transcriptSessionCommon.fork}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
            />
        </TranscriptMessageSelectionBoundary>
    );
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    return (
        <View>
            {props.isLoadingOlder && (
                <View style={{ paddingVertical: 12 }}>
                    <ActivitySpinner size="small" />
                </View>
            )}
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

const ListFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
}) => {
    const footerState = useSessionChatFooterState(props.sessionId);
    if (!footerState) {
        return null;
    }
    return (
        <ChatFooter
            controlledByUser={props.controlledByUserOverride ?? footerState.controlledByUser}
            localControl={footerState.localControl}
            permissionsInUiWhileLocal={footerState.permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            directControl={props.directControl ?? null}
        />
    )
});

const ChatListFooterWithKeyboardInset = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
    onComposerInsetHeightChange?: (height: number) => void;
}) => {
    return (
        <View>
            <ListFooter
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControl ?? null}
            />
            <ComposerKeyboardScrollInset
                testID="transcript-composer-keyboard-inset"
                onHeightChange={props.onComposerInsetHeightChange}
            />
        </View>
    );
});

const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    messageOverride?: Message | null;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackAction?: TranscriptRollbackAction | null;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
} & Partial<TranscriptSessionCommonProps>) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const committedMessage = useMessage(originSessionId, props.messageId);
    const message = props.messageOverride ?? committedMessage;
    if (!message) return null;

    const isThinking = message.kind === 'agent-text' && message.isThinking === true;
    const readOnlyInteraction = deriveReadOnlyTranscriptInteraction(props.interaction, props.isReadOnlyContext === true);
    const historical = isMessageRolledBack({ message, rollbackRanges: props.rollbackRanges });
    const canUseParentCommon = originSessionId === props.sessionId && hasTranscriptSessionCommonProps(props);
    const messageView = canUseParentCommon ? (
        <MessageViewWithSessionCommon
            message={message}
            metadata={props.metadata}
            sessionId={originSessionId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            approvalRequests={props.approvalRequests}
            forkCommon={props.forkCommon}
            messageDisplayCommon={props.messageDisplayCommon}
            toolChromeCommon={props.toolChromeCommon}
            toolRouteCommon={props.toolRouteCommon}
        />
    ) : (
        <MessageView
            message={message}
            metadata={props.metadata}
            sessionId={originSessionId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            approvalRequests={props.approvalRequests}
        />
    );
    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.messageId}`}>
            <View testID={`transcript-message-${props.messageId}`}>
                {messageView}
            </View>
        </View>
    );
});

const TranscriptRowShell = React.memo(function TranscriptRowShell(props: Readonly<{
    cache: TranscriptItemHeightCache;
    children: React.ReactNode;
    itemId: string;
    signature: TranscriptItemHeightValiditySignature;
}>) {
    const signatureKey = buildTranscriptItemHeightSignatureKey(props.signature);
    // This is recycle identity state, not layout state: FlashList may reuse this cell for
    // another row, so reset the one-shot hint release when the row signature changes.
    const [heightHintReleased, setHeightHintReleased] = useRecyclingState(false, [signatureKey]);
    const heightHint = resolveTranscriptRowShellHeight({
        cache: props.cache,
        signature: props.signature,
    });
    const shouldApplyHeightHint = heightHint !== undefined && !heightHintReleased;
    const shellStyle = React.useMemo(() => (
        shouldApplyHeightHint ? { minHeight: heightHint.minHeight } : undefined
    ), [heightHint?.minHeight, shouldApplyHeightHint]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event?.nativeEvent?.layout?.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
            props.cache.set(props.signature, { heightPx: Math.max(1, Math.trunc(height)) });
        }
        if (heightHint !== undefined && !heightHintReleased) {
            setHeightHintReleased(true);
        }
    }, [heightHint, heightHintReleased, props.cache, props.signature, setHeightHintReleased]);

    return (
        <View
            testID={`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.itemId}`}
            style={shellStyle}
            onLayout={handleLayout}
        >
            {props.children}
        </View>
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionSeq: number,
    sessionActive: boolean,
    groupingMode: string,
    forkedTranscriptEnabled: boolean,
    items: ChatTranscriptListItem[],
    messagesById: Readonly<Record<string, Message>>,
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null,
    committedMessagesCount: number,
    latestCommittedActivityKey: string | null,
    activeThinkingMessageId: string | null,
    rollbackRanges: readonly SessionRollbackRangeV1[],
    rollbackActionsByMessageId: Readonly<Record<string, TranscriptRollbackAction>>,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void,
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    interaction: TranscriptInteraction;
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    isWarmKeepAliveInstance?: boolean;
} & TranscriptSessionCommonProps) => {
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listLayoutWidthBucket, setListLayoutWidthBucket] = React.useState(resolveInitialTranscriptRowWidthBucket);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const [webMarkdownRuntimeReady, setWebMarkdownRuntimeReady] = React.useState(isEnrichedMarkdownRuntimePreloaded);
    const [nativeMountSettleStable, setNativeMountSettleStable] = React.useState(false);
    const [nativeMountSettleDeadlineReached, setNativeMountSettleDeadlineReached] = React.useState(false);
    const [nativeInitialViewportPendingObservation, setNativeInitialViewportPendingObservation] = React.useState(false);
    const nativeMountSettleDeadlineReachedRef = React.useRef(false);
    const nativeMountSettleAutoPinSuppressedRef = React.useRef(false);
    const loadOlderInFlight = React.useRef(false);
    const olderLoadSpinnerDelayTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const currentSessionIdRef = React.useRef(props.sessionId);
    currentSessionIdRef.current = props.sessionId;
    const viewportCommandActiveRef = React.useRef(true);
    React.useLayoutEffect(() => {
        viewportCommandActiveRef.current = true;
        return () => {
            viewportCommandActiveRef.current = false;
        };
    }, []);
    const viewportControllerRef = React.useRef<TranscriptViewportController | null>(null);
    if (viewportControllerRef.current === null) {
        viewportControllerRef.current = createTranscriptViewportController();
    }
    const itemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const listDataRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const toolRouteCommonRef = React.useRef(props.toolRouteCommon);
    toolRouteCommonRef.current = props.toolRouteCommon;
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listLayoutWidthBucketRef = React.useRef<string>(listLayoutWidthBucket);
    const listContentHeightRef = React.useRef<number>(0);
    const lastMeasuredContentActivityKeyRef = React.useRef<string | null>(null);
    const initialFillStatusRef = React.useRef<'idle' | 'in_progress' | 'done'>('idle');
    const rowShellHeightCache = React.useMemo(() => getDefaultTranscriptItemHeightCache(), []);
    const mountSettleCoordinatorRef = React.useRef<TranscriptMountSettlePinCoordinator | null>(null);
    if (mountSettleCoordinatorRef.current === null) {
        mountSettleCoordinatorRef.current = createTranscriptMountSettlePinCoordinator({
            tuning: resolveTranscriptMountSettleTuning(),
        });
    }
    const recordListLayoutWidth = React.useCallback((width: unknown) => {
        if (typeof width !== 'number' || !Number.isFinite(width)) return;
        const nextBucket = resolveTranscriptRowWidthBucket(width);
        if (listLayoutWidthBucketRef.current === nextBucket) return;
        listLayoutWidthBucketRef.current = nextBucket;
        setListLayoutWidthBucket(nextBucket);
    }, []);
    const initialPinSessionIdRef = React.useRef<string | null>(null);
    const didAutoExpandToolCallsGroupsForSessionRef = React.useRef<string | null>(null);
    const initialFillAbortRef = React.useRef<AbortController | null>(null);
    const chatListReactId = React.useId();
    const chatListNativeId = React.useMemo(() => buildChatListNativeId(props.sessionId, chatListReactId), [props.sessionId, chatListReactId]);
    const loadNewerInFlight = React.useRef(false);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
    const pendingWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const inFlightWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const pendingWebPrependIndexRecoveryRef = React.useRef(false);
    const scheduledWebPrependIndexRecoveryRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[] } | null>(null);
    const wantsPinnedRef = React.useRef(true);
    const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    // Last web scroll-container `scrollTop` we observed or wrote programmatically. Used to detect a
    // genuine web user scroll-up (movement toward the top) without relying on `isTrusted`, which RNW
    // does not reliably set, while excluding our own programmatic pin/restore scroll writes.
    const lastObservedWebScrollTopRef = React.useRef<number | null>(null);
    const lastAutoRepinAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastPinOffsetForIntentRef = React.useRef<number | null>(null);
    const lastScrollOffsetForIntentRef = React.useRef<number | null>(null);
    const lastNativePinOffsetRef = React.useRef<number | null>(null);
    const nativeAutomaticBottomPinCommandSessionRef = React.useRef<string | null>(null);
    const nativeBottomFollowTargetConfirmationRef = React.useRef<{ sessionId: string; observedAtMs: number } | null>(null);
    const nativeBottomFollowStaleObservationCandidateRef = React.useRef<{
        sessionId: string;
        distanceFromBottom: number;
        offsetY: number;
        observedAtMs: number;
    } | null>(null);
    const lastProactiveAutoFollowActivityKeyRef = React.useRef<string | null>(props.latestCommittedActivityKey);
    const pendingNativeMountSettleBottomPinRef = React.useRef(false);
    const flushPendingNativeMountSettleBottomPinRef = React.useRef<(() => void) | null>(null);
    const nativeMountSettleSameOffsetWakeRetryCountRef = React.useRef(0);
    const nativeContentMeasurementSessionRef = React.useRef<{ sessionId: string; measured: boolean }>({
        sessionId: props.sessionId,
        measured: false,
    });
    const nativeInitialViewportAppliedSessionRef = React.useRef<{ sessionId: string; applied: boolean }>({
        sessionId: props.sessionId,
        applied: false,
    });
    const nativeInitialViewportPendingObservationRef = React.useRef(false);
    const entryViewportRestoreAppliedRef = React.useRef<{ contentHeight?: number; sessionId: string; offsetY: number } | null>(null);
    const pendingNativeEntryViewportRestoreRef = React.useRef<PendingNativeEntryViewportRestore | null>(null);
    const scheduledNativeEntryViewportRestoreRetryRef = React.useRef<{
        offsetY: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const lastNativeEntryViewportRestoreRetryAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const composerInsetHeightRef = React.useRef(0);
    const scheduledPinRef = React.useRef<{ kind: 'raf' | 'timeout'; id: any; previousWebMetrics: WebTranscriptScrollMetrics | null } | null>(null);
    const scheduledNativeMountSettleRetryRef = React.useRef<{ timeoutId: ReturnType<typeof setTimeout>; sessionId: string } | null>(null);
    const scheduleNativeMountSettleRetryAfterThrottleRef = React.useRef<(
        nowMs: number,
        options?: Readonly<{ delayMs?: number }>,
    ) => void>(() => {});
    const nativeMountSettleRetryGenerationRef = React.useRef(0);
    const latestJumpToSeqRef = React.useRef<number | null>(props.jumpToSeq ?? null);
    latestJumpToSeqRef.current = props.jumpToSeq ?? null;
    const initialWebPinStabilizingRef = React.useRef(false);
    const scheduledViewportAnchorCaptureRef = React.useRef<{
        captureAnchor: () => SessionViewportAnchorSnapshot | null;
        emit: ((state: TranscriptViewportChangeState) => void) | undefined;
        generation: number;
        state: TranscriptViewportChangeState;
        timeoutId: ReturnType<typeof setTimeout>;
        wantsPinned: boolean;
    } | null>(null);
    const viewportAnchorCaptureGenerationRef = React.useRef(0);
    const flushViewportAnchorCaptureRef = React.useRef<() => void>(() => {});
    const tryRestoreEntryViewportRef = React.useRef<((options?: { force?: boolean; retryPending?: boolean }) => boolean) | null>(null);
    const scheduledEntryAnchorRestoreRetryRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[]; sessionId: string } | null>(null);
    const entryAnchorRestoreRetryCountRef = React.useRef(0);
    const anchorLookupLoadCountRef = React.useRef(0);
    const anchorLookupInFlightRef = React.useRef(false);
    const loadOlderForAnchorLookupRef = React.useRef<((options?: LoadOlderOptions) => Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null>) | null>(null);

    const transcriptMotionPreset = useSetting('transcriptMotionPreset');
    const transcriptMotionFreshnessMs = useSetting('transcriptMotionFreshnessMs');
    const transcriptAnimateNewItemsEnabled = useSetting('transcriptAnimateNewItemsEnabled');
    const transcriptAnimateToolExpandCollapseEnabled = useSetting('transcriptAnimateToolExpandCollapseEnabled');
    const transcriptAnimateToolExpandCollapseFreshOnly = useSetting('transcriptAnimateToolExpandCollapseFreshOnly');
    const transcriptAnimateThinkingEnabled = useSetting('transcriptAnimateThinkingEnabled');
    const reducedMotionPreferred = useReducedMotionPreference();
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const sessionThinkingInlineChrome = useSetting('sessionThinkingInlineChrome');

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
        // Stopping propagation here keeps the event within the transcript subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        const nowMs = Date.now();
        lastUserScrollIntentAtMsRef.current = nowMs;
        // If the user scrolls upward (away from the bottom), treat that as explicit intent to unpin
        // immediately, even if they remain within the pinned threshold. This prevents mount-time
        // stabilization retries from fighting the user for several seconds after entering a session.
        const deltaY = (event as any)?.deltaY;
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY < 0) {
            wantsPinnedRef.current = false;
        }
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const markUserScrollIntentOnWeb = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        lastUserScrollIntentAtMsRef.current = Date.now();
    }, []);

    const cancelScheduledNativeEntryViewportRestoreRetry = React.useCallback(() => {
        const scheduled = scheduledNativeEntryViewportRestoreRetryRef.current;
        if (!scheduled) return;
        scheduledNativeEntryViewportRestoreRetryRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);

    const scheduleNativeEntryViewportRestoreRetry = React.useCallback((offsetY: number, nowMs: number = Date.now()) => {
        if (Platform.OS === 'web') return;
        const pending = pendingNativeEntryViewportRestoreRef.current;
        if (!pending || pending.sessionId !== props.sessionId || pending.offsetY !== offsetY) return;
        const scheduled = scheduledNativeEntryViewportRestoreRetryRef.current;
        if (scheduled?.sessionId === props.sessionId && scheduled.offsetY === offsetY) return;

        cancelScheduledNativeEntryViewportRestoreRetry();
        const elapsedSinceLastRetryMs = nowMs - lastNativeEntryViewportRestoreRetryAtMsRef.current;
        const delayMs = Math.max(0, TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS - elapsedSinceLastRetryMs + 1);
        const handle = {
            offsetY,
            sessionId: props.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (scheduledNativeEntryViewportRestoreRetryRef.current !== handle) return;
            scheduledNativeEntryViewportRestoreRetryRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            const latestPending = pendingNativeEntryViewportRestoreRef.current;
            if (!latestPending || latestPending.sessionId !== handle.sessionId || latestPending.offsetY !== handle.offsetY) return;
            if (latestJumpToSeqRef.current != null) return;
            if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return;
            lastNativeEntryViewportRestoreRetryAtMsRef.current = Date.now();
            tryRestoreEntryViewportRef.current?.({ force: true, retryPending: true });
        }, delayMs);
        scheduledNativeEntryViewportRestoreRetryRef.current = handle;
    }, [cancelScheduledNativeEntryViewportRestoreRetry, props.sessionId]);

    const updateNativeInitialViewportPendingObservation = React.useCallback((pending: boolean) => {
        if (Platform.OS === 'web') return;
        if (nativeInitialViewportPendingObservationRef.current === pending) return;
        nativeInitialViewportPendingObservationRef.current = pending;
        setNativeInitialViewportPendingObservation(pending);
    }, []);

    const invalidateQueuedNativeMountSettleRetries = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeMountSettleRetryGenerationRef.current += 1;
    }, []);

    const recordNativeUserScrollIntent = React.useCallback((nowMs: number = Date.now()) => {
        if (Platform.OS === 'web') return;
        lastUserScrollIntentAtMsRef.current = nowMs;
        pendingNativeMountSettleBottomPinRef.current = false;
        nativeMountSettleSameOffsetWakeRetryCountRef.current = 0;
        nativeBottomFollowTargetConfirmationRef.current = null;
        nativeBottomFollowStaleObservationCandidateRef.current = null;
        nativeMountSettleAutoPinSuppressedRef.current = true;
        updateNativeInitialViewportPendingObservation(false);
        invalidateQueuedNativeMountSettleRetries();
        cancelScheduledNativeEntryViewportRestoreRetry();
    }, [
        cancelScheduledNativeEntryViewportRestoreRetry,
        invalidateQueuedNativeMountSettleRetries,
        updateNativeInitialViewportPendingObservation,
    ]);

    const resetNativeSessionViewportLifecycle = React.useCallback((sessionId: string) => {
        if (Platform.OS === 'web') return;
        nativeContentMeasurementSessionRef.current = { sessionId, measured: false };
        nativeInitialViewportAppliedSessionRef.current = { sessionId, applied: false };
        nativeMountSettleSameOffsetWakeRetryCountRef.current = 0;
        updateNativeInitialViewportPendingObservation(false);
        invalidateQueuedNativeMountSettleRetries();
    }, [invalidateQueuedNativeMountSettleRetries, updateNativeInitialViewportPendingObservation]);

    const hasNativeContentMeasurementForCurrentSession = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return true;
        const state = nativeContentMeasurementSessionRef.current;
        return state.sessionId === props.sessionId && state.measured === true;
    }, [props.sessionId]);

    const markNativeContentMeasurementForCurrentSession = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeContentMeasurementSessionRef.current = { sessionId: props.sessionId, measured: true };
    }, [props.sessionId]);

    const hasNativeInitialViewportAppliedForCurrentSession = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return true;
        const state = nativeInitialViewportAppliedSessionRef.current;
        return state.sessionId === props.sessionId && state.applied === true;
    }, [props.sessionId]);

    const markNativeInitialViewportAppliedForCurrentSession = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeInitialViewportAppliedSessionRef.current = { sessionId: props.sessionId, applied: true };
        nativeMountSettleSameOffsetWakeRetryCountRef.current = 0;
        updateNativeInitialViewportPendingObservation(false);
        invalidateQueuedNativeMountSettleRetries();
    }, [
        invalidateQueuedNativeMountSettleRetries,
        props.sessionId,
        updateNativeInitialViewportPendingObservation,
    ]);

    const shouldRecordNativePassiveUnpinnedMovement = React.useCallback((distanceFromBottom: number, thresholdPx: number): boolean => {
        if (Platform.OS === 'web') return false;
        if (wantsPinnedRef.current) return false;
        if (!hasNativeContentMeasurementForCurrentSession()) return false;
        if (!hasNativeInitialViewportAppliedForCurrentSession()) return false;
        return distanceFromBottom > resolveNativePassiveBottomDriftNoiseFloorPx(thresholdPx);
    }, [
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
    ]);

    const shouldIgnoreNativeRecycledTopJump = React.useCallback((distanceFromBottom: number, thresholdPx: number): boolean => {
        if (Platform.OS === 'web') return false;
        if (wantsPinnedRef.current) return false;
        if (!Number.isFinite(distanceFromBottom)) return false;
        const previousDistanceFromBottom = lastPinOffsetForIntentRef.current;
        if (typeof previousDistanceFromBottom !== 'number' || !Number.isFinite(previousDistanceFromBottom)) return false;
        if (distanceFromBottom <= previousDistanceFromBottom) return false;

        const viewportHeight = listLayoutHeightRef.current;
        const viewportJumpThreshold =
            typeof viewportHeight === 'number' && Number.isFinite(viewportHeight) && viewportHeight > 0
                ? viewportHeight * TRANSCRIPT_NATIVE_PASSIVE_RECYCLED_JUMP_VIEWPORT_MULTIPLIER
                : 0;
        const pinnedThresholdJumpThreshold =
            Number.isFinite(thresholdPx) && thresholdPx > 0
                ? thresholdPx * TRANSCRIPT_NATIVE_PASSIVE_RECYCLED_JUMP_THRESHOLD_MULTIPLIER
                : 0;
        const jumpThreshold = Math.max(viewportJumpThreshold, pinnedThresholdJumpThreshold);
        return jumpThreshold > 0 && distanceFromBottom - previousDistanceFromBottom > jumpThreshold;
    }, []);

    const shouldIgnoreNativePassiveViewportScroll = React.useCallback((
        isTrusted: boolean,
        nowMs: number,
        distanceFromBottom: number,
        thresholdPx: number,
    ): boolean => {
        if (Platform.OS === 'web' || isTrusted) return false;
        if (!hasNativeContentMeasurementForCurrentSession()) return true;
        if (nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS) {
            return false;
        }
        if (!wantsPinnedRef.current) {
            if (distanceFromBottom <= resolveNativePassiveBottomDriftNoiseFloorPx(thresholdPx)) {
                return true;
            }
            const entryViewport = sessionEntryViewportRef.current;
            if (
                entryViewport?.sessionId === props.sessionId &&
                entryViewport.shouldFollowBottom === false &&
                !hasNativeInitialViewportAppliedForCurrentSession()
            ) {
                return true;
            }
            if (shouldIgnoreNativeRecycledTopJump(distanceFromBottom, thresholdPx)) {
                return true;
            }
            return !shouldRecordNativePassiveUnpinnedMovement(distanceFromBottom, thresholdPx);
        }
        return false;
    }, [
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        props.sessionId,
        shouldIgnoreNativeRecycledTopJump,
        shouldRecordNativePassiveUnpinnedMovement,
    ]);

    const refreshNativeRecentPassiveUserScrollIntent = React.useCallback((isTrusted: boolean, nowMs: number) => {
        if (Platform.OS === 'web' || isTrusted) return;
        if (nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS) return;
        recordNativeUserScrollIntent(nowMs);
    }, [recordNativeUserScrollIntent]);

        const recordNativeTranscriptTouchIntent = React.useCallback(() => {
            if (Platform.OS === 'web') return;
            pendingNativeEntryViewportRestoreRef.current = null;
            markNativeInitialViewportAppliedForCurrentSession();
            recordNativeUserScrollIntent();
        }, [markNativeInitialViewportAppliedForCurrentSession, recordNativeUserScrollIntent]);

    const resolveWebScrollMetrics = React.useCallback(() => {
        if (Platform.OS !== 'web') return null;
        if (typeof document === 'undefined') return null;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollContainerRef.current,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => {
                const sh = (el as any).scrollHeight;
                return typeof sh === 'number' && Number.isFinite(sh) ? sh : 0;
            },
        });
        if (metrics) {
            webScrollContainerRef.current = metrics.element;
        }
        return metrics;
    }, [chatListNativeId]);

    const resolveBackwardPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: tuning.transcriptBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);

    const waitForNextVisualUpdate = React.useCallback(async () => {
        await Promise.resolve();
        await Promise.resolve();
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            await new Promise<void>((resolve) => {
                raf(() => resolve());
            });
        }
    }, []);

    const motionConfig = React.useMemo(() => {
        return resolveTranscriptMotionConfig({
            reducedMotionPreferred,
            transcriptMotionPreset,
            transcriptMotionFreshnessMs,
            transcriptAnimateNewItemsEnabled,
            transcriptAnimateToolExpandCollapseEnabled,
            transcriptAnimateToolExpandCollapseFreshOnly,
            transcriptAnimateThinkingEnabled,
        });
    }, [
        reducedMotionPreferred,
        transcriptAnimateNewItemsEnabled,
        transcriptAnimateThinkingEnabled,
        transcriptAnimateToolExpandCollapseEnabled,
        transcriptAnimateToolExpandCollapseFreshOnly,
        transcriptMotionFreshnessMs,
        transcriptMotionPreset,
    ]);

    const transcriptScrollPinEnabled = useSetting('transcriptScrollPinEnabled');
    const transcriptScrollPinOffsetThresholdPx = useSetting('transcriptScrollPinOffsetThresholdPx');
    const transcriptScrollAutoFollowWhenPinned = useSetting('transcriptScrollAutoFollowWhenPinned');
    const transcriptScrollJumpToBottomEnabled = useSetting('transcriptScrollJumpToBottomEnabled');
    const transcriptScrollJumpToBottomMinNewCount = useSetting('transcriptScrollJumpToBottomMinNewCount');
    const transcriptScrollJumpToBottomRevealViewportRatio = useSetting('transcriptScrollJumpToBottomRevealViewportRatio');
    const transcriptScrollJumpToBottomAnimateScroll = useSetting('transcriptScrollJumpToBottomAnimateScroll');
    const transcriptListImplementation = useSetting('transcriptListImplementation');
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');

    const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>(() => ({
        isPinned: resolveSessionEntryBottomFollow(readSessionViewportForEntry(props.sessionId)),
        newActivityCount: 0,
        lastActivityKey: null,
    }));
    const [jumpToBottomDistanceFromBottom, setJumpToBottomDistanceFromBottom] = React.useState(0);
    const isPinnedRef = React.useRef(true);
    const sessionEntryViewportRef = React.useRef<{
        sessionId: string;
        shouldFollowBottom: boolean;
        offsetY: number;
        anchor: SessionViewportAnchorSnapshot | null;
    } | null>(null);
    if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) {
        const sessionViewport = readSessionViewportForEntry(props.sessionId);
        const shouldFollowBottom = resolveSessionEntryBottomFollow(sessionViewport);
        sessionEntryViewportRef.current = {
            sessionId: props.sessionId,
            shouldFollowBottom,
            offsetY: sessionViewport?.offsetY ?? 0,
            anchor: sessionViewport?.anchor ?? null,
        };
        wantsPinnedRef.current = shouldFollowBottom;
        isPinnedRef.current = shouldFollowBottom;
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : (sessionViewport?.offsetY ?? null);
        lastScrollOffsetForIntentRef.current = null;
        lastObservedWebScrollTopRef.current = null;
        lastNativePinOffsetRef.current = null;
        nativeAutomaticBottomPinCommandSessionRef.current = null;
        lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
        lastMeasuredContentActivityKeyRef.current = null;
            resetNativeSessionViewportLifecycle(props.sessionId);
            entryViewportRestoreAppliedRef.current = null;
            pendingNativeEntryViewportRestoreRef.current = null;
            cancelScheduledNativeEntryViewportRestoreRetry();
            lastNativeEntryViewportRestoreRetryAtMsRef.current = Number.NEGATIVE_INFINITY;
            entryAnchorRestoreRetryCountRef.current = 0;
        anchorLookupLoadCountRef.current = 0;
        anchorLookupInFlightRef.current = false;
    }
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );

    const clearOlderLoadSpinnerDelay = React.useCallback(() => {
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (!timeoutId) return;
        olderLoadSpinnerDelayTimeoutRef.current = null;
        clearTimeout(timeoutId);
    }, []);

    const hideOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(false);
    }, [clearOlderLoadSpinnerDelay]);

    const showOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(true);
    }, [clearOlderLoadSpinnerDelay]);

    const cancelScheduledNativeMountSettleRetry = React.useCallback(() => {
        const scheduled = scheduledNativeMountSettleRetryRef.current;
        if (!scheduled) return;
        scheduledNativeMountSettleRetryRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);

    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        pendingNativeMountSettleBottomPinRef.current = false;
        pendingNativeEntryViewportRestoreRef.current = null;
        nativeBottomFollowTargetConfirmationRef.current = null;
        nativeBottomFollowStaleObservationCandidateRef.current = null;
        cancelScheduledNativeEntryViewportRestoreRetry();
        cancelScheduledNativeMountSettleRetry();
    }, [
        cancelScheduledNativeEntryViewportRestoreRetry,
        cancelScheduledNativeMountSettleRetry,
        props.jumpToSeq,
    ]);

    const cancelScheduledPinToBottom = React.useCallback(() => {
        pendingNativeMountSettleBottomPinRef.current = false;
        cancelScheduledNativeMountSettleRetry();
        const scheduled = scheduledPinRef.current;
        if (!scheduled) return;
        scheduledPinRef.current = null;
        if (scheduled.kind === 'raf') {
            const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
            if (typeof caf === 'function') {
                caf(scheduled.id);
            }
            return;
        }
        clearTimeout(scheduled.id);
    }, [cancelScheduledNativeMountSettleRetry]);

    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        lastUserScrollIntentAtMsRef.current = Date.now();
        nativeMountSettleAutoPinSuppressedRef.current = true;
        cancelScheduledNativeMountSettleRetry();
        cancelScheduledPinToBottom();
    }, [cancelScheduledNativeMountSettleRetry, cancelScheduledPinToBottom]);

    const applyToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (params.expanded) {
                const toolMessageIds = params.toolMessageIds;
                const anchor = toolMessageIds.length > 0 ? toolMessageIds[toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor) {
                    next.add(anchor);
                }
            } else {
                for (const id of params.toolMessageIds) {
                    next.delete(id);
                }
            }
            return next;
        });
    }, []);

    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);

    const applyThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [thinkingDefaultExpanded]);

    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        deferAutoPinAfterLocalTranscriptInteraction();
        applyToolCallsGroupExpanded(params);
    }, [applyToolCallsGroupExpanded, deferAutoPinAfterLocalTranscriptInteraction]);

    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) === expanded) return;
        deferAutoPinAfterLocalTranscriptInteraction();
        applyThinkingExpanded(messageId, expanded);
    }, [applyThinkingExpanded, deferAutoPinAfterLocalTranscriptInteraction, resolveThinkingExpanded]);

    const onViewportChangeRef = React.useRef(props.onViewportChange);
    React.useEffect(() => {
        onViewportChangeRef.current = props.onViewportChange;
    }, [props.onViewportChange]);
    const emitViewportChange = React.useCallback((state: TranscriptViewportChangeState) => {
        onViewportChangeRef.current?.(state);
    }, []);
    const cancelScheduledViewportAnchorCapture = React.useCallback(() => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);
    const cancelScheduledEntryAnchorRestoreRetry = React.useCallback(() => {
        const scheduled = scheduledEntryAnchorRestoreRetryRef.current;
        if (!scheduled) return;
        scheduledEntryAnchorRestoreRetryRef.current = null;
        if (scheduled.kind === 'raf') {
            for (const id of scheduled.ids) {
                cancelAnimationFrame(id);
            }
            return;
        }
        for (const id of scheduled.ids) {
            clearTimeout(id);
        }
    }, []);
    const scheduleEntryAnchorRestoreRetry = React.useCallback((): boolean => {
        if (scheduledEntryAnchorRestoreRetryRef.current) return true;
        const retryMax = sync.getSyncTuning().transcriptViewportAnchorRenderRetryMax;
        if (entryAnchorRestoreRetryCountRef.current >= retryMax) return false;
        entryAnchorRestoreRetryCountRef.current += 1;

        const handle: { kind: 'timeout'; ids: any[]; sessionId: string } = { kind: 'timeout', ids: [], sessionId: props.sessionId };
        scheduledEntryAnchorRestoreRetryRef.current = handle;
        const timeoutId = setTimeout(() => {
            if (scheduledEntryAnchorRestoreRetryRef.current !== handle) return;
            scheduledEntryAnchorRestoreRetryRef.current = null;
            tryRestoreEntryViewportRef.current?.();
        }, 0);
        handle.ids.push(timeoutId);
        return true;
    }, [props.sessionId]);
    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(props.followBottomIntentKey ?? null);

    React.useEffect(() => {
        return () => {
            flushViewportAnchorCaptureRef.current();
            cancelScheduledEntryAnchorRestoreRetry();
            cancelScheduledNativeEntryViewportRestoreRetry();
            cancelScheduledNativeMountSettleRetry();
            initialFillAbortRef.current?.abort();
            initialFillAbortRef.current = null;
            const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
            if (timeoutId) {
                olderLoadSpinnerDelayTimeoutRef.current = null;
                clearTimeout(timeoutId);
            }
            mountSettleCoordinatorRef.current?.reset({ reason: 'unmount' });
            pendingNativeMountSettleBottomPinRef.current = false;
            nativeBottomFollowTargetConfirmationRef.current = null;
            nativeBottomFollowStaleObservationCandidateRef.current = null;
            nativeMountSettleAutoPinSuppressedRef.current = false;
        };
    }, [
        cancelScheduledEntryAnchorRestoreRetry,
        cancelScheduledNativeEntryViewportRestoreRetry,
        cancelScheduledNativeMountSettleRetry,
    ]);

    React.useEffect(() => {
        // Reset per-session state.
        flushViewportAnchorCaptureRef.current();
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        if (scheduledEntryAnchorRestoreRetryRef.current?.sessionId !== props.sessionId) {
            cancelScheduledEntryAnchorRestoreRetry();
        }
        cancelScheduledNativeMountSettleRetry();
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
        initialFillStatusRef.current = 'idle';
        setNativeMountSettleStable(false);
        nativeMountSettleDeadlineReachedRef.current = false;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        setNativeMountSettleDeadlineReached(false);
        hideOlderLoadSpinner();
        cancelScheduledPinToBottom();
        didAutoExpandToolCallsGroupsForSessionRef.current = null;
        inFlightWebPrependAnchorRef.current = null;
        pendingWebPrependAnchorRef.current = null;
        pendingWebPrependIndexRecoveryRef.current = false;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) {
            scheduledWebPrependIndexRecoveryRef.current = null;
            if (scheduledRecovery.kind === 'raf') {
                for (const id of scheduledRecovery.ids) {
                    cancelAnimationFrame(id);
                }
            } else {
                for (const id of scheduledRecovery.ids) {
                    clearTimeout(id);
                }
            }
        }
        setExpandedToolCallsAnchorMessageIds(new Set());
        const entryViewport = sessionEntryViewportRef.current;
        const shouldFollowBottom = entryViewport?.shouldFollowBottom ?? true;
        const offsetY = entryViewport?.offsetY ?? 0;
        const entryAnchor = shouldFollowBottom ? null : (entryViewport?.anchor ?? null);
        wantsPinnedRef.current = shouldFollowBottom;
        isPinnedRef.current = shouldFollowBottom;
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : offsetY;
        lastScrollOffsetForIntentRef.current = null;
        lastObservedWebScrollTopRef.current = null;
            lastNativePinOffsetRef.current = null;
            nativeBottomFollowTargetConfirmationRef.current = null;
            nativeBottomFollowStaleObservationCandidateRef.current = null;
            lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
            resetNativeSessionViewportLifecycle(props.sessionId);
            pendingNativeEntryViewportRestoreRef.current = null;
            if (Platform.OS !== 'web') {
                listContentHeightRef.current = 0;
                setListContentHeight(0);
        }
        pendingNativeMountSettleBottomPinRef.current = false;
        entryAnchorRestoreRetryCountRef.current = 0;
        setScrollPin({
            isPinned: shouldFollowBottom,
            newActivityCount: 0,
            lastActivityKey: null,
        });
        setJumpToBottomDistanceFromBottom(offsetY);
        emitViewportChange({
            isPinned: shouldFollowBottom,
            offsetY,
            shouldRestoreViewport: !shouldFollowBottom,
            anchor: entryAnchor,
        });
    }, [
        cancelScheduledEntryAnchorRestoreRetry,
        cancelScheduledNativeMountSettleRetry,
        cancelScheduledPinToBottom,
        cancelScheduledViewportAnchorCapture,
        emitViewportChange,
        hideOlderLoadSpinner,
        props.sessionId,
        resetNativeSessionViewportLifecycle,
    ]);

    const pinEnabled = transcriptScrollPinEnabled !== false;
    const pinThresholdPx =
        typeof transcriptScrollPinOffsetThresholdPx === 'number' && Number.isFinite(transcriptScrollPinOffsetThresholdPx)
            ? Math.max(0, Math.trunc(transcriptScrollPinOffsetThresholdPx))
            : 72;
    const autoFollowWhenPinned = transcriptScrollAutoFollowWhenPinned !== false;
    const jumpEnabled = transcriptScrollJumpToBottomEnabled !== false;
    const jumpMinNewCount =
        typeof transcriptScrollJumpToBottomMinNewCount === 'number' && Number.isFinite(transcriptScrollJumpToBottomMinNewCount)
            ? Math.max(1, Math.trunc(transcriptScrollJumpToBottomMinNewCount))
            : 1;
    const jumpRevealViewportRatio =
        typeof transcriptScrollJumpToBottomRevealViewportRatio === 'number' && Number.isFinite(transcriptScrollJumpToBottomRevealViewportRatio)
            ? Math.max(0, Math.min(TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX, transcriptScrollJumpToBottomRevealViewportRatio))
            : TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_FALLBACK;
    const jumpRevealOffsetThresholdPx = Math.max(pinThresholdPx, Math.trunc(listLayoutHeight * jumpRevealViewportRatio));
    const showJumpToBottom = jumpEnabled && !scrollPin.isPinned && jumpToBottomDistanceFromBottom >= jumpRevealOffsetThresholdPx;
    const jumpAnimateScroll = transcriptScrollJumpToBottomAnimateScroll !== false;

    const preferredListImplementation = transcriptListImplementation === 'flatlist_legacy' ? 'flatlist_legacy' : 'flash_v2';
    const webFlashListCrashed = useWebFlashListCrashFallback({
        enabled: Platform.OS === 'web' && preferredListImplementation === 'flash_v2',
    });
    const listImplementation =
        Platform.OS === 'web' && preferredListImplementation === 'flash_v2' && webFlashListCrashed
            ? 'flatlist_legacy'
            : preferredListImplementation;
    const [firstListPaintObserved, setFirstListPaintObserved] = React.useState(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        if (isEnrichedMarkdownRuntimePreloaded()) {
            setWebMarkdownRuntimeReady(true);
            return undefined;
        }

        let cancelled = false;
        const preload = preloadEnrichedMarkdownRuntime();
        fireAndForget(preload, { tag: 'ChatList.webMarkdownRuntimeFirstPaint' });
        preload.then(
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
        );

        return () => {
            cancelled = true;
        };
    }, []);

    const displayItems = React.useMemo(() => {
        if (listImplementation === 'flatlist_legacy') {
            // Legacy: inverted lists expect newest-first input.
            return [...props.items].reverse();
        }
        return props.items;
    }, [listImplementation, props.items]);
    const transcriptHotColdSegments = React.useMemo(() => {
        const tuning = sync.getSyncTuning();
        return buildTranscriptHotColdSegments({
            enabled: listImplementation === 'flash_v2',
            hotTailItemCount: tuning.transcriptWebHotTailItemCount,
            items: displayItems,
            activeThinkingMessageId: props.activeThinkingMessageId,
            expandedToolCallsAnchorMessageIds,
        });
    }, [displayItems, expandedToolCallsAnchorMessageIds, listImplementation, props.activeThinkingMessageId]);
    const shouldUseWebHotColdSplit =
        Platform.OS === 'web' &&
        listImplementation === 'flash_v2' &&
        transcriptHotColdSegments.hotItems.length > 0;
    const listData = shouldUseWebHotColdSplit ? transcriptHotColdSegments.coldItems : displayItems;

    React.useEffect(() => {
        setFirstListPaintObserved(false);
    }, [listImplementation, props.sessionId]);

    // Keep a synchronous view of the current list items for effects that run between renders
    // (e.g. initial viewport fill and jump-to-seq resolution).
    itemsRef.current = displayItems;
    listDataRef.current = listData;

    React.useEffect(() => {
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId: props.sessionId,
            latestMessageId: props.latestCommittedActivityKey,
            committedMessages: props.committedMessagesCount,
            transcriptLoaded: props.isLoaded ? 1 : 0,
            visibleItems: listData.length,
        });
    }, [
        listData.length,
        props.committedMessagesCount,
        props.isLoaded,
        props.latestCommittedActivityKey,
        props.sessionId,
    ]);

    React.useEffect(() => {
        return () => {
            clearSessionUiTelemetryMarks(props.sessionId);
        };
    }, [props.sessionId]);

    const usesNativeFlashListBottomMaintenance =
        Platform.OS !== 'web' && listImplementation === 'flash_v2';
    const nativeEntryShouldUseBottomMaintenance =
        sessionEntryViewportRef.current?.shouldFollowBottom !== false;
    const transcriptNativeMvcpOnlyMode =
        sync.getSyncTuning().transcriptNativeMvcpOnlyMode === true;
    const configuredFlashListDrawDistance = sync.getSyncTuning().transcriptFlashListDrawDistance;
    const flashListDrawDistance =
        Platform.OS !== 'web' &&
        typeof configuredFlashListDrawDistance === 'number' &&
        Number.isFinite(configuredFlashListDrawDistance) &&
        configuredFlashListDrawDistance > 0
            ? Math.trunc(configuredFlashListDrawDistance)
            : undefined;
    const telemetryPlatform = resolveTranscriptViewportTelemetryPlatform(Platform.OS);
    const telemetryListImplementation = resolveTranscriptViewportTelemetryListImplementation({
        platform: telemetryPlatform,
        listImplementation,
    });
    const resolveViewportTelemetryMode = React.useCallback((mode?: TranscriptViewportMode): TranscriptViewportMode => {
        return mode ?? (wantsPinnedRef.current ? 'follow-bottom' : 'user-unpinned');
    }, []);
    const recordViewportTelemetryEvent = React.useCallback((
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
    ) => {
        recordTranscriptViewportTelemetryEvent({
            ...event,
            sessionId: props.sessionId,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
            timestampMs: Date.now(),
        }, sync.getSyncTuning());
    }, [props.sessionId, telemetryListImplementation, telemetryPlatform]);
    const recordRestoreDecisionTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason,
        params: Readonly<{
            contentHeight?: number;
            layoutHeight?: number;
            mode?: TranscriptViewportMode;
            offsetY?: number;
        }> = {},
    ) => {
        recordViewportTelemetryEvent({
            type: 'restore-decision',
            mode: resolveViewportTelemetryMode(params.mode ?? 'restore-distance'),
            reason,
            offsetY: params.offsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
        });
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);

    const recordScrollObservedTelemetry = React.useCallback((
        params: Readonly<{
            contentHeight?: number;
            distanceFromBottom: number;
            layoutHeight?: number;
            offsetY: number;
            reason?: TranscriptViewportTelemetryObservationReason;
        }>,
    ) => {
        recordViewportTelemetryEvent({
            type: 'scroll-observed',
            mode: resolveViewportTelemetryMode(),
            reason: params.reason ?? 'observed',
            offsetY: params.offsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
        });
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);

        const recordWebAnchorRestoreMutationTelemetry = React.useCallback((
            params: Readonly<{
            didAdjustScroll: boolean;
            mode: Extract<TranscriptViewportMode, 'restore-anchor' | 'restore-distance'>;
            previousOffsetY: number;
            reason: TranscriptViewportTelemetryScrollReason;
            metrics: WebTranscriptScrollMetrics;
        }>,
    ) => {
        if (!params.didAdjustScroll) return;
        const targetOffsetY = params.metrics.element.scrollTop;
        const currentClientHeight =
            typeof params.metrics.element.clientHeight === 'number' && Number.isFinite(params.metrics.element.clientHeight)
                ? params.metrics.element.clientHeight
                : params.metrics.clientHeight;
        const currentScrollHeight =
            typeof params.metrics.element.scrollHeight === 'number' && Number.isFinite(params.metrics.element.scrollHeight)
                ? params.metrics.element.scrollHeight
                : params.metrics.scrollHeight;
        recordViewportTelemetryEvent({
            type: 'scroll-write',
            writer: 'web-dom-restore',
            reason: params.reason,
            mode: params.mode,
            targetOffsetY,
            previousOffsetY: params.previousOffsetY,
            layoutHeight: currentClientHeight,
            contentHeight: currentScrollHeight,
            distanceFromBottom: Math.max(0, Math.trunc(currentScrollHeight - currentClientHeight - targetOffsetY)),
            });
        }, [recordViewportTelemetryEvent]);

    const resolveViewportCommand = React.useCallback((input: TranscriptViewportControllerInput): TranscriptViewportCommand => {
        return viewportControllerRef.current!.resolve(input);
    }, []);

    const executeViewportCommand = React.useCallback((command: TranscriptViewportCommand): boolean => {
        if (command.kind === 'none') return false;
        if (!viewportCommandActiveRef.current) return false;
        if (command.sessionId !== currentSessionIdRef.current) return false;
        if (command.kind === 'skip-native-js-pin') {
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: 'mvcp-skip',
                reason: command.reason,
                mode: command.mode,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                distanceFromBottom: lastPinOffsetForIntentRef.current ?? undefined,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'pin-bottom') {
            if (Platform.OS === 'web') {
                const metrics = resolveWebScrollMetrics();
                if (!metrics) return false;
                const previousOffsetY = metrics.scrollTop;
                const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
                try {
                    metrics.element.scrollTop = scrollToVisualBottom ? metrics.scrollHeight : 0;
                } catch {
                    try {
                        metrics.element.scrollTop = scrollToVisualBottom ? metrics.scrollHeight : 0;
                    } catch {
                        return false;
                    }
                }
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                const targetOffsetY = metrics.element.scrollTop;
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: 'web-dom-bottom',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY,
                    previousOffsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                    distanceFromBottom: Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - targetOffsetY)),
                });
                return true;
            }

            const node = listRef.current;
            if (!node || typeof node.scrollToOffset !== 'function') return false;
            const offset =
                listImplementation === 'flatlist_legacy'
                    ? 0
                    : Math.max(0, Math.trunc(listContentHeightRef.current - listLayoutHeightRef.current));
            node.scrollToOffset({ offset, animated: command.animated ?? false });
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY: offset,
                previousOffsetY: lastNativePinOffsetRef.current ?? undefined,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                distanceFromBottom: 0,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'scroll-offset' || command.kind === 'restore-offset') {
            if (Platform.OS === 'web') {
                const metrics = resolveWebScrollMetrics();
                if (!metrics) return false;
                const previousOffsetY = metrics.scrollTop;
                const targetOffsetY = command.kind === 'restore-offset'
                    ? listImplementation === 'flatlist_legacy'
                        ? Math.min(resolveWebTranscriptMaxScrollTop(metrics), command.offsetY)
                        : Math.max(0, resolveWebTranscriptMaxScrollTop(metrics) - command.offsetY)
                    : Math.max(0, Math.trunc(command.offsetY));
                try {
                    metrics.element.scrollTop = targetOffsetY;
                } catch {
                    return false;
                }
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: command.mode === 'follow-bottom' || command.mode === 'jump-to-bottom'
                        ? 'web-dom-bottom'
                        : 'web-dom-restore',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY,
                    previousOffsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                    distanceFromBottom: command.kind === 'restore-offset'
                        ? command.offsetY
                        : Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - targetOffsetY)),
                });
                return true;
            }

            const node = listRef.current;
            if (!node || typeof node.scrollToOffset !== 'function') return false;
            const layoutHeight = listLayoutHeightRef.current;
            const contentHeight = command.kind === 'restore-offset' && typeof command.contentHeight === 'number' && Number.isFinite(command.contentHeight)
                ? Math.max(0, Math.trunc(command.contentHeight))
                : listContentHeightRef.current;
            const maxOffset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
            const targetOffsetY = command.kind === 'restore-offset'
                ? listImplementation === 'flatlist_legacy'
                    ? Math.min(maxOffset, command.offsetY)
                    : Math.max(0, maxOffset - command.offsetY)
                : Math.max(0, Math.trunc(command.offsetY));
            node.scrollToOffset({ offset: targetOffsetY, animated: command.animated ?? false });
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY,
                previousOffsetY: lastNativePinOffsetRef.current ?? undefined,
                layoutHeight,
                contentHeight,
                distanceFromBottom: command.kind === 'restore-offset' ? command.offsetY : undefined,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'restore-index' || command.kind === 'jump-to-seq') {
            const index = command.kind === 'restore-index' ? command.index : command.index;
            if (typeof index !== 'number' || !Number.isFinite(index)) return false;
            const node = listRef.current;
            if (!node || typeof node.scrollToIndex !== 'function') return false;
                if (command.kind === 'restore-index') {
                    const restoreParams = {
                        index,
                        animated: command.animated ?? false,
                        viewOffset: command.viewOffset,
                        ...(Platform.OS === 'web' ? { viewPosition: 0 } : {}),
                    };
                    node.scrollToIndex(restoreParams);
                } else {
                node.scrollToIndex({ index, animated: command.animated ?? true, viewPosition: 0.5 });
            }
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: resolveIndexScrollWriter({
                        platform: telemetryPlatform,
                        listImplementation,
                    }),
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY: index,
                    layoutHeight: listLayoutHeightRef.current,
                    contentHeight: listContentHeightRef.current,
                    nativeMountSettleStable,
                });
                return true;
            }

        return false;
    }, [
            listImplementation,
            nativeMountSettleStable,
            recordViewportTelemetryEvent,
            resolveWebScrollMetrics,
            telemetryPlatform,
        ]);

    const observeMountSettleMetrics = React.useCallback((options: Readonly<{
        distanceFromBottom?: number;
        nowMs?: number;
    }> = {}) => {
        mountSettleCoordinatorRef.current?.observeMetrics({
            sessionId: props.sessionId,
            nowMs: options.nowMs ?? Date.now(),
            initialFillStatus: initialFillStatusRef.current,
            listContentHeight: listContentHeightRef.current,
            listLayoutHeight: listLayoutHeightRef.current,
            composerInsetHeight: composerInsetHeightRef.current,
            distanceFromBottom: options.distanceFromBottom ?? lastPinOffsetForIntentRef.current ?? 0,
        });
    }, [props.sessionId]);

    React.useEffect(() => {
        if (!usesNativeFlashListBottomMaintenance) return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;
        const intervalId = setInterval(() => {
            const coordinator = mountSettleCoordinatorRef.current;
            if (!coordinator) {
                clearInterval(intervalId);
                return;
            }
            const nowMs = Date.now();
            coordinator.sample({ sessionId: props.sessionId, nowMs });
            if (coordinator.getSnapshot().stableSettle) {
                setNativeMountSettleStable(true);
                nativeMountSettleDeadlineReachedRef.current = false;
                flushPendingNativeMountSettleBottomPinRef.current?.();
                clearInterval(intervalId);
                return;
            }
            if (nowMs >= deadlineMs) {
                nativeMountSettleDeadlineReachedRef.current = true;
                setNativeMountSettleDeadlineReached(true);
                if (!nativeMountSettleAutoPinSuppressedRef.current) {
                    pendingNativeMountSettleBottomPinRef.current = true;
                    flushPendingNativeMountSettleBottomPinRef.current?.();
                }
                clearInterval(intervalId);
            }
        }, intervalMs);
        return () => clearInterval(intervalId);
    }, [props.sessionId, usesNativeFlashListBottomMaintenance]);

    const recordFirstListPaint = React.useCallback(() => {
        setFirstListPaintObserved(true);
        const nowMs = Date.now();
        mountSettleCoordinatorRef.current?.recordFirstListPaint({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
    }, [observeMountSettleMetrics, props.sessionId]);

    const recordLayoutCommitObserved = React.useCallback(() => {
        const nowMs = Date.now();
        mountSettleCoordinatorRef.current?.recordLayoutCommitObserved({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
    }, [observeMountSettleMetrics, props.sessionId]);

    const shouldCommitContentHeightState = React.useCallback(() => {
        if (Platform.OS === 'web') return true;
        if (initialFillStatusRef.current !== 'done') return true;
        return props.jumpToSeq != null;
    }, [props.jumpToSeq]);

    const flashListMvcpThresholdLayoutHeight = nativeMountSettleStable ? listLayoutHeight : 0;
    const flashListMaintainVisibleContentPosition = React.useMemo(() => {
        // FlashList/web can throw "index out of bounds, not enough layouts" under heavy append + scroll
        // when `maintainVisibleContentPosition.startRenderingFromBottom` is enabled. On web we already
        // pin via direct DOM scroll writes, so omit this prop to avoid the crash.
        if (Platform.OS === 'web') return undefined;
        if (!nativeEntryShouldUseBottomMaintenance) return undefined;
        const autoscrollToBottomThreshold =
            pinEnabled && autoFollowWhenPinned
                ? (flashListMvcpThresholdLayoutHeight > 0 ? pinThresholdPx / flashListMvcpThresholdLayoutHeight : 0)
                : undefined;
        return {
            startRenderingFromBottom: true,
            ...(typeof autoscrollToBottomThreshold === 'number'
                ? {
                    autoscrollToBottomThreshold: Math.max(0, Math.min(1, autoscrollToBottomThreshold)),
                    animateAutoScrollToBottom: false,
                }
                : {}),
        } as const;
    }, [autoFollowWhenPinned, flashListMvcpThresholdLayoutHeight, nativeEntryShouldUseBottomMaintenance, pinEnabled, pinThresholdPx]);

    const flatListMaintainVisibleContentPosition = React.useMemo(() => {
        return pinEnabled && autoFollowWhenPinned
            ? { minIndexForVisible: 0, autoscrollToTopThreshold: pinThresholdPx }
            : undefined;
    }, [autoFollowWhenPinned, pinEnabled, pinThresholdPx]);

    const resolveCreatedAtForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const createdAt = message?.createdAt;
        return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
    }, [props.sessionId]);

    const resolveSeqForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const seq = message?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [props.sessionId]);

    const resolveKindForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const kind = message?.kind;
        return typeof kind === 'string' ? kind : null;
    }, [props.sessionId]);

    const getTurnMessageById = React.useCallback((messageId: string): Message | null => {
        const forkAwareMessage = props.messagesById[messageId];
        if (forkAwareMessage) return forkAwareMessage;
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        return session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
    }, [props.messagesById, props.sessionId]);
    const resolveForkedTurnMessageOrigin = React.useCallback((messageId: string) => {
        const metadata = props.forkMessageMetadataById?.[messageId] ?? null;
        if (!metadata) return null;
        return {
            sessionId: metadata.originSessionId,
            isReadOnlyContext: metadata.isReadOnlyContext,
        };
    }, [props.forkMessageMetadataById]);
    const getTurnMessageOrigin = props.forkedTranscriptEnabled ? resolveForkedTurnMessageOrigin : undefined;

    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const keyExtractor = useCallback((item: ChatTranscriptListItem) => item.id, []);
    const rowWidthBucket = listLayoutWidthBucket;
    const rowFontScaleKey = resolveFontScaleKey();
    const getItemType = useCallback((item: ChatTranscriptListItem): string => (
        resolveTranscriptRowItemType({
            activeThinkingMessageId: props.activeThinkingMessageId,
            getMessageById: getTurnMessageById,
            item,
        })
    ), [getTurnMessageById, props.activeThinkingMessageId]);
    const resolveRollbackActionForMessage = React.useCallback((messageId: string): TranscriptRollbackAction | null => {
        return props.rollbackActionsByMessageId[messageId] ?? null;
    }, [props.rollbackActionsByMessageId]);
    const buildRowShellSignature = React.useCallback((item: ChatTranscriptListItem) => (
        buildTranscriptRowShellSignature({
            activeThinkingMessageId: props.activeThinkingMessageId,
            expandedToolCallsAnchorMessageIds,
            forkMessageMetadataById: props.forkMessageMetadataById,
            getMessageById: getTurnMessageById,
            groupingMode: props.groupingMode,
            item,
            latestCommittedActivityKey: props.latestCommittedActivityKey,
            resolveThinkingExpanded,
            sessionActive: props.sessionActive,
            widthBucket: rowWidthBucket,
            fontScaleKey: rowFontScaleKey,
        })
    ), [
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        props.groupingMode,
        props.activeThinkingMessageId,
        props.forkMessageMetadataById,
        props.latestCommittedActivityKey,
        props.sessionActive,
        resolveThinkingExpanded,
        rowFontScaleKey,
        rowWidthBucket,
    ]);
    const isWarmKeepAliveInstance = props.isWarmKeepAliveInstance === true;
    const shouldHoldNativeFirstPaintPlaceholderForMountSettle =
        usesNativeFlashListBottomMaintenance &&
        sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
        props.jumpToSeq == null &&
        !nativeMountSettleStable &&
        !nativeMountSettleDeadlineReached;
    const shouldHoldNativeFirstPaintPlaceholderForPendingViewport =
        usesNativeFlashListBottomMaintenance &&
        sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
        props.jumpToSeq == null &&
        nativeInitialViewportPendingObservation;
    const shouldHoldNativeFirstPaintPlaceholder =
        (
            !nativeMountSettleStable &&
            !nativeMountSettleDeadlineReached &&
            (!firstListPaintObserved || shouldHoldNativeFirstPaintPlaceholderForMountSettle)
        ) ||
        shouldHoldNativeFirstPaintPlaceholderForPendingViewport;
    const showNativeFirstPaintPlaceholder =
        Platform.OS !== 'web' &&
        listImplementation === 'flash_v2' &&
        props.isLoaded &&
        listData.length > 0 &&
        !isWarmKeepAliveInstance &&
        shouldHoldNativeFirstPaintPlaceholder;
    const showWebMarkdownRuntimeFirstPaintPlaceholder =
        Platform.OS === 'web' &&
        listImplementation === 'flash_v2' &&
        props.isLoaded &&
        listData.length > 0 &&
        !webMarkdownRuntimeReady;
    const showFirstPaintPlaceholder = showNativeFirstPaintPlaceholder || showWebMarkdownRuntimeFirstPaintPlaceholder;
    const wrapTranscriptItemForAnchor = React.useCallback((item: ChatTranscriptListItem, node: React.ReactNode) => {
        const signature = buildRowShellSignature(item);
        return (
            <TranscriptRowShell
                cache={rowShellHeightCache}
                itemId={item.id}
                signature={signature}
            >
                {node}
            </TranscriptRowShell>
        );
    }, [buildRowShellSignature, rowShellHeightCache]);

    const captureCurrentWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        const tuning = sync.getSyncTuning();
        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            stabilizeForMs: tuning.transcriptWebInitialPinStabilizeMs,
        });
        return anchor;
    }, [listImplementation, pinThresholdPx, resolveWebScrollMetrics]);

    const captureCurrentViewportAnchor = React.useCallback((): SessionViewportAnchorSnapshot | null => {
        if (wantsPinnedRef.current) return null;

        const capturedAtMs = Date.now();
        if (Platform.OS === 'web' && listImplementation === 'flash_v2') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return null;
            const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
            if (!anchor) return null;
            return {
                ...anchor,
                capturedAtMs,
            };
        }

        if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
            const result = captureNativeTranscriptViewportAnchor({
                ref: listRef.current,
                data: listDataRef.current,
                focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(listLayoutHeightRef.current),
                capturedAtMs,
                resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
            });
            return result.status === 'captured' ? result.anchor : null;
        }

        return null;
    }, [listImplementation, resolveWebScrollMetrics]);

    const emitViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        generation: number,
        wantsPinned: boolean,
        emit: ((nextState: TranscriptViewportChangeState) => void) | undefined,
        captureAnchor: () => SessionViewportAnchorSnapshot | null,
    ) => {
        if (viewportAnchorCaptureGenerationRef.current !== generation) return;
        if (state.shouldRestoreViewport !== true || state.isPinned === true || wantsPinned) return;

        emit?.({
            ...state,
            anchor: captureAnchor(),
        });
    }, []);

    const scheduleViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => {
        if (options?.suppressAnchorCapture === true) {
            viewportAnchorCaptureGenerationRef.current += 1;
            cancelScheduledViewportAnchorCapture();
            return;
        }

        if (state.shouldRestoreViewport !== true || state.isPinned === true) {
            viewportAnchorCaptureGenerationRef.current += 1;
            cancelScheduledViewportAnchorCapture();
            return;
        }

        const debounceMs = sync.getSyncTuning().transcriptViewportAnchorCaptureDebounceMs;
        const captureAnchor = captureCurrentViewportAnchor;
        const emit = onViewportChangeRef.current;
        const generation = viewportAnchorCaptureGenerationRef.current;
        const wantsPinned = wantsPinnedRef.current;
        cancelScheduledViewportAnchorCapture();
        const timeoutId = setTimeout(() => {
            const scheduled = scheduledViewportAnchorCaptureRef.current;
            if (!scheduled || scheduled.timeoutId !== timeoutId) return;
            scheduledViewportAnchorCaptureRef.current = null;
            emitViewportAnchorCapture(
                scheduled.state,
                scheduled.generation,
                scheduled.wantsPinned,
                scheduled.emit,
                scheduled.captureAnchor,
            );
        }, debounceMs);
        scheduledViewportAnchorCaptureRef.current = { captureAnchor, emit, generation, state, timeoutId, wantsPinned };
    }, [cancelScheduledViewportAnchorCapture, captureCurrentViewportAnchor, emitViewportAnchorCapture]);

    const flushScheduledViewportAnchorCapture = React.useCallback(() => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
        emitViewportAnchorCapture(
            scheduled.state,
            scheduled.generation,
            scheduled.wantsPinned,
            scheduled.emit,
            scheduled.captureAnchor,
        );
    }, [emitViewportAnchorCapture]);

    React.useLayoutEffect(() => {
        flushViewportAnchorCaptureRef.current = flushScheduledViewportAnchorCapture;
    }, [flushScheduledViewportAnchorCapture]);

    const refreshInFlightWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const currentAnchor = inFlightWebPrependAnchorRef.current;
        if (!currentAnchor) return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        if (!isWebTranscriptScrollable(metrics, 1)) return;
        inFlightWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(currentAnchor, {
            ...metrics,
            scrollHeight: currentAnchor.metrics.scrollHeight,
        }, {
            recaptureAnchor: true,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
        });
    }, [listImplementation, resolveWebScrollMetrics]);

    const resolvePendingWebPrependRefreshOptions = React.useCallback((strategy: 'anchor' | 'item' | 'growth' | 'none') => {
        if (strategy === 'anchor') {
            return { recaptureAnchor: true, recaptureItem: true } as const;
        }
        if (strategy === 'item') {
            return { recaptureItem: true } as const;
        }
        return { preserveBaselineMetrics: true } as const;
    }, []);

    const resolvePendingWebPrependItemIndex = React.useCallback((itemTestId: string | null): number | null => {
        if (!itemTestId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) return null;
        const itemId = itemTestId.slice(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        const index = itemsRef.current.findIndex((item) => item.id === itemId);
        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependAnchorIndex = React.useCallback((anchorTestId: string | null): number | null => {
        let anchorMessageId: string | null = null;
        if (anchorTestId?.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        } else if (anchorTestId?.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        }
        if (!anchorMessageId) return null;

        const index = itemsRef.current.findIndex((item) => {
            if (item.kind === 'message') {
                return item.messageId === anchorMessageId;
            }
            if (item.kind === 'tool-calls-group') {
                return item.toolMessageIds.includes(anchorMessageId);
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId === anchorMessageId) return true;
                return item.turn.content.some((content) => {
                    if (content.kind === 'message') {
                        return content.messageId === anchorMessageId;
                    }
                    if (content.kind === 'tool_calls') {
                        return content.toolMessageIds.includes(anchorMessageId);
                    }
                    return false;
                });
            }
            return false;
        });

        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependRecoveryIndex = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): number | null => {
        if (!pendingAnchor) return null;
        return resolvePendingWebPrependAnchorIndex(pendingAnchor.anchorTestId) ?? resolvePendingWebPrependItemIndex(pendingAnchor.itemTestId);
    }, [resolvePendingWebPrependAnchorIndex, resolvePendingWebPrependItemIndex]);

        const tryScrollPendingWebPrependItemIntoView = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): boolean => {
            if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
            const index = resolvePendingWebPrependRecoveryIndex(pendingAnchor);
            if (index == null) return false;
            try {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: false,
                    entrySnapshot: {
                        shouldFollowBottom: false,
                        offsetY: 0,
                        anchorIndex: index,
                    },
                    jumpToSeq: null,
                    platform: telemetryPlatform,
                    listImplementation: telemetryListImplementation,
                }));
            } catch {
                return false;
            }
        }, [
            executeViewportCommand,
            listImplementation,
            props.sessionId,
            resolvePendingWebPrependRecoveryIndex,
            resolveViewportCommand,
            telemetryListImplementation,
            telemetryPlatform,
        ]);

    const attemptPendingWebPrependIndexRecovery = React.useCallback((): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        if (!pendingWebPrependIndexRecoveryRef.current || !pendingWebPrependAnchorRef.current) return false;
        const didRecoverIndex = tryScrollPendingWebPrependItemIntoView(pendingWebPrependAnchorRef.current);
        if (!didRecoverIndex) return false;

        pendingWebPrependIndexRecoveryRef.current = false;
        const retryAnchor = pendingWebPrependAnchorRef.current;
        const previousOffsetY = retryAnchor.metrics.element.scrollTop;
        const retryRestoreResult = restoreWebTranscriptPrependAnchor(retryAnchor);
            recordWebAnchorRestoreMutationTelemetry({
            didAdjustScroll: retryRestoreResult.didAdjustScroll,
            mode: 'restore-anchor',
            previousOffsetY,
            reason: 'entry-restore',
            metrics: retryAnchor.metrics,
        });
        const retryMetrics = resolveWebScrollMetrics();
        if (!retryMetrics) {
            pendingWebPrependAnchorRef.current = null;
            return true;
        }
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            retryAnchor,
            retryMetrics,
            resolvePendingWebPrependRefreshOptions(retryRestoreResult.strategy),
        );
        return true;
        }, [
            listImplementation,
            recordWebAnchorRestoreMutationTelemetry,
            resolvePendingWebPrependRefreshOptions,
            resolveWebScrollMetrics,
            tryScrollPendingWebPrependItemIntoView,
    ]);

    const schedulePendingWebPrependIndexRecovery = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) return;

        if (typeof requestAnimationFrame === 'function') {
            const handle: { kind: 'raf'; ids: any[] } = { kind: 'raf', ids: [] };
            scheduledWebPrependIndexRecoveryRef.current = handle;
            const first = requestAnimationFrame(() => {
                const second = requestAnimationFrame(() => {
                    if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
                    scheduledWebPrependIndexRecoveryRef.current = null;
                    attemptPendingWebPrependIndexRecovery();
                });
                handle.ids.push(second);
            });
            handle.ids.push(first);
            return;
        }

        const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
        scheduledWebPrependIndexRecoveryRef.current = handle;
        const timeoutId = setTimeout(() => {
            if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
            scheduledWebPrependIndexRecoveryRef.current = null;
            attemptPendingWebPrependIndexRecovery();
        }, 0);
        handle.ids.push(timeoutId);
    }, [attemptPendingWebPrependIndexRecovery, listImplementation]);

      const renderItem = useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
          if (item.kind === 'action-draft') {
              return wrapTranscriptItemForAnchor(item, <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />);
          }
        if (item.kind === 'fork-divider') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={0}>
                    <ForkDividerRow
                        parentSessionId={item.parentSessionId}
                        childSessionId={item.childSessionId}
                        parentCutoffSeqInclusive={item.parentCutoffSeqInclusive}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-queue') {
            const createdAt = item.pendingMessages[0]?.createdAt ?? item.discardedMessages[0]?.createdAt ?? 0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={props.sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'tool-calls-group') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={interaction}
                    approvalRequests={props.approvalRequests}
                    getMessageById={props.forkedTranscriptEnabled ? getTurnMessageById : undefined}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'turn') {
            const turnCreatedAt =
                (item.turn.userMessageId ? resolveCreatedAtForMessageId(item.turn.userMessageId) : null) ??
                (item.turn.content[0]?.kind === 'message'
                    ? resolveCreatedAtForMessageId(item.turn.content[0].messageId)
                    : item.turn.content[0]?.kind === 'tool_calls'
                        ? (item.turn.content[0].toolMessageIds[0]
                            ? resolveCreatedAtForMessageId(item.turn.content[0].toolMessageIds[0])
                            : null)
                        : null) ??
                0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
                          <TurnViewWithSessionCommon
                           turn={item.turn}
                           metadata={props.metadata}
                           sessionId={props.sessionId}
                           interaction={props.interaction}
                           activeThinkingMessageId={props.activeThinkingMessageId}
                           getMessageById={getTurnMessageById}
                           getMessageOrigin={getTurnMessageOrigin}
                           approvalRequests={props.approvalRequests}
                           rollbackRanges={props.rollbackRanges}
                           resolveRollbackAction={resolveRollbackActionForMessage}
                             resolveThinkingExpanded={resolveThinkingExpanded}
                             setThinkingExpanded={setThinkingExpanded}
                           expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                          setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                          forkCommon={props.forkCommon}
                          messageDisplayCommon={props.messageDisplayCommon}
                          toolChromeCommon={props.toolChromeCommon}
                          toolRouteCommon={toolRouteCommonRef.current}
                      />
                  </TranscriptEnterWrapper>
              ));
          }
        if (item.kind === 'message') {
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            const prev = listImplementation === 'flash_v2' ? itemsRef.current[index - 1] : undefined;
            const shouldTightenToolStack =
                listImplementation === 'flash_v2' &&
                toolChromeMode === 'activity_feed' &&
                resolveKindForMessageId(item.messageId) === 'tool-call' &&
                prev?.kind === 'message' &&
                resolveKindForMessageId(prev.messageId) === 'tool-call';
            const wrapperStyle = shouldTightenToolStack ? { marginTop: -12 } : undefined;

            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={props.sessionId}
                            messageId={item.messageId}
                            messageOverride={item.originSessionId ? (props.messagesById[item.messageId] ?? null) : undefined}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            metadata={props.metadata}
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={props.interaction}
                            rollbackAction={props.rollbackActionsByMessageId[item.messageId] ?? null}
                            rollbackRanges={props.rollbackRanges}
                            approvalRequests={props.approvalRequests}
                            forkCommon={props.forkCommon}
                            messageDisplayCommon={props.messageDisplayCommon}
                            toolChromeCommon={props.toolChromeCommon}
                            toolRouteCommon={toolRouteCommonRef.current}
                        />
                    </View>
                </TranscriptEnterWrapper>
            ));
        }
        return null;
      }, [expandedToolCallsAnchorMessageIds, getTurnMessageById, getTurnMessageOrigin, listImplementation, props.activeThinkingMessageId, props.approvalRequests, props.forkCommon, props.interaction, props.messageDisplayCommon, props.metadata, props.rollbackRanges, props.sessionId, props.toolChromeCommon, resolveCreatedAtForMessageId, resolveKindForMessageId, resolveRollbackActionForMessage, resolveThinkingExpanded, setThinkingExpanded, setToolCallsGroupExpanded, toolTimelineChromeMode, wrapTranscriptItemForAnchor]);
    const renderTranscriptItemAtIndex = React.useCallback((item: ChatTranscriptListItem, index: number) => {
        return renderItem({ item, index });
    }, [renderItem]);
    const listHeaderNode = React.useMemo(() => (
        <ListHeader isLoadingOlder={isLoadingOlder} />
    ), [isLoadingOlder]);

    const loadOlder = useCallback(async (options: LoadOlderOptions = {}): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded && props.forkedTranscriptEnabled !== true) return null;
        const showLoadingIndicator = options.showLoadingIndicator !== false;
        if (loadOlderInFlight.current || hasMoreOlder === false) {
            if (loadOlderInFlight.current && showLoadingIndicator && options.loadingIndicatorDelayMs === 0) {
                showOlderLoadSpinner();
            }
            return null;
        }
        loadOlderInFlight.current = true;
        const loadingIndicatorDelayMs = typeof options.loadingIndicatorDelayMs === 'number' && Number.isFinite(options.loadingIndicatorDelayMs)
            ? Math.max(0, Math.trunc(options.loadingIndicatorDelayMs))
            : 0;
        if (!showLoadingIndicator) {
            clearOlderLoadSpinnerDelay();
        } else if (loadingIndicatorDelayMs > 0) {
            olderLoadSpinnerDelayTimeoutRef.current = setTimeout(() => {
                olderLoadSpinnerDelayTimeoutRef.current = null;
                setIsLoadingOlder(true);
            }, loadingIndicatorDelayMs);
        } else {
            showOlderLoadSpinner();
        }
        try {
            inFlightWebPrependAnchorRef.current = captureCurrentWebPrependAnchor();

            const result = props.forkedTranscriptEnabled
                ? await sync.loadOlderMessagesForkAware(props.sessionId)
                : await sync.loadOlderMessages(props.sessionId);

            const webPrependAnchor = inFlightWebPrependAnchorRef.current;
            inFlightWebPrependAnchorRef.current = null;

            if (webPrependAnchor && result.loaded > 0) {
                pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                    webPrependAnchor,
                    webPrependAnchor.metrics,
                    {
                        resetExpiry: true,
                        userIntentAtMs: lastUserScrollIntentAtMsRef.current,
                    },
                );
                const previousOffsetY = pendingWebPrependAnchorRef.current.metrics.element.scrollTop;
                const restoreResult = restoreWebTranscriptPrependAnchor(pendingWebPrependAnchorRef.current);
                recordWebAnchorRestoreMutationTelemetry({
                    didAdjustScroll: restoreResult.didAdjustScroll,
                    mode: 'restore-anchor',
                    previousOffsetY,
                    reason: 'entry-restore',
                    metrics: pendingWebPrependAnchorRef.current.metrics,
                });
                const metrics = resolveWebScrollMetrics();
                if (metrics && pendingWebPrependAnchorRef.current) {
                    pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                        pendingWebPrependAnchorRef.current,
                        metrics,
                        resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
                    );
                }
                pendingWebPrependIndexRecoveryRef.current = restoreResult.strategy === 'growth';
                if (restoreResult.strategy === 'growth') {
                    schedulePendingWebPrependIndexRecovery();
                }
            }

            if (result.status === 'no_more') {
                setHasMoreOlder(false);
            } else if (result.status === 'loaded' || result.status === 'not_ready' || result.status === 'in_flight') {
                setHasMoreOlder(result.hasMore);
            }
            return {
                loaded: result.loaded,
                hasMore: result.hasMore,
                status: result.status,
            };
        } finally {
            inFlightWebPrependAnchorRef.current = null;
            hideOlderLoadSpinner();
            loadOlderInFlight.current = false;
        }
    }, [
        captureCurrentWebPrependAnchor,
        clearOlderLoadSpinnerDelay,
        hasMoreOlder,
        hideOlderLoadSpinner,
        listImplementation,
        pinThresholdPx,
        props.committedMessagesCount,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.sessionId,
        recordWebAnchorRestoreMutationTelemetry,
        resolveWebScrollMetrics,
        showOlderLoadSpinner,
    ]);
    loadOlderForAnchorLookupRef.current = loadOlder;

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;

        const pendingAnchor = pendingWebPrependAnchorRef.current;
        if (!pendingAnchor) return;
        if (pendingAnchor.userIntentAtMs !== lastUserScrollIntentAtMsRef.current) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            return;
        }
        if (Date.now() > pendingAnchor.expiresAtMs) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            return;
        }

        const previousOffsetY = pendingAnchor.metrics.element.scrollTop;
        const restoreResult = restoreWebTranscriptPrependAnchor(pendingAnchor);
        recordWebAnchorRestoreMutationTelemetry({
            didAdjustScroll: restoreResult.didAdjustScroll,
            mode: 'restore-anchor',
            previousOffsetY,
            reason: 'entry-restore',
            metrics: pendingAnchor.metrics,
        });
        const metrics = resolveWebScrollMetrics();
        if (!metrics) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            return;
        }
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            pendingAnchor,
            metrics,
            resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
        );
        pendingWebPrependIndexRecoveryRef.current =
            pendingWebPrependIndexRecoveryRef.current || restoreResult.strategy === 'growth';
        if (pendingWebPrependIndexRecoveryRef.current && pendingWebPrependAnchorRef.current) {
            attemptPendingWebPrependIndexRecovery();
        }
    }, [attemptPendingWebPrependIndexRecovery, listContentHeight, listData.length, listImplementation, props.sessionId, recordWebAnchorRestoreMutationTelemetry, resolvePendingWebPrependRefreshOptions, resolveWebScrollMetrics]);

        const tryPinToBottomDom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open'): boolean => {
            if (reason === 'jump-to-bottom') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'jump-to-bottom',
                    sessionId: props.sessionId,
                }));
            }
            if (reason === 'initial-open') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: true,
                    entrySnapshot: null,
                    jumpToSeq: null,
                    platform: telemetryPlatform,
                    listImplementation: telemetryListImplementation,
                }));
            }
            if (reason === 'jump-to-seq') {
                return executeViewportCommand({
                    kind: 'pin-bottom',
                    sessionId: props.sessionId,
                    reason,
                    mode: 'jump-to-seq',
                });
            }
            return executeViewportCommand(resolveViewportCommand({
                type: 'auto-follow',
                sessionId: props.sessionId,
                distanceFromBottom: Number.MAX_SAFE_INTEGER,
                pinThresholdPx,
                recentUserIntent: false,
                wantsPinned: true,
                reason,
            }));
        }, [
            executeViewportCommand,
            pinThresholdPx,
            props.sessionId,
            resolveViewportCommand,
            telemetryListImplementation,
            telemetryPlatform,
        ]);

    const resolveNearestSurvivingViewportAnchorIndex = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        const anchorMessageId = typeof anchor.messageId === 'string' && anchor.messageId.length > 0
            ? anchor.messageId
            : null;
        if (!anchorMessageId) return null;
        const anchorSeq = resolveSeqForMessageId(anchorMessageId);
        if (typeof anchorSeq !== 'number' || !Number.isFinite(anchorSeq)) return null;

        type AnchorIndexCandidate = { index: number; seq: number };
        let earlier: AnchorIndexCandidate | null = null;
        let later: AnchorIndexCandidate | null = null;
        const resolveItemSeqs = (item: ChatTranscriptListItem): number[] => {
            const seqs: number[] = [];
            const addSeq = (seq: number | null | undefined) => {
                if (typeof seq === 'number' && Number.isFinite(seq)) seqs.push(Math.trunc(seq));
            };
            if (item.kind === 'message') {
                addSeq(item.seq ?? resolveSeqForMessageId(item.messageId));
                return seqs;
            }
            if (item.kind === 'tool-calls-group') {
                for (const toolMessageId of item.toolMessageIds) {
                    addSeq(resolveSeqForMessageId(toolMessageId));
                }
                return seqs;
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId) {
                    addSeq(resolveSeqForMessageId(item.turn.userMessageId));
                }
                for (const content of item.turn.content) {
                    if (content.kind === 'message') {
                        addSeq(resolveSeqForMessageId(content.messageId));
                    } else if (content.kind === 'tool_calls') {
                        for (const toolMessageId of content.toolMessageIds) {
                            addSeq(resolveSeqForMessageId(toolMessageId));
                        }
                    }
                }
            }
            return seqs;
        };

        const items = listDataRef.current;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            for (const normalizedSeq of resolveItemSeqs(item)) {
                if (normalizedSeq < anchorSeq) {
                    if (!earlier || normalizedSeq > earlier.seq) earlier = { index, seq: normalizedSeq };
                    continue;
                }
                if (normalizedSeq > anchorSeq) {
                    if (!later || normalizedSeq < later.seq) later = { index, seq: normalizedSeq };
                }
            }
        }

        return earlier?.index ?? later?.index ?? null;
    }, [resolveSeqForMessageId]);

    const tryRestoreEntryAnchor = React.useCallback((anchor: SessionViewportAnchorSnapshot): EntryAnchorRestoreAttempt => {
        if (Platform.OS === 'web' && listImplementation === 'flash_v2') {
            const metrics = resolveWebScrollMetrics();
            if (metrics) {
                const previousOffsetY = metrics.element.scrollTop;
                const directResult = restoreWebTranscriptViewportAnchor({
                    container: metrics.element,
                    anchor: { ...anchor, messageId: anchor.messageId ?? null },
                });
                recordWebAnchorRestoreMutationTelemetry({
                    didAdjustScroll: directResult.didAdjustScroll,
                    mode: 'restore-anchor',
                    previousOffsetY,
                    reason: 'entry-restore',
                    metrics,
                });
                if (directResult.status === 'restored' || directResult.status === 'already_aligned') {
                    return 'restored';
                }
            }
        }

        const index = resolveTranscriptViewportAnchorIndex({
            anchor,
            items: listDataRef.current,
        }) ?? resolveNearestSurvivingViewportAnchorIndex(anchor);
        if (index == null) return 'missing_anchor';

        const node = listRef.current;
        if (!node || typeof node.scrollToIndex !== 'function') return 'distance_fallback';

            if (Platform.OS === 'web' && listImplementation === 'flash_v2') {
                executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: false,
                    entrySnapshot: {
                        shouldFollowBottom: false,
                        offsetY: 0,
                        anchorIndex: index,
                    },
                    jumpToSeq: null,
                    platform: telemetryPlatform,
                    listImplementation: telemetryListImplementation,
                }));
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return scheduleEntryAnchorRestoreRetry() ? 'pending' : 'distance_fallback';
            const previousOffsetY = metrics.element.scrollTop;
            const result = restoreWebTranscriptViewportAnchor({
                container: metrics.element,
                anchor: { ...anchor, messageId: anchor.messageId ?? null },
            });
            recordWebAnchorRestoreMutationTelemetry({
                didAdjustScroll: result.didAdjustScroll,
                mode: 'restore-anchor',
                previousOffsetY,
                reason: 'entry-restore',
                metrics,
            });
            if (result.status === 'restored' || result.status === 'already_aligned') {
                return 'restored';
            }
            return scheduleEntryAnchorRestoreRetry() ? 'pending' : 'distance_fallback';
        }

            if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
                if (!hasNativeContentMeasurementForCurrentSession()) return 'distance_fallback';
                const restorePlan = planNativeTranscriptViewportAnchorRestore({
                    index,
                    itemOffsetPx: anchor.itemOffsetPx,
                });
                if (
                    restorePlan.status === 'planned' &&
                    executeViewportCommand(resolveViewportCommand({
                        type: 'first-paint',
                        sessionId: props.sessionId,
                        shouldFollowBottom: false,
                        entrySnapshot: {
                            shouldFollowBottom: false,
                            offsetY: 0,
                            anchorIndex: restorePlan.index,
                            anchorViewOffset: restorePlan.viewOffset,
                        },
                        jumpToSeq: null,
                        platform: telemetryPlatform,
                        listImplementation: telemetryListImplementation,
	                    }))
	                ) {
	                    return 'restored';
	                }
            return 'distance_fallback';
        }

        return 'distance_fallback';
    }, [
        hasNativeContentMeasurementForCurrentSession,
            executeViewportCommand,
            listImplementation,
            markNativeInitialViewportAppliedForCurrentSession,
            recordViewportTelemetryEvent,
            recordWebAnchorRestoreMutationTelemetry,
            resolveNearestSurvivingViewportAnchorIndex,
            resolveViewportCommand,
            resolveWebScrollMetrics,
            scheduleEntryAnchorRestoreRetry,
            telemetryListImplementation,
            telemetryPlatform,
        ]);

    const requestBoundedAnchorLookup = React.useCallback((): boolean => {
        if (anchorLookupInFlightRef.current) return true;
        const maxLoads = sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
        if (anchorLookupLoadCountRef.current >= maxLoads) return false;
        const loadOlderForAnchorLookup = loadOlderForAnchorLookupRef.current;
        if (!loadOlderForAnchorLookup) return false;

        anchorLookupInFlightRef.current = true;
        anchorLookupLoadCountRef.current += 1;
        fireAndForget((async () => {
            try {
                await loadOlderForAnchorLookup({ showLoadingIndicator: false });
                await Promise.resolve();
                await Promise.resolve();
                tryRestoreEntryViewportRef.current?.({ force: true });
            } finally {
                anchorLookupInFlightRef.current = false;
            }
        })(), { tag: 'ChatList.restoreEntryAnchorLookup' });
        return true;
    }, []);

    const tryRestoreEntryViewport = React.useCallback((options: { force?: boolean; retryPending?: boolean } = {}): boolean => {
        const entryViewport = sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.shouldFollowBottom !== false) return false;
        if (wantsPinnedRef.current) {
            recordRestoreDecisionTelemetry('skipped', { mode: 'restore-distance' });
            return false;
        }
        if (props.jumpToSeq != null) {
            recordRestoreDecisionTelemetry('skipped', { mode: 'restore-distance' });
            return false;
        }

        const offsetY = Number.isFinite(entryViewport.offsetY)
            ? Math.max(0, Math.trunc(entryViewport.offsetY))
            : 0;
        const nativeDistanceRestoreContentHeightForAppliedSkip =
            Platform.OS !== 'web' && listImplementation === 'flash_v2'
                ? Math.max(0, Math.trunc(listContentHeightRef.current - composerInsetHeightRef.current))
                : null;
        const applied = entryViewportRestoreAppliedRef.current;
        const appliedContentHeightStillCurrent =
            applied?.contentHeight == null ||
            nativeDistanceRestoreContentHeightForAppliedSkip == null ||
            Math.abs(nativeDistanceRestoreContentHeightForAppliedSkip - applied.contentHeight) <= Math.max(pinThresholdPx, 2);
        if (
            applied?.sessionId === entryViewport.sessionId &&
            applied.offsetY === offsetY &&
            appliedContentHeightStillCurrent
        ) {
            recordRestoreDecisionTelemetry('skipped', { mode: 'restore-distance', offsetY });
            return false;
        }
        if (lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY) {
            recordRestoreDecisionTelemetry('skipped', { mode: 'restore-distance', offsetY });
            return false;
        }

        if (entryViewport.anchor) {
            const anchorRestore = tryRestoreEntryAnchor(entryViewport.anchor);
            if (anchorRestore === 'restored') {
                if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
                    pendingNativeEntryViewportRestoreRef.current = {
                        issuedAtMs: Date.now(),
                        kind: 'anchor',
                        sessionId: entryViewport.sessionId,
                        offsetY,
                    };
                    recordRestoreDecisionTelemetry('pending', { mode: 'restore-anchor', offsetY });
                    return true;
                }
                entryViewportRestoreAppliedRef.current = { sessionId: entryViewport.sessionId, offsetY };
                recordRestoreDecisionTelemetry('restored', { mode: 'restore-anchor', offsetY });
                return true;
            }
            if (anchorRestore === 'pending') {
                recordRestoreDecisionTelemetry('pending', { mode: 'restore-anchor', offsetY });
                return true;
            }
            if (anchorRestore === 'missing_anchor' && requestBoundedAnchorLookup()) {
                recordRestoreDecisionTelemetry('missing-anchor', { mode: 'restore-anchor', offsetY });
                return true;
            }
        }

        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) {
                recordRestoreDecisionTelemetry('not-ready', { mode: 'restore-distance', offsetY });
                return false;
            }
            const maxScrollTop = resolveWebTranscriptMaxScrollTop(metrics);
            if (options.force !== true && maxScrollTop < offsetY) {
                recordRestoreDecisionTelemetry('not-ready', {
                    mode: 'restore-distance',
                    offsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                });
                return false;
            }
                if (!executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: false,
                    entrySnapshot: {
                        shouldFollowBottom: false,
                        offsetY,
                    },
                    jumpToSeq: null,
                    platform: telemetryPlatform,
                    listImplementation: telemetryListImplementation,
                }))) {
                    return false;
                }
            entryViewportRestoreAppliedRef.current = { sessionId: entryViewport.sessionId, offsetY };
            recordRestoreDecisionTelemetry('restored', {
                mode: 'restore-distance',
                offsetY,
                layoutHeight: metrics.clientHeight,
                contentHeight: metrics.scrollHeight,
            });
            return true;
        }

        if (!hasNativeContentMeasurementForCurrentSession()) {
            recordRestoreDecisionTelemetry('not-ready', { mode: 'restore-distance', offsetY });
            return false;
        }
        const layoutHeight = listLayoutHeightRef.current;
        const measuredContentHeight = listContentHeightRef.current;
        const contentHeight = listImplementation === 'flash_v2'
            ? Math.max(0, Math.trunc(measuredContentHeight - composerInsetHeightRef.current))
            : measuredContentHeight;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) {
            recordRestoreDecisionTelemetry('not-ready', { mode: 'restore-distance', offsetY });
            return false;
        }
        if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
            recordRestoreDecisionTelemetry('not-ready', { mode: 'restore-distance', offsetY, layoutHeight });
            return false;
        }

        const maxOffset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
        if (options.force !== true && maxOffset < offsetY) {
            recordRestoreDecisionTelemetry('not-ready', {
                mode: 'restore-distance',
                offsetY,
                layoutHeight,
                contentHeight,
            });
            return false;
        }

        const targetOffsetY = listImplementation === 'flatlist_legacy'
            ? Math.min(maxOffset, offsetY)
            : Math.max(0, maxOffset - offsetY);
        const pendingNativeEntryViewportRestore = pendingNativeEntryViewportRestoreRef.current;
        if (
            pendingNativeEntryViewportRestore?.sessionId === entryViewport.sessionId &&
            pendingNativeEntryViewportRestore.offsetY === offsetY &&
            options.retryPending !== true
        ) {
            recordRestoreDecisionTelemetry('pending', {
                mode: 'restore-distance',
                offsetY,
                layoutHeight,
                contentHeight,
            });
            if (
                pendingNativeEntryViewportRestore.kind === 'distance' &&
                pendingNativeEntryViewportRestore.targetOffsetY !== targetOffsetY
            ) {
                scheduleNativeEntryViewportRestoreRetry(offsetY);
            }
            return true;
        }

            const restoreCommand = resolveViewportCommand({
                type: 'first-paint',
                sessionId: props.sessionId,
                shouldFollowBottom: false,
                entrySnapshot: {
                    shouldFollowBottom: false,
                    offsetY,
                },
                jumpToSeq: null,
                platform: telemetryPlatform,
                listImplementation: telemetryListImplementation,
            });
            const restoreCommandWithContentHeight = restoreCommand.kind === 'restore-offset'
                ? { ...restoreCommand, contentHeight }
                : restoreCommand;
                if (!executeViewportCommand(restoreCommandWithContentHeight)) {
                    recordRestoreDecisionTelemetry('not-ready', {
                    mode: 'restore-distance',
                    offsetY,
                    layoutHeight,
                    contentHeight,
                });
                return false;
            }
            pendingNativeEntryViewportRestoreRef.current = {
                contentHeight,
                issuedAtMs: Date.now(),
                kind: 'distance',
                layoutHeight,
                offsetY,
                sessionId: entryViewport.sessionId,
                targetOffsetY,
                targetOffsetYWasClamped: maxOffset < offsetY,
            };
            recordRestoreDecisionTelemetry('pending', {
                mode: 'restore-distance',
                offsetY,
                layoutHeight,
                contentHeight,
            });
            return true;
    }, [
        hasNativeContentMeasurementForCurrentSession,
        executeViewportCommand,
        listImplementation,
        markNativeInitialViewportAppliedForCurrentSession,
            pinThresholdPx,
            props.jumpToSeq,
            props.sessionId,
            recordRestoreDecisionTelemetry,
            requestBoundedAnchorLookup,
            resolveViewportCommand,
            resolveWebScrollMetrics,
            scheduleNativeEntryViewportRestoreRetry,
            telemetryListImplementation,
            telemetryPlatform,
            tryRestoreEntryAnchor,
        ]);

    React.useEffect(() => {
        tryRestoreEntryViewportRef.current = tryRestoreEntryViewport;
    }, [tryRestoreEntryViewport]);

    React.useLayoutEffect(() => {
        tryRestoreEntryViewport();
    }, [listContentHeight, listData.length, listImplementation, listLayoutHeight, props.sessionId, tryRestoreEntryViewport]);

    const captureWebBottomFollowPreviousMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        return {
            ...metrics,
            clientHeight: listLayoutHeightRef.current > 0 ? listLayoutHeightRef.current : metrics.clientHeight,
            scrollHeight: listContentHeightRef.current > 0 ? listContentHeightRef.current : metrics.scrollHeight,
        };
    }, [listImplementation, resolveWebScrollMetrics]);

    const applyWebBottomFollowAdjustment = React.useCallback((
        previousMetrics: WebTranscriptScrollMetrics,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
    ): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        const nextMetrics = resolveWebScrollMetrics();
        if (!nextMetrics) return false;
        const targetScrollTop = resolveWebBottomFollowAdjustment({
            mode: wantsPinnedRef.current ? 'following' : 'released',
            previousMetrics,
            nextMetrics,
            tolerancePx: pinThresholdPx,
            recentUserIntent: Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
        });
        if (targetScrollTop === null) return false;
            return executeViewportCommand(resolveViewportCommand({
                type: 'auto-follow',
                sessionId: props.sessionId,
                distanceFromBottom: Number.MAX_SAFE_INTEGER,
                pinThresholdPx,
                recentUserIntent: false,
                wantsPinned: wantsPinnedRef.current,
                reason,
                targetOffsetY: targetScrollTop,
            }));
        }, [
            executeViewportCommand,
            listImplementation,
            pinThresholdPx,
            props.sessionId,
            resolveViewportCommand,
            resolveWebScrollMetrics,
        ]);

    const pinNativeFlashListToBottomIfMeasured = React.useCallback((options?: {
        force?: boolean;
        markInitialViewportApplied?: 'always' | 'when-scrollable';
        telemetryReason?: TranscriptViewportTelemetryScrollReason;
    }): boolean => {
        if (!usesNativeFlashListBottomMaintenance) return false;
        if (props.jumpToSeq != null) return false;
        if (!wantsPinnedRef.current) return false;
        if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
        const telemetryReason = options?.telemetryReason ?? 'content-size-change';
        const isExplicitNativeCommand =
            telemetryReason === 'jump-to-bottom' ||
            telemetryReason === 'jump-to-seq';
        const shouldUseNativeMvcpOnlySkip =
            transcriptNativeMvcpOnlyMode &&
            !isExplicitNativeCommand &&
            telemetryReason !== 'mount-settle';
        if (
            !shouldUseNativeMvcpOnlySkip &&
            !isExplicitNativeCommand &&
            !(options?.force === true && telemetryReason === 'mount-settle') &&
            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
            !nativeMountSettleDeadlineReachedRef.current
        ) {
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }

        const layoutHeight = listLayoutHeightRef.current;
        const contentHeight = listContentHeightRef.current;
        if (!hasNativeContentMeasurementForCurrentSession()) return false;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return false;
        if (!Number.isFinite(contentHeight) || contentHeight <= 0) return false;

        const offset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
        const shouldDeferInitialViewportAppliedUntilObserved =
            options?.markInitialViewportApplied === 'when-scrollable';
        const shouldMarkInitialViewportApplied =
            !shouldDeferInitialViewportAppliedUntilObserved;
        const shouldRetryUnobservedNativeBottomPin =
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            !hasNativeInitialViewportAppliedForCurrentSession() &&
            nativeMountSettleStable;
        const shouldSkipUnstableAutomaticRetryUntilObserved =
            !shouldUseNativeMvcpOnlySkip &&
            !isExplicitNativeCommand &&
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            telemetryReason === 'initial-open';
        const shouldSkipLateInitialOpenAfterAutomaticNativePin =
            !shouldUseNativeMvcpOnlySkip &&
            !isExplicitNativeCommand &&
            telemetryReason === 'initial-open' &&
            nativeAutomaticBottomPinCommandSessionRef.current === props.sessionId;
        const shouldSkipDefaultNativeMaterializationPin =
            !shouldUseNativeMvcpOnlySkip &&
            !isExplicitNativeCommand &&
            (
                telemetryReason === 'initial-open' ||
                telemetryReason === 'layout-change' ||
                telemetryReason === 'content-size-change' ||
                telemetryReason === 'passive-drift'
            );
        const shouldSkipDuplicateAutomaticRetryUntilObserved =
            !shouldUseNativeMvcpOnlySkip &&
            !isExplicitNativeCommand &&
            !(options?.force === true && telemetryReason === 'mount-settle') &&
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            lastNativePinOffsetRef.current != null &&
            (
                lastNativePinOffsetRef.current === offset ||
                telemetryReason === 'initial-open'
            );
        if (
            shouldSkipDefaultNativeMaterializationPin ||
            shouldSkipUnstableAutomaticRetryUntilObserved ||
            shouldSkipLateInitialOpenAfterAutomaticNativePin ||
            shouldSkipDuplicateAutomaticRetryUntilObserved
        ) {
            if (
                telemetryReason !== 'passive-drift' &&
                !hasNativeInitialViewportAppliedForCurrentSession()
            ) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return true;
        }
        if (
            options?.force !== true &&
            lastNativePinOffsetRef.current === offset &&
            !shouldRetryUnobservedNativeBottomPin
        ) {
            if (shouldMarkInitialViewportApplied) {
                markNativeInitialViewportAppliedForCurrentSession();
            }
            if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return true;
        }
        if (
            options?.force === true &&
            telemetryReason === 'mount-settle' &&
            pendingNativeMountSettleBottomPinRef.current &&
            !hasNativeInitialViewportAppliedForCurrentSession() &&
            lastNativePinOffsetRef.current === offset
        ) {
            if (
                nativeMountSettleSameOffsetWakeRetryCountRef.current >=
                TRANSCRIPT_NATIVE_MOUNT_SETTLE_SAME_OFFSET_WAKE_RETRY_LIMIT
            ) {
                if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
                    updateNativeInitialViewportPendingObservation(true);
                }
                return true;
            }
        }

        const previousNativePinOffset = lastNativePinOffsetRef.current;
        if (!executeViewportCommand(resolveViewportCommand({
            type: 'auto-follow',
            sessionId: props.sessionId,
            distanceFromBottom: Number.MAX_SAFE_INTEGER,
            pinThresholdPx,
            recentUserIntent: false,
            wantsPinned: wantsPinnedRef.current,
            reason: telemetryReason,
            targetOffsetY: offset,
            skipNativeJsPin: shouldUseNativeMvcpOnlySkip,
        }))) {
            return false;
        }
        if (!shouldUseNativeMvcpOnlySkip) {
            lastNativePinOffsetRef.current = offset;
        }
        if (!shouldUseNativeMvcpOnlySkip && telemetryReason === 'mount-settle') {
            nativeMountSettleSameOffsetWakeRetryCountRef.current =
                previousNativePinOffset === offset
                    ? nativeMountSettleSameOffsetWakeRetryCountRef.current + 1
                    : 0;
        }
        if (!isExplicitNativeCommand && !shouldUseNativeMvcpOnlySkip) {
            nativeAutomaticBottomPinCommandSessionRef.current = props.sessionId;
        }
        if (shouldMarkInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
            pendingNativeMountSettleBottomPinRef.current = true;
            updateNativeInitialViewportPendingObservation(true);
        }
        return true;
    }, [
        executeViewportCommand,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        markNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleStable,
        props.jumpToSeq,
        props.sessionId,
        pinThresholdPx,
        resolveViewportCommand,
        transcriptNativeMvcpOnlyMode,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
    ]);

    const pinNativeInitialFollowBottomViewportIfReady = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
    ): boolean => {
        if (!usesNativeFlashListBottomMaintenance) return false;
        if (props.jumpToSeq != null) return false;
        if (!wantsPinnedRef.current) return false;
        if (hasNativeInitialViewportAppliedForCurrentSession()) return false;
        if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
        if (
            reason === 'initial-open' &&
            !transcriptNativeMvcpOnlyMode &&
            (
                pendingNativeMountSettleBottomPinRef.current ||
                lastNativePinOffsetRef.current != null
            )
        ) {
            return true;
        }
        return pinNativeFlashListToBottomIfMeasured({
            force: true,
            markInitialViewportApplied: 'when-scrollable',
            telemetryReason: reason,
        });
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        props.jumpToSeq,
        transcriptNativeMvcpOnlyMode,
        usesNativeFlashListBottomMaintenance,
    ]);

    const shouldKeepPendingNativeMountSettleBottomPin = React.useCallback((): boolean => {
        if (!usesNativeFlashListBottomMaintenance) return false;
        if (props.jumpToSeq != null) return false;
        if (!wantsPinnedRef.current) return false;
        return Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS;
    }, [props.jumpToSeq, usesNativeFlashListBottomMaintenance]);

    const pinToBottom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open') => {
        if (Platform.OS === 'web') {
            // Prefer DOM scroll writes on web: RNW list refs can apply delayed `scrollToOffset` that
            // fights against our pinning and results in visible drift/jitter.
            if (tryPinToBottomDom(reason)) {
                return;
            }
            // If we cannot reliably locate a DOM scroll container yet, avoid falling back to the
            // list ref scroll APIs on web. Early `scrollToOffset({ offset: 0 })` calls can create
            // visible "scroll to top" jitter during mount while the real scroll container is still
            // being attached/measured.
            return;
        }
        if (usesNativeFlashListBottomMaintenance) {
            const isExplicitNativeCommand = reason === 'jump-to-bottom' || reason === 'jump-to-seq';
            if (isExplicitNativeCommand) {
                pendingNativeMountSettleBottomPinRef.current = false;
            }
            pinNativeFlashListToBottomIfMeasured({
                force: isExplicitNativeCommand,
                telemetryReason: reason,
            });
            return;
        }
        executeViewportCommand(reason === 'jump-to-bottom'
            ? resolveViewportCommand({
                type: 'jump-to-bottom',
                sessionId: props.sessionId,
            })
            : {
                kind: 'pin-bottom',
                sessionId: props.sessionId,
                reason,
                mode: reason === 'jump-to-seq' ? 'jump-to-seq' : 'follow-bottom',
                animated: false,
            });
    }, [
        executeViewportCommand,
        listImplementation,
        pinNativeFlashListToBottomIfMeasured,
        props.sessionId,
        resolveViewportCommand,
        resolveViewportTelemetryMode,
        tryPinToBottomDom,
        usesNativeFlashListBottomMaintenance,
    ]);

    const pinToBottomRespectingNativeMountSettle = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'mount-settle') => {
        if (usesNativeFlashListBottomMaintenance) {
            if (pinNativeInitialFollowBottomViewportIfReady(reason)) {
                return;
            }
            if (reason === 'initial-open') {
                return;
            }
            if (pinNativeFlashListToBottomIfMeasured({ telemetryReason: reason })) {
                if (hasNativeInitialViewportAppliedForCurrentSession()) {
                    pendingNativeMountSettleBottomPinRef.current = false;
                }
                return;
            }
            if (shouldKeepPendingNativeMountSettleBottomPin()) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return;
        }
        pinToBottom(reason);
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeInitialFollowBottomViewportIfReady,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        shouldKeepPendingNativeMountSettleBottomPin,
        usesNativeFlashListBottomMaintenance,
    ]);

    const flushPendingNativeMountSettleBottomPin = React.useCallback(() => {
        if (!pendingNativeMountSettleBottomPinRef.current && !nativeMountSettleDeadlineReachedRef.current) return;
        if (!shouldKeepPendingNativeMountSettleBottomPin()) {
            pendingNativeMountSettleBottomPinRef.current = false;
            return;
        }
        if (
            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
            !nativeMountSettleDeadlineReachedRef.current
        ) return;
        if (pinNativeFlashListToBottomIfMeasured({
            markInitialViewportApplied: 'when-scrollable',
            telemetryReason: 'mount-settle',
        })) {
            if (!hasNativeInitialViewportAppliedForCurrentSession()) {
                if (
                    transcriptNativeMvcpOnlyMode &&
                    pendingNativeMountSettleBottomPinRef.current
                ) {
                    const nowMs = Date.now();
                    scheduleNativeMountSettleRetryAfterThrottleRef.current(nowMs, {
                        delayMs: TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS + 1,
                    });
                }
                return;
            }
            pendingNativeMountSettleBottomPinRef.current = false;
        }
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        shouldKeepPendingNativeMountSettleBottomPin,
        transcriptNativeMvcpOnlyMode,
    ]);
    flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPin;

    React.useEffect(() => {
        if (!nativeMountSettleStable) return;
        flushPendingNativeMountSettleBottomPin();
    }, [flushPendingNativeMountSettleBottomPin, nativeMountSettleStable]);

    React.useEffect(() => {
        if (!nativeMountSettleDeadlineReached) return;
        if (nativeMountSettleAutoPinSuppressedRef.current) return;
        pendingNativeMountSettleBottomPinRef.current = true;
        flushPendingNativeMountSettleBottomPin();
    }, [flushPendingNativeMountSettleBottomPin, nativeMountSettleDeadlineReached]);

    const deferPinToBottomAfterScroll = React.useCallback((reason: TranscriptViewportTelemetryScrollReason) => {
        const mountSettleRetryGeneration =
            reason === 'mount-settle'
                ? nativeMountSettleRetryGenerationRef.current
                : null;
        fireAndForget(Promise.resolve().then(() => {
            if (usesNativeFlashListBottomMaintenance) {
                if (
                    reason === 'mount-settle' &&
                    mountSettleRetryGeneration !== nativeMountSettleRetryGenerationRef.current
                ) {
                    return;
                }
                if (reason === 'mount-settle') {
                    if (!transcriptNativeMvcpOnlyMode) {
                        lastNativePinOffsetRef.current = null;
                    }
                }
                pinNativeFlashListToBottomIfMeasured({
                    force: true,
                    markInitialViewportApplied: pendingNativeMountSettleBottomPinRef.current || !hasNativeInitialViewportAppliedForCurrentSession()
                        ? 'when-scrollable'
                        : undefined,
                    telemetryReason: reason,
                });
                return;
            }
            pinToBottom(reason);
        }), { tag: 'ChatList.deferPinToBottomAfterScroll' });
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        transcriptNativeMvcpOnlyMode,
        usesNativeFlashListBottomMaintenance,
    ]);

    const scheduleNativeMountSettleRetryAfterThrottle = React.useCallback((
        nowMs: number,
        options?: Readonly<{ delayMs?: number }>,
    ) => {
        if (scheduledNativeMountSettleRetryRef.current?.sessionId === props.sessionId) return;
        cancelScheduledNativeMountSettleRetry();
        const elapsedSinceLastRepinMs = nowMs - lastAutoRepinAtMsRef.current;
        const delayMs = options?.delayMs ?? Math.max(0, TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS - elapsedSinceLastRepinMs + 1);
        const handle = {
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
            sessionId: props.sessionId,
        };
        handle.timeoutId = setTimeout(() => {
            if (scheduledNativeMountSettleRetryRef.current !== handle) return;
            scheduledNativeMountSettleRetryRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (!wantsPinnedRef.current) return;
            if (latestJumpToSeqRef.current != null) return;
            if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return;
            pendingNativeMountSettleBottomPinRef.current = true;
            lastAutoRepinAtMsRef.current = Date.now();
            deferPinToBottomAfterScroll('mount-settle');
        }, delayMs);
        scheduledNativeMountSettleRetryRef.current = handle;
    }, [
        cancelScheduledNativeMountSettleRetry,
        deferPinToBottomAfterScroll,
        props.sessionId,
    ]);
    scheduleNativeMountSettleRetryAfterThrottleRef.current = scheduleNativeMountSettleRetryAfterThrottle;

    const schedulePendingNativeBottomFollowRetryForContentGrowth = React.useCallback((contentHeight: number, nowMs: number) => {
        if (Platform.OS === 'web') return;
        if (!usesNativeFlashListBottomMaintenance) return;
        if (!pendingNativeMountSettleBottomPinRef.current) return;
        if (!shouldKeepPendingNativeMountSettleBottomPin()) return;
        if (latestJumpToSeqRef.current != null) return;
        const previousTargetOffsetY = lastNativePinOffsetRef.current;
        if (previousTargetOffsetY == null) return;
        const layoutHeight = listLayoutHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return;
        if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
        const nextTargetOffsetY = Math.max(0, Math.trunc(contentHeight - layoutHeight));
        if (nextTargetOffsetY <= previousTargetOffsetY + pinThresholdPx) return;
        nativeBottomFollowTargetConfirmationRef.current = null;
        nativeBottomFollowStaleObservationCandidateRef.current = null;
        lastAutoRepinAtMsRef.current = nowMs;
        scheduleNativeMountSettleRetryAfterThrottle(nowMs);
    }, [
        pinThresholdPx,
        scheduleNativeMountSettleRetryAfterThrottle,
        shouldKeepPendingNativeMountSettleBottomPin,
        usesNativeFlashListBottomMaintenance,
    ]);

    const jumpToBottom = React.useCallback(() => {
        if (Platform.OS === 'web') {
            if (tryPinToBottomDom('jump-to-bottom')) {
                viewportAnchorCaptureGenerationRef.current += 1;
                cancelScheduledViewportAnchorCapture();
                cancelScheduledEntryAnchorRestoreRetry();
                isPinnedRef.current = true;
                wantsPinnedRef.current = true;
                setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
                emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
                return;
            }
        }
        const command = resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId: props.sessionId,
        });
        if (!executeViewportCommand(withTranscriptViewportCommandAnimation(command, jumpAnimateScroll))) {
            pinToBottom('jump-to-bottom');
        }
        isPinnedRef.current = true;
        wantsPinnedRef.current = true;
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        cancelScheduledEntryAnchorRestoreRetry();
        setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        if (Platform.OS === 'web') {
            tryPinToBottomDom('jump-to-bottom');
        }
    }, [
        cancelScheduledEntryAnchorRestoreRetry,
        cancelScheduledViewportAnchorCapture,
            emitViewportChange,
            executeViewportCommand,
            jumpAnimateScroll,
            pinToBottom,
            props.sessionId,
            resolveViewportCommand,
            tryPinToBottomDom,
        ]);

    React.useLayoutEffect(() => {
        const followBottomIntentKey = props.followBottomIntentKey ?? null;
        if (followBottomIntentKey == null) return;
        if (lastFollowBottomIntentKeyRef.current === followBottomIntentKey) return;

        lastFollowBottomIntentKeyRef.current = followBottomIntentKey;
        wantsPinnedRef.current = true;
        isPinnedRef.current = true;
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        cancelScheduledEntryAnchorRestoreRetry();
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = 0;
        setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        pinToBottom('jump-to-bottom');
    }, [cancelScheduledEntryAnchorRestoreRetry, cancelScheduledViewportAnchorCapture, emitViewportChange, pinToBottom, props.followBottomIntentKey]);

    const resolveAutoPinWaitMs = React.useCallback((): number | null => {
        if (!pinEnabled || !autoFollowWhenPinned) return null;
        if (props.jumpToSeq != null) return null;
        if (!wantsPinnedRef.current) return null;
        const elapsedSinceUserIntentMs = Date.now() - lastUserScrollIntentAtMsRef.current;
        if (elapsedSinceUserIntentMs >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return 0;
        return Math.max(0, TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS - elapsedSinceUserIntentMs);
    }, [autoFollowWhenPinned, pinEnabled, props.jumpToSeq]);

    const schedulePinToBottom = React.useCallback((
        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
    ) => {
        if (listImplementation !== 'flash_v2') return;
        const waitMs = resolveAutoPinWaitMs();
        if (waitMs === null) return;
        if (scheduledPinRef.current) return;

        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (waitMs === 0 && typeof raf === 'function') {
            const handle: { kind: 'raf'; id: any; previousWebMetrics: WebTranscriptScrollMetrics | null } = { kind: 'raf', id: 0, previousWebMetrics };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                if (scheduledPinRef.current !== handle) return;
                scheduledPinRef.current = null;
                if (resolveAutoPinWaitMs() !== 0) return;
                if (handle.previousWebMetrics && applyWebBottomFollowAdjustment(handle.previousWebMetrics, reason)) return;
                if (usesNativeFlashListBottomMaintenance) {
                    pinToBottomRespectingNativeMountSettle(reason);
                    return;
                }
                pinToBottom(reason);
            });
            return;
        }

        const handle: { kind: 'timeout'; id: any; previousWebMetrics: WebTranscriptScrollMetrics | null } = { kind: 'timeout', id: null, previousWebMetrics };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            if (scheduledPinRef.current !== handle) return;
            scheduledPinRef.current = null;
            if (resolveAutoPinWaitMs() !== 0) return;
            if (handle.previousWebMetrics && applyWebBottomFollowAdjustment(handle.previousWebMetrics, reason)) return;
            if (usesNativeFlashListBottomMaintenance) {
                pinToBottomRespectingNativeMountSettle(reason);
                return;
            }
            pinToBottom(reason);
        }, waitMs);
    }, [
        applyWebBottomFollowAdjustment,
        listImplementation,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        resolveAutoPinWaitMs,
        usesNativeFlashListBottomMaintenance,
    ]);

    const handleComposerInsetHeightChange = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        const previousHeight = composerInsetHeightRef.current;
        if (previousHeight === nextHeight) return;
        composerInsetHeightRef.current = nextHeight;
        observeMountSettleMetrics();

        if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
            const delta = nextHeight - previousHeight;
            if (delta !== 0 && listContentHeightRef.current > 0) {
                const nextContentHeight = Math.max(0, listContentHeightRef.current + delta);
                listContentHeightRef.current = nextContentHeight;
                if (shouldCommitContentHeightState()) {
                    setListContentHeight(nextContentHeight);
                }
            }
        }

        schedulePinToBottom(null, 'layout-change');
    }, [listImplementation, observeMountSettleMetrics, schedulePinToBottom, shouldCommitContentHeightState]);

    const resolveMeasuredContentHeight = React.useCallback((height: number): number => {
        const normalizedHeight = Math.max(0, Math.trunc(height));
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') {
            return normalizedHeight;
        }
        return normalizedHeight + composerInsetHeightRef.current;
    }, [listImplementation]);

    const listFooterNode = React.useMemo(() => (
        <ChatListFooterWithKeyboardInset
            sessionId={props.sessionId}
            bottomNotice={props.bottomNotice}
            controlledByUserOverride={props.controlledByUserOverride}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            directControl={props.directControlFooter}
            onComposerInsetHeightChange={handleComposerInsetHeightChange}
        />
    ), [
        handleComposerInsetHeightChange,
        props.bottomNotice,
        props.controlSwitchTo,
        props.controlledByUserOverride,
        props.directControlFooter,
        props.onRequestSwitchToRemote,
        props.sessionId,
    ]);
    const flashListFooterNode = React.useMemo(() => {
        if (!shouldUseWebHotColdSplit) {
            return listFooterNode;
        }
        return (
            <WebTranscriptSplitFooter
                hotItems={transcriptHotColdSegments.hotItems}
                startIndex={transcriptHotColdSegments.coldItems.length}
                renderItemAtIndex={renderTranscriptItemAtIndex}
                footer={listFooterNode}
            />
        );
    }, [
        listFooterNode,
        renderTranscriptItemAtIndex,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems,
    ]);

    React.useEffect(() => {
        return () => {
            const scheduled = scheduledPinRef.current;
            if (!scheduled) return;
            scheduledPinRef.current = null;
            if (scheduled.kind === 'raf') {
                const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
                if (typeof caf === 'function') {
                    caf(scheduled.id);
                }
            } else {
                clearTimeout(scheduled.id);
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        // When pinned, proactively keep the list at the visual bottom as new activity arrives.
        // This complements `maintainVisibleContentPosition`, especially on platforms where
        // inverted list anchoring can be inconsistent.
        const latestActivityKey = props.latestCommittedActivityKey;
        const hasNewCommittedActivity =
            latestActivityKey != null &&
            lastProactiveAutoFollowActivityKeyRef.current !== latestActivityKey;
        if (latestActivityKey == null) {
            lastProactiveAutoFollowActivityKeyRef.current = null;
        }
        if (hasNewCommittedActivity) {
            lastProactiveAutoFollowActivityKeyRef.current = latestActivityKey;
            if (pinEnabled && autoFollowWhenPinned && isPinnedRef.current && props.jumpToSeq == null) {
                pinToBottomRespectingNativeMountSettle('stream-append');
            }
        }
        setScrollPin((prev) =>
            reduceTranscriptScrollPinState({ ...prev, isPinned: isPinnedRef.current }, {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: props.latestCommittedActivityKey,
            })
        );
    }, [autoFollowWhenPinned, pinEnabled, pinToBottomRespectingNativeMountSettle, props.jumpToSeq, props.latestCommittedActivityKey]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialPinSessionIdRef.current === props.sessionId) return;
        if (sessionEntryViewportRef.current?.shouldFollowBottom === false) {
            initialPinSessionIdRef.current = props.sessionId;
            initialWebPinStabilizingRef.current = false;
            return;
        }

        // Some platforms (especially web) can apply scroll anchoring / restoration
        // during the first render+layout ticks, resulting in the transcript appearing "scrolled up"
        // after a refresh. Pin immediately and then re-pin after a couple microtasks / a frame to
        // ensure the visual bottom stays stable.
        initialPinSessionIdRef.current = props.sessionId;
        let cancelled = false;
        let lastPinnedWebScrollHeight: number | null = null;

        const pinInitialWebToBottomIfNeeded = (): boolean => {
            const metrics = resolveWebScrollMetrics();
            if (
                metrics &&
                getWebTranscriptDistanceFromBottom(metrics) === 0 &&
                lastPinnedWebScrollHeight === metrics.scrollHeight
            ) {
                return true;
            }

                pinToBottom('initial-open');
            const nextMetrics = resolveWebScrollMetrics();
            if (!nextMetrics || getWebTranscriptDistanceFromBottom(nextMetrics) !== 0) {
                return false;
            }
            lastPinnedWebScrollHeight = nextMetrics.scrollHeight;
            return true;
        };

        const attempt = (): boolean => {
            if (cancelled) return true;
            // If the user is actively scrolling (or scroll inertia is still firing wheel events),
            // avoid fighting their intent with initial pin retries.
            if (Platform.OS === 'web') {
                if (wantsPinnedRef.current === false) {
                    initialWebPinStabilizingRef.current = false;
                    return true;
                }
                if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
                pinInitialWebToBottomIfNeeded();
                return false;
            }
            pinToBottomRespectingNativeMountSettle('initial-open');
            return false;
        };

        if (Platform.OS === 'web') {
            const tuning = sync.getSyncTuning();
            const stabilizeMaxMsRaw = tuning.transcriptWebInitialPinStabilizeMs;
            const retryIntervalMsRaw = tuning.transcriptWebInitialPinRetryIntervalMs;
            const stabilizeMaxMs =
                typeof stabilizeMaxMsRaw === 'number' && Number.isFinite(stabilizeMaxMsRaw)
                    ? Math.max(0, Math.trunc(stabilizeMaxMsRaw))
                    : TRANSCRIPT_WEB_INITIAL_PIN_STABILIZE_FALLBACK_MS;
            const retryIntervalMs =
                typeof retryIntervalMsRaw === 'number' && Number.isFinite(retryIntervalMsRaw)
                    ? Math.max(16, Math.trunc(retryIntervalMsRaw))
                    : TRANSCRIPT_WEB_INITIAL_PIN_RETRY_INTERVAL_FALLBACK_MS;

            const startedAtMs = Date.now();

            if (stabilizeMaxMs <= 0 || attempt()) {
                if (stabilizeMaxMs <= 0) {
                    attempt();
                }
                return () => {
                    cancelled = true;
                    initialWebPinStabilizingRef.current = false;
                };
            }

            const delays = resolveInitialWebPinRetryDelays({
                milestonesMs: tuning.transcriptWebInitialPinRetryMilestonesMs,
                stabilizeMaxMs,
                retryIntervalMs,
            });

            if (delays.length === 0) {
                initialWebPinStabilizingRef.current = false;
                return () => {
                    cancelled = true;
                };
            }

            initialWebPinStabilizingRef.current = true;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            let delayIndex = 0;

            const scheduleNext = () => {
                if (cancelled) return;
                if (delayIndex >= delays.length) {
                    initialWebPinStabilizingRef.current = false;
                    return;
                }
                const delayMs = delays[delayIndex];
                delayIndex += 1;
                const timeoutMs = resolveWebPinRetryTimeoutMs({
                    startedAtMs,
                    nowMs: Date.now(),
                    milestoneMs: delayMs,
                });
                timeoutId = setTimeout(() => {
                    timeoutId = null;
                    if (attempt()) return;
                    scheduleNext();
                }, timeoutMs);
            };

            scheduleNext();
            return () => {
                cancelled = true;
                initialWebPinStabilizingRef.current = false;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };
        }

        // Pin immediately and then re-pin during the first few ticks on native. This is defensive
        // against layout settling after the initial paint.
        attempt();
        void Promise.resolve().then(() => {
            void attempt();
        });
        void Promise.resolve().then(() => Promise.resolve()).then(() => {
            void attempt();
        });
        return () => { cancelled = true; };
    }, [pinNativeFlashListToBottomIfMeasured, pinToBottom, pinToBottomRespectingNativeMountSettle, props.isLoaded, props.jumpToSeq, props.sessionId, resolveWebScrollMetrics]);

    const isScrollable = React.useCallback((): boolean => {
        // On web, list content height can include collapsed/offscreen subtrees (e.g. tool-call group bodies),
        // which can cause false positives. Prefer DOM scroll metrics when available.
        if (Platform.OS === 'web') {
            try {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    return isWebTranscriptScrollable(metrics, 1);
                }
            } catch {
                // fall through to measurement-based heuristic
            }
        }

        const layout = listLayoutHeight;
        const content = listContentHeight;
        if (!Number.isFinite(layout) || layout <= 0) return false;
        if (!Number.isFinite(content) || content <= 0) return false;
        return content > layout + 16;
    }, [listContentHeight, listLayoutHeight, resolveWebScrollMetrics]);

    const shouldLoadOlderFromStartReached = React.useCallback((): boolean => {
        if (initialFillStatusRef.current !== 'done') return false;
        if (listImplementation !== 'flash_v2' || Platform.OS !== 'web') return true;

        const prefetchThresholdPx = resolveBackwardPrefetchThresholdPx(listLayoutHeightRef.current);
        const metrics = resolveWebScrollMetrics();
        if (metrics) {
            return shouldPrefetchOlderFromTop({
                scrollable: isWebTranscriptScrollable(metrics, 1),
                offsetY: metrics.scrollTop,
                prefetchThresholdPx,
                distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
                pinThresholdPx,
                wantsPinned: wantsPinnedRef.current,
            });
        }

        return wantsPinnedRef.current !== true;
    }, [listImplementation, pinThresholdPx, resolveBackwardPrefetchThresholdPx, resolveWebScrollMetrics]);

    const flashListStartReachedThreshold = React.useMemo(() => {
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        const thresholdPx = resolveBackwardPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveBackwardPrefetchThresholdPx]);

    const resolveToolCallsCollapsedPreviewCount = React.useCallback((): number => {
        return resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting);
    }, [transcriptToolCallsCollapsedPreviewCountSetting]);

    const tryAutoExpandNewestToolCallsGroup = React.useCallback((): boolean => {
        const previewCount = resolveToolCallsCollapsedPreviewCount();
        const items = itemsRef.current;
        const newestFirst = listImplementation === 'flatlist_legacy';

        const visitItem = (it: ChatTranscriptListItem | null | undefined): boolean => {
            if (!it) return false;
            if (it.kind === 'tool-calls-group') {
                const toolMessageIds = it.toolMessageIds;
                if (toolMessageIds.length <= previewCount) return false;
                if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) return false;
                applyToolCallsGroupExpanded({ toolCallsGroupId: it.id, toolMessageIds, expanded: true });
                return true;
            }
            if (it.kind === 'turn') {
                const content = it.turn?.content;
                if (!Array.isArray(content) || content.length === 0) return false;
                for (let j = content.length - 1; j >= 0; j -= 1) {
                    const c = content[j];
                    if (c.kind !== 'tool_calls') continue;
                    const toolMessageIds = c.toolMessageIds;
                    if (toolMessageIds.length <= previewCount) continue;
                    if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) continue;
                    applyToolCallsGroupExpanded({ toolCallsGroupId: c.id, toolMessageIds, expanded: true });
                    return true;
                }
            }
            return false;
        };

        if (newestFirst) {
            for (let i = 0; i < items.length; i += 1) {
                if (visitItem(items[i])) return true;
            }
            return false;
        }
        for (let i = items.length - 1; i >= 0; i -= 1) {
            if (visitItem(items[i])) return true;
        }
        return false;
    }, [applyToolCallsGroupExpanded, expandedToolCallsAnchorMessageIds, listImplementation, resolveToolCallsCollapsedPreviewCount]);

    React.useEffect(() => {
        // Intentionally runs after every render until the transcript becomes scrollable or we succeed.
        // The turns/grouping builder can update in-place as message bodies hydrate, so relying on
        // `items`/`listData` identity is not robust here.
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (didAutoExpandToolCallsGroupsForSessionRef.current === props.sessionId) return;
        if (isScrollable()) return;

        const expanded = tryAutoExpandNewestToolCallsGroup();
        if (!expanded) return;

        didAutoExpandToolCallsGroupsForSessionRef.current = props.sessionId;
        fireAndForget((async () => {
            await Promise.resolve();
            await Promise.resolve();
            if (sessionEntryViewportRef.current?.shouldFollowBottom === false) return;
            pinToBottom('content-size-change');
        })(), { tag: 'ChatList.autoExpandToolCallsGroup' });
    });

    const resolveJumpIndex = React.useCallback((): number | null => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;

        let exact: number | null = null;
        let nextAfter: { idx: number; seq: number } | null = null;
        let prevBefore: { idx: number; seq: number } | null = null;
        const items = itemsRef.current;

        const considerSeq = (idx: number, seq: number) => {
            const normalizedSeq = Math.trunc(seq);
            if (normalizedSeq === target) {
                exact = idx;
                return;
            }
            if (normalizedSeq > target) {
                if (!nextAfter || normalizedSeq < nextAfter.seq) nextAfter = { idx, seq: normalizedSeq };
            } else if (normalizedSeq < target) {
                if (!prevBefore || normalizedSeq > prevBefore.seq) prevBefore = { idx, seq: normalizedSeq };
            }
        };

        for (let i = 0; i < items.length; i++) {
            const it = items[i]!;
            if (it.kind === 'message') {
                const seq = it.seq ?? resolveSeqForMessageId(it.messageId);
                if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
            } else if (it.kind === 'turn') {
                const userSeq = it.turn.userMessageId ? resolveSeqForMessageId(it.turn.userMessageId) : null;
                if (typeof userSeq === 'number' && Number.isFinite(userSeq)) considerSeq(i, userSeq);
                for (const c of it.turn.content) {
                    if (c.kind === 'message') {
                        const seq = resolveSeqForMessageId(c.messageId);
                        if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
                    } else if (c.kind === 'tool_calls') {
                        for (const toolMessageId of c.toolMessageIds) {
                            const seq = resolveSeqForMessageId(toolMessageId);
                            if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
                        }
                    }
                    if (exact != null) break;
                }
            }
            if (exact != null) break;
        }
        if (exact != null) return exact;
        if (nextAfter) return nextAfter.idx;
        if (prevBefore) return prevBefore.idx;
        return null;
    }, [props.jumpToSeq, resolveSeqForMessageId]);

    React.useEffect(() => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return;
        if (!props.isLoaded) return;
        if (lastJumpSeqRef.current === target) return;
        if (!props.sessionId) return;

        lastJumpSeqRef.current = target;
        fireAndForget((async () => {
            await jumpToTranscriptSeq({
                targetSeq: target,
                getIndex: resolveJumpIndex,
                loadOlder: async () => {
                    const result = props.forkedTranscriptEnabled
                        ? await sync.loadOlderMessagesForkAware(props.sessionId)
                        : await sync.loadOlderMessages(props.sessionId);
                    if (result.status === 'no_more') return { status: 'no_more' as const };
                    return { status: 'loaded' as const, hasMore: result.hasMore };
                },
                afterLoadOlder: async () => {
                    // Yield to allow store updates + list re-render before re-checking `getIndex`.
                    await Promise.resolve();
                    await Promise.resolve();
                },
                scrollToIndex: (index) => {
                    if (shouldUseWebHotColdSplit) {
                        const decision = resolveWebHotColdScrollDecision({
                            fullIndex: index,
                            coldCount: transcriptHotColdSegments.coldItems.length,
                        });
                        if (decision.kind === 'pin_to_bottom') {
                            pinToBottom('jump-to-seq');
                            return;
                        }
                        const command = resolveViewportCommand({
                            type: 'jump-to-seq',
                            sessionId: props.sessionId,
                            seq: target,
                            index: decision.index,
                        });
                        executeViewportCommand(withTranscriptViewportCommandAnimation(command, true));
                        return;
                    }
                    const command = resolveViewportCommand({
                        type: 'jump-to-seq',
                        sessionId: props.sessionId,
                        seq: target,
                        index,
                    });
                    executeViewportCommand(withTranscriptViewportCommandAnimation(command, true));
                },
                maxLoads: 25,
            });
        })(), { tag: 'ChatList.jumpToTranscriptSeq' });
    }, [
        pinToBottom,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.jumpToSeq,
            props.sessionId,
            executeViewportCommand,
            resolveJumpIndex,
            resolveViewportCommand,
            shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
    ]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialFillStatusRef.current !== 'idle') return;

        // Wait for at least one layout + content measurement pass before deciding whether to fill.
        if (listLayoutHeight <= 0 || listContentHeight <= 0) return;

        initialFillStatusRef.current = 'in_progress';
        initialFillAbortRef.current?.abort();
        const controller = new AbortController();
        initialFillAbortRef.current = controller;
        const signal = controller.signal;
        const shouldPinDuringInitialFill = sessionEntryViewportRef.current?.shouldFollowBottom !== false;
        fireAndForget((async () => {
            if (shouldPinDuringInitialFill) {
                // Pin once up front for follow-bottom entries; observed unpinned restores must keep
                // their reading viewport while initial fill fetches older pages.
                pinToBottomRespectingNativeMountSettle('initial-open');
                if (Platform.OS === 'web') {
                    await waitForNextVisualUpdate();
                }
            }

            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const { budgetMs, maxNoProgressLoads } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            let consecutiveNoProgressLoads = 0;

            while (true) {
                if (signal.aborted) return;
                // If the transcript is scrollable and we have at least one visible committed message,
                // stop prefetching older pages.
                if (isScrollable() && props.committedMessagesCount > 0) break;
                if (Date.now() - startedAtMs >= budgetMs) break;

                const result = await loadOlder({ showLoadingIndicator: false });
                if (!result) break;
                if (result.status === 'no_more') break;

                const madeProgress = result.status === 'loaded' && result.loaded > 0;
                consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;

                // Yield to allow store updates + list re-render + content size update.
                await Promise.resolve();
                await Promise.resolve();
                if (shouldPinDuringInitialFill) {
                    pinToBottomRespectingNativeMountSettle('initial-open');
                }
                if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
            }
            if (signal.aborted) return;
            initialFillStatusRef.current = 'done';
            observeMountSettleMetrics();
            if (!shouldPinDuringInitialFill) {
                tryRestoreEntryViewport({ force: true });
            }
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        isScrollable,
        listContentHeight,
        listLayoutHeight,
        loadOlder,
        observeMountSettleMetrics,
        pinToBottomRespectingNativeMountSettle,
        props.committedMessagesCount,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        tryRestoreEntryViewport,
        waitForNextVisualUpdate,
    ]);

    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <View
              style={{ flex: 1 }}
              {...(Platform.OS === 'web'
                ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                : {})}
            >
          {listImplementation === 'flatlist_legacy' ? (
          <FlatList<ChatTranscriptListItem>
          ref={(node) => {
            // react-test-renderer does not provide a stable ref object; we store it manually.
            listRef.current = node as unknown as ScrollableChatListRef | null;
          }}
            {...(Platform.OS === 'web'
              ? ({
                                    onWheel: stopScrollEventPropagationOnWeb,
                                    onTouchMove: stopScrollEventPropagationOnWeb,
                                    onPointerDown: markUserScrollIntentOnWeb,
                                    onMouseDown: markUserScrollIntentOnWeb,
                              } as any)
              : ({
                                    onTouchMove: recordNativeTranscriptTouchIntent,
                              } as any)
              )}
          testID="transcript-chat-list"
          data={listData}
          extraData={transcriptMessageSelection.selectionVersion}
          inverted={true}
          key={props.sessionId}
          nativeID={chatListNativeId}
                  keyExtractor={keyExtractor}
          maintainVisibleContentPosition={
                        flatListMaintainVisibleContentPosition
                      }
                    onLayout={(e) => {
                        const layout = e?.nativeEvent?.layout;
                        recordListLayoutWidth(layout?.width);
                        const h = layout?.height;
                        if (typeof h === 'number' && Number.isFinite(h)) {
                            const layoutHeightChanged = listLayoutHeightRef.current !== h;
                            listLayoutHeightRef.current = h;
                            setListLayoutHeight(h);
                            if (layoutHeightChanged) {
                                recordViewportTelemetryEvent({
                                    type: 'layout-measured',
                                    mode: resolveViewportTelemetryMode(),
                                    reason: 'layout-change',
                                    layoutHeight: h,
                                    contentHeight: listContentHeightRef.current,
                                });
                            }
                        }
                    }}
                    onContentSizeChange={(_, h) => {
                        if (typeof h === 'number' && Number.isFinite(h)) {
                            const contentHeightChanged = listContentHeightRef.current !== h;
                            markNativeContentMeasurementForCurrentSession();
                            listContentHeightRef.current = h;
                            setListContentHeight(h);
                            if (contentHeightChanged) {
                                recordViewportTelemetryEvent({
                                    type: 'content-measured',
                                    mode: resolveViewportTelemetryMode(),
                                    reason: 'content-size-change',
                                    layoutHeight: listLayoutHeightRef.current,
                                    contentHeight: h,
                                });
                            }
                        }
                    }}
                onScroll={(e) => {
                    const y = e?.nativeEvent?.contentOffset?.y;
                    if (typeof y !== 'number' || !Number.isFinite(y)) return;
                    const nowMs = Date.now();
                    const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                    const nativeDistanceFromBottom = y;
                    if (Platform.OS !== 'web') {
                        recordScrollObservedTelemetry({
                            offsetY: y,
                            layoutHeight: listLayoutHeightRef.current,
                            contentHeight: listContentHeightRef.current,
                            distanceFromBottom: nativeDistanceFromBottom,
                        });
                    }
                    const shouldIgnorePassiveNativeScroll = shouldIgnoreNativePassiveViewportScroll(
                        isTrusted,
                        nowMs,
                        nativeDistanceFromBottom,
                        pinThresholdPx,
                    );
                    const shouldIgnoreNativeRecycledTopScroll = shouldIgnoreNativeRecycledTopJump(
                        nativeDistanceFromBottom,
                        pinThresholdPx,
                    );
                    const shouldRecordPassiveNativeMovement =
                        !isTrusted && shouldRecordNativePassiveUnpinnedMovement(nativeDistanceFromBottom, pinThresholdPx);
                    if (shouldIgnoreNativeRecycledTopScroll) {
                        return;
                    } else if (isTrusted) {
                                            markNativeInitialViewportAppliedForCurrentSession();
                                                recordNativeUserScrollIntent(nowMs);
                    } else if (shouldIgnorePassiveNativeScroll) {
                        return;
                    } else if (shouldRecordPassiveNativeMovement) {
                        recordNativeUserScrollIntent(nowMs);
                    } else {
                        refreshNativeRecentPassiveUserScrollIntent(isTrusted, nowMs);
                    }
                    const followIntent = resolveTranscriptBottomFollowIntent({
                        direction: 'toward-zero',
                        distanceFromBottom: y,
                        pinThresholdPx,
                        previousScrollOffset: lastScrollOffsetForIntentRef.current ?? (wantsPinnedRef.current ? 0 : null),
                        recentUserIntent: isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS,
                        scrollOffset: y,
                        wantsPinned: wantsPinnedRef.current,
                    });
                    lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                    lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset;
                    wantsPinnedRef.current = followIntent.wantsPinned;

                    const distanceFromBottom = followIntent.nextDistanceFromBottom;
                    const effectiveThresholdPx = followIntent.effectivePinnedOffsetThresholdPx;
                    const pinned = followIntent.isPinned;
                    if (
                        !pinned &&
                        wantsPinnedRef.current &&
                        pinEnabled &&
                        autoFollowWhenPinned &&
                        props.jumpToSeq == null &&
                        Platform.OS !== 'web' &&
                        nowMs - lastAutoRepinAtMsRef.current > TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS &&
                        nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
                    ) {
                        // Web/virtualization can sometimes drift the scroll position even without user intent.
                        // If we still "want pinned", repin opportunistically.
                        lastAutoRepinAtMsRef.current = nowMs;
                            deferPinToBottomAfterScroll('stream-append');
                    }
                    isPinnedRef.current = pinned;
                    const viewportState = {
                        isPinned: pinned,
                        offsetY: distanceFromBottom,
                        shouldRestoreViewport: !wantsPinnedRef.current,
                    };
                    emitViewportChange(viewportState);
                    scheduleViewportAnchorCapture(viewportState, {
                        suppressAnchorCapture: shouldRecordPassiveNativeMovement,
                    });
                    setJumpToBottomDistanceFromBottom(distanceFromBottom);
                    setScrollPin((prev) =>
                        reduceTranscriptScrollPinState(prev, {
                            type: 'scroll',
                            enabled: pinEnabled,
                            offsetY: distanceFromBottom,
                            pinnedOffsetThresholdPx: effectiveThresholdPx,
                        })
                    );

                    const prefetchThresholdPx = sync.getSyncTuning().transcriptForwardPrefetchThresholdPx;
                    if (!pinned && distanceFromBottom <= prefetchThresholdPx && !loadNewerInFlight.current) {
                        if (sync.hasDeferredNewerMessages(props.sessionId) === true) {
                            loadNewerInFlight.current = true;
                            const p = sync.loadNewerMessages(props.sessionId);
                            p.finally(() => {
                                loadNewerInFlight.current = false;
                            }).catch(() => {});
                            fireAndForget(p, { tag: 'ChatList.loadNewerMessages' });
                        }
                    }
                }}
                onScrollBeginDrag={() => {
                    if (Platform.OS === 'web') return;
                    markNativeInitialViewportAppliedForCurrentSession();
                    recordNativeUserScrollIntent();
                }}
                scrollEventThrottle={16}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                renderItem={renderItem}
                onEndReachedThreshold={0.2}
                onEndReached={() => {
                    if (initialFillStatusRef.current !== 'done') return;
                    void loadOlder();
                }}
                        onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                            // Best-effort fallback for dynamic-height rows.
                            const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
                                executeViewportCommand({
                                kind: 'scroll-offset',
                                sessionId: props.sessionId,
                                reason: props.jumpToSeq != null ? 'jump-to-seq' : 'entry-restore',
                                mode: props.jumpToSeq != null ? 'jump-to-seq' : 'restore-distance',
                            offsetY: offset,
                            animated: true,
                        });
                    }}
                  ListHeaderComponent={listHeaderNode}
                  ListFooterComponent={
                        listFooterNode
                    }
              />
              ) : (
                  <LayoutCommitObserver onCommitLayoutEffect={recordLayoutCommitObserved}>
                  <FlashList
                      ref={(node: ScrollableChatListRef | null) => {
                          listRef.current = node as unknown as ScrollableChatListRef | null;
                      }}
                        {...(Platform.OS === 'web'
                            ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                            : ({
                                        onTouchMove: recordNativeTranscriptTouchIntent,
                                  } as any)
                            )}
                        testID="transcript-chat-list"
                      data={listData}
                      extraData={transcriptMessageSelection.selectionVersion}
                      key={props.sessionId}
                      nativeID={chatListNativeId}
                      keyExtractor={keyExtractor}
                        getItemType={getItemType}
                        drawDistance={flashListDrawDistance}
                      onLoad={recordFirstListPaint}
                      maintainVisibleContentPosition={
                          flashListMaintainVisibleContentPosition
                      }
                      onLayout={(e: LayoutChangeEvent) => {
                          const layout = e?.nativeEvent?.layout;
                          recordListLayoutWidth(layout?.width);
                          const h = layout?.height;
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              const layoutHeightChanged = listLayoutHeightRef.current !== h;
                              const previousWebMetrics = captureWebBottomFollowPreviousMetrics();
                              listLayoutHeightRef.current = h;
                                      setListLayoutHeight(h);
                                      if (layoutHeightChanged) {
                                          recordViewportTelemetryEvent({
                                              type: 'layout-measured',
                                              mode: resolveViewportTelemetryMode(),
                                              reason: 'layout-change',
                                              layoutHeight: h,
                                              contentHeight: listContentHeightRef.current,
                                          });
                                      }
                                      observeMountSettleMetrics();
                                      pinNativeInitialFollowBottomViewportIfReady('layout-change');
                                  if (Platform.OS !== 'web' && sessionEntryViewportRef.current?.shouldFollowBottom === false) {
                                      tryRestoreEntryViewport({ force: true });
                                  }
                                        if (layoutHeightChanged && listContentHeightRef.current > 0) {
                                            schedulePinToBottom(previousWebMetrics, 'layout-change');
                                        }
                          }
                      }}
                          onContentSizeChange={(_: number, h: number) => {
                                  if (typeof h === 'number' && Number.isFinite(h)) {
                                      const measuredContentHeight = resolveMeasuredContentHeight(h);
                                      const contentHeightChanged = listContentHeightRef.current !== measuredContentHeight;
                                      const previousMeasuredActivityKey = lastMeasuredContentActivityKeyRef.current;
                                      const contentSizeScrollReason: TranscriptViewportTelemetryScrollReason =
                                          props.sessionActive &&
                                          previousMeasuredActivityKey != null &&
                                          props.latestCommittedActivityKey != null &&
                                          previousMeasuredActivityKey !== props.latestCommittedActivityKey
                                              ? 'stream-append'
                                              : 'content-size-change';
                                  const previousWebMetrics = captureWebBottomFollowPreviousMetrics();
                                  markNativeContentMeasurementForCurrentSession();
                                      listContentHeightRef.current = measuredContentHeight;
                                      lastMeasuredContentActivityKeyRef.current = props.latestCommittedActivityKey;
                                      if (shouldCommitContentHeightState()) {
                                          setListContentHeight(measuredContentHeight);
                                      }
                                      if (contentHeightChanged) {
                                          recordViewportTelemetryEvent({
                                              type: 'content-measured',
                                              mode: resolveViewportTelemetryMode(),
                                              reason: 'content-size-change',
                                              layoutHeight: listLayoutHeightRef.current,
                                              contentHeight: measuredContentHeight,
                                          });
                                      }
                                      observeMountSettleMetrics();
                                      pinNativeInitialFollowBottomViewportIfReady(contentSizeScrollReason);
                                  if (Platform.OS !== 'web' && sessionEntryViewportRef.current?.shouldFollowBottom === false) {
                                      tryRestoreEntryViewport({ force: true });
                                  }
                                        if (contentHeightChanged && listLayoutHeightRef.current > 0) {
                                            schedulePinToBottom(previousWebMetrics, contentSizeScrollReason);
                                            schedulePendingNativeBottomFollowRetryForContentGrowth(measuredContentHeight, Date.now());
                                        }
                          }
                      }}
                        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                                const y = e?.nativeEvent?.contentOffset?.y;
                                if (typeof y !== 'number' || !Number.isFinite(y)) return;
                                            const nowMs = Date.now();
                                            const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                              const eventLayoutH =
                                  Platform.OS !== 'web'
                                      ? resolveNativeScrollEventMetric(e?.nativeEvent?.layoutMeasurement?.height)
                                      : null;
                              const eventContentH =
                                  Platform.OS !== 'web'
                                      ? resolveNativeScrollEventMetric(e?.nativeEvent?.contentSize?.height)
                                      : null;
                              const layoutH = eventLayoutH ?? listLayoutHeightRef.current;
                              const contentH = eventContentH ?? listContentHeightRef.current;
                              const refDistanceFromBottom =
                                  layoutH > 0 && contentH >= layoutH
                                      ? Math.max(0, Math.trunc(contentH - layoutH - y))
                                      : 0;
                                const refVisualBottomScrollOffset =
                                    layoutH > 0 && contentH >= layoutH
                                        ? Math.max(0, Math.trunc(contentH - layoutH))
                                        : null;
                                    const recordNativeScrollObservation = (
                                        reason: TranscriptViewportTelemetryObservationReason = 'observed',
                                    ) => {
                                        if (Platform.OS === 'web') return;
                                        recordScrollObservedTelemetry({
                                            offsetY: y,
                                            layoutHeight: layoutH,
                                            contentHeight: contentH,
                                            distanceFromBottom: refDistanceFromBottom,
                                            reason,
                                        });
                                    };
                                    const shouldIgnorePassiveNativeScroll = shouldIgnoreNativePassiveViewportScroll(
                                        isTrusted,
                                        nowMs,
                                        refDistanceFromBottom,
                                        pinThresholdPx,
                                    );
                                    const shouldIgnoreNativeRecycledTopScroll = shouldIgnoreNativeRecycledTopJump(
                                        refDistanceFromBottom,
                                        pinThresholdPx,
                                    );
                                    const pendingNativeEntryViewportRestore = pendingNativeEntryViewportRestoreRef.current;
                                    const nativeEntryViewportRestoreTolerancePx = Math.max(pinThresholdPx, 2);
                                    const nativeEntryViewportRestoreJumpThresholdPx = Math.max(
                                        layoutH > 0
                                            ? layoutH * TRANSCRIPT_NATIVE_PASSIVE_RECYCLED_JUMP_VIEWPORT_MULTIPLIER
                                            : 0,
                                        pinThresholdPx * TRANSCRIPT_NATIVE_PASSIVE_RECYCLED_JUMP_THRESHOLD_MULTIPLIER,
                                    );
                                    const hasPendingNativeEntryViewportRestore =
                                        Platform.OS !== 'web' &&
                                        pendingNativeEntryViewportRestore?.sessionId === props.sessionId;
                                    const observedPendingNativeEntryViewportRestoreTargetContentReady =
                                        pendingNativeEntryViewportRestore?.contentHeight == null ||
                                        contentH + nativeEntryViewportRestoreTolerancePx >= pendingNativeEntryViewportRestore.contentHeight;
                                    const observedPendingNativeEntryViewportRestoreTargetOffset =
                                        hasPendingNativeEntryViewportRestore &&
                                        pendingNativeEntryViewportRestore &&
                                        pendingNativeEntryViewportRestore.kind === 'distance' &&
                                        pendingNativeEntryViewportRestore.targetOffsetYWasClamped !== true &&
                                        observedPendingNativeEntryViewportRestoreTargetContentReady &&
                                        Number.isFinite(pendingNativeEntryViewportRestore.targetOffsetY) &&
                                        Math.abs(y - (pendingNativeEntryViewportRestore.targetOffsetY ?? 0)) <= nativeEntryViewportRestoreTolerancePx;
                                    const observedPendingNativeEntryViewportRestore =
                                        hasPendingNativeEntryViewportRestore &&
                                        pendingNativeEntryViewportRestore &&
                                        (
                                            Math.abs(refDistanceFromBottom - pendingNativeEntryViewportRestore.offsetY) <= nativeEntryViewportRestoreTolerancePx ||
                                            observedPendingNativeEntryViewportRestoreTargetOffset
                                        );
                                    if (observedPendingNativeEntryViewportRestore && pendingNativeEntryViewportRestore) {
                                        cancelScheduledNativeEntryViewportRestoreRetry();
                                        pendingNativeEntryViewportRestoreRef.current = null;
                                        entryViewportRestoreAppliedRef.current = {
                                            sessionId: pendingNativeEntryViewportRestore.sessionId,
                                            offsetY: pendingNativeEntryViewportRestore.offsetY,
                                            contentHeight: pendingNativeEntryViewportRestore.kind === 'distance'
                                                ? pendingNativeEntryViewportRestore.contentHeight
                                                : undefined,
                                        };
                                        markNativeInitialViewportAppliedForCurrentSession();
                                    }
                                    if (
                                        hasPendingNativeEntryViewportRestore &&
                                        !observedPendingNativeEntryViewportRestore &&
                                        pendingNativeEntryViewportRestore &&
                                        nativeEntryViewportRestoreJumpThresholdPx > 0 &&
                                        refDistanceFromBottom > pendingNativeEntryViewportRestore.offsetY + nativeEntryViewportRestoreJumpThresholdPx
                                    ) {
                                        if (!isTrusted) {
                                            scheduleNativeEntryViewportRestoreRetry(pendingNativeEntryViewportRestore.offsetY, nowMs);
                                            recordNativeScrollObservation('pending');
                                            return;
                                        }
                                        cancelScheduledNativeEntryViewportRestoreRetry();
                                        pendingNativeEntryViewportRestoreRef.current = null;
                                    }
                                    if (
                                        hasPendingNativeEntryViewportRestore &&
                                        !observedPendingNativeEntryViewportRestore &&
                                        pendingNativeEntryViewportRestore
                                    ) {
                                        if (!isTrusted) {
                                            scheduleNativeEntryViewportRestoreRetry(pendingNativeEntryViewportRestore.offsetY, nowMs);
                                            recordNativeScrollObservation('pending');
                                            return;
                                        }
                                        cancelScheduledNativeEntryViewportRestoreRetry();
                                        pendingNativeEntryViewportRestoreRef.current = null;
                                    }
                                    const nativeBottomFollowTargetConfirmation = nativeBottomFollowTargetConfirmationRef.current;
                                    const shouldRecordNativeBottomFollowStaleObservationCandidate =
                                        Platform.OS !== 'web' &&
                                        usesNativeFlashListBottomMaintenance &&
                                        (
                                            pendingNativeMountSettleBottomPinRef.current ||
                                            !nativeMountSettleStable ||
                                            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true
                                        ) &&
                                        wantsPinnedRef.current &&
                                        !isTrusted &&
                                        refDistanceFromBottom > pinThresholdPx;
                                    const previousNativeBottomFollowStaleObservationCandidate =
                                        nativeBottomFollowStaleObservationCandidateRef.current;
                                    let currentNativeBottomFollowStaleObservationCandidate: typeof previousNativeBottomFollowStaleObservationCandidate = null;
                                    if (shouldRecordNativeBottomFollowStaleObservationCandidate) {
                                        currentNativeBottomFollowStaleObservationCandidate = {
                                            sessionId: props.sessionId,
                                            distanceFromBottom: refDistanceFromBottom,
                                            offsetY: y,
                                            observedAtMs: nowMs,
                                        };
                                        nativeBottomFollowStaleObservationCandidateRef.current =
                                            currentNativeBottomFollowStaleObservationCandidate;
                                    }
                                    const nativeBottomFollowStaleObservationCandidate =
                                        currentNativeBottomFollowStaleObservationCandidate ??
                                        previousNativeBottomFollowStaleObservationCandidate;
                                    const previousNativeBottomFollowStaleObservationCandidateMatches =
                                        previousNativeBottomFollowStaleObservationCandidate?.sessionId === props.sessionId &&
                                        nowMs - previousNativeBottomFollowStaleObservationCandidate.observedAtMs <= TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS &&
                                        (
                                            Math.abs(previousNativeBottomFollowStaleObservationCandidate.distanceFromBottom - refDistanceFromBottom) <= pinThresholdPx ||
                                            Math.abs(previousNativeBottomFollowStaleObservationCandidate.offsetY - y) <= pinThresholdPx
                                        );
                                    const matchesRecentNativeBottomFollowStaleObservationCandidate =
                                        nativeBottomFollowStaleObservationCandidate?.sessionId === props.sessionId &&
                                        nowMs - nativeBottomFollowStaleObservationCandidate.observedAtMs <= TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS &&
                                        (
                                            Math.abs(nativeBottomFollowStaleObservationCandidate.distanceFromBottom - refDistanceFromBottom) <= pinThresholdPx ||
                                            Math.abs(nativeBottomFollowStaleObservationCandidate.offsetY - y) <= pinThresholdPx
                                        );
                                    const hasRecentNativeBottomFollowTargetConfirmation =
                                        Platform.OS !== 'web' &&
                                        usesNativeFlashListBottomMaintenance &&
                                        nativeBottomFollowTargetConfirmation?.sessionId === props.sessionId &&
                                        nowMs - nativeBottomFollowTargetConfirmation.observedAtMs <= TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
                                    const shouldIgnoreRecentlyConfirmedNativeBottomFollowRecycledObservation =
                                        hasRecentNativeBottomFollowTargetConfirmation &&
                                        matchesRecentNativeBottomFollowStaleObservationCandidate &&
                                        wantsPinnedRef.current &&
                                        !isTrusted &&
                                        refDistanceFromBottom > pinThresholdPx &&
                                        nativeBottomFollowTargetConfirmation != null &&
                                        nowMs - nativeBottomFollowTargetConfirmation.observedAtMs <= TRANSCRIPT_NATIVE_BOTTOM_CONFIRMATION_RECYCLED_EVENT_WINDOW_MS &&
                                        previousNativeBottomFollowStaleObservationCandidate != null &&
                                        previousNativeBottomFollowStaleObservationCandidateMatches &&
                                        Math.abs(
                                            previousNativeBottomFollowStaleObservationCandidate.observedAtMs -
                                            nativeBottomFollowTargetConfirmation.observedAtMs,
                                        ) <= TRANSCRIPT_NATIVE_BOTTOM_CONFIRMATION_RECYCLED_EVENT_WINDOW_MS;
                                    const shouldRetryRecentlyConfirmedNativeBottomFollow =
                                        hasRecentNativeBottomFollowTargetConfirmation &&
                                        matchesRecentNativeBottomFollowStaleObservationCandidate &&
                                        wantsPinnedRef.current &&
                                        !isTrusted &&
                                        refDistanceFromBottom > pinThresholdPx &&
                                        nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS;
                                    const shouldRetryPendingNativeBottomFollow =
                                        Platform.OS !== 'web' &&
                                        usesNativeFlashListBottomMaintenance &&
                                        pendingNativeMountSettleBottomPinRef.current &&
                                        wantsPinnedRef.current &&
                                        !isTrusted &&
                                        refDistanceFromBottom > pinThresholdPx &&
                                        !hasNativeInitialViewportAppliedForCurrentSession() &&
                                        nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS;
                                    recordNativeScrollObservation(
                                        shouldIgnoreRecentlyConfirmedNativeBottomFollowRecycledObservation ||
                                        shouldIgnoreNativeRecycledTopScroll
                                            ? 'recycled-event'
                                            : shouldRetryRecentlyConfirmedNativeBottomFollow ||
                                                shouldRetryPendingNativeBottomFollow ||
                                                shouldRecordNativeBottomFollowStaleObservationCandidate
                                                ? 'pending'
                                                : shouldIgnorePassiveNativeScroll
                                                    ? 'skipped'
                                                    : 'observed',
                                    );
                                    if (shouldIgnoreRecentlyConfirmedNativeBottomFollowRecycledObservation) {
                                        pendingNativeMountSettleBottomPinRef.current = true;
                                        nativeBottomFollowTargetConfirmationRef.current = null;
                                        cancelScheduledNativeMountSettleRetry();
                                        scheduleNativeMountSettleRetryAfterThrottle(nowMs);
                                        return;
                                    }
                                    if (
                                        shouldRetryRecentlyConfirmedNativeBottomFollow
                                    ) {
                                        pendingNativeMountSettleBottomPinRef.current = true;
                                        nativeBottomFollowTargetConfirmationRef.current = null;
                                        cancelScheduledNativeMountSettleRetry();
                                        scheduleNativeMountSettleRetryAfterThrottle(nowMs);
                                        return;
                                    } else if (shouldRetryPendingNativeBottomFollow) {
                                        pendingNativeMountSettleBottomPinRef.current = true;
                                        nativeBottomFollowTargetConfirmationRef.current = null;
                                        if (
                                            transcriptNativeMvcpOnlyMode &&
                                            nativeMountSettleSameOffsetWakeRetryCountRef.current <
                                                TRANSCRIPT_NATIVE_MOUNT_SETTLE_SAME_OFFSET_WAKE_RETRY_LIMIT
                                        ) {
                                            cancelScheduledNativeMountSettleRetry();
                                            lastAutoRepinAtMsRef.current = nowMs;
                                            pinNativeFlashListToBottomIfMeasured({
                                                force: true,
                                                markInitialViewportApplied: 'when-scrollable',
                                                telemetryReason: 'mount-settle',
                                            });
                                        } else {
                                            scheduleNativeMountSettleRetryAfterThrottle(nowMs);
                                        }
                                        return;
                                    } else if (shouldRecordNativeBottomFollowStaleObservationCandidate) {
                                        return;
                                    }
                                    const observedPendingNativeBottomPinTarget =
                                        Platform.OS !== 'web' &&
                                        usesNativeFlashListBottomMaintenance &&
                                        pendingNativeMountSettleBottomPinRef.current &&
                                        refVisualBottomScrollOffset != null &&
                                        lastNativePinOffsetRef.current != null &&
                                        (
                                            Math.abs(refVisualBottomScrollOffset - lastNativePinOffsetRef.current) <= pinThresholdPx ||
                                            lastNativePinOffsetRef.current >= refVisualBottomScrollOffset - pinThresholdPx
                                        );
                                    const canCompletePendingNativeBottomFollow =
                                        nativeMountSettleStable ||
                                        nativeMountSettleDeadlineReachedRef.current ||
                                        !pendingNativeMountSettleBottomPinRef.current ||
                                        observedPendingNativeBottomPinTarget;
                                    const shouldRecordNativeBottomFollowTargetConfirmation =
                                        observedPendingNativeBottomPinTarget ||
                                        (
                                            Platform.OS !== 'web' &&
                                            usesNativeFlashListBottomMaintenance &&
                                            wantsPinnedRef.current &&
                                            !isTrusted &&
                                            nativeBottomFollowStaleObservationCandidateRef.current?.sessionId === props.sessionId
                                        );
                                    if (
                                        Platform.OS !== 'web' &&
                                        wantsPinnedRef.current &&
                                        refDistanceFromBottom <= pinThresholdPx &&
                                        canCompletePendingNativeBottomFollow
                                    ) {
                                        nativeBottomFollowTargetConfirmationRef.current = shouldRecordNativeBottomFollowTargetConfirmation
                                            ? {
                                                sessionId: props.sessionId,
                                                observedAtMs: nowMs,
                                            }
                                            : null;
                                        if (!shouldRecordNativeBottomFollowTargetConfirmation) {
                                            nativeBottomFollowStaleObservationCandidateRef.current = null;
                                        }
                                        cancelScheduledNativeMountSettleRetry();
                                        invalidateQueuedNativeMountSettleRetries();
                                        pendingNativeMountSettleBottomPinRef.current = false;
                                        markNativeInitialViewportAppliedForCurrentSession();
                                    }
                                    const shouldRecordPassiveNativeMovement =
                                        !isTrusted && shouldRecordNativePassiveUnpinnedMovement(refDistanceFromBottom, pinThresholdPx);
                                    if (shouldIgnoreNativeRecycledTopScroll) {
                                        return;
                                    } else if (isTrusted) {
                                        markNativeInitialViewportAppliedForCurrentSession();
                                        recordNativeUserScrollIntent(nowMs);
                                    } else if (shouldIgnorePassiveNativeScroll) {
                                        return;
                                    } else if (shouldRecordPassiveNativeMovement) {
                                        recordNativeUserScrollIntent(nowMs);
                                    } else {
                                        refreshNativeRecentPassiveUserScrollIntent(isTrusted, nowMs);
                                    }
                                // On web the FlashList content height can be stale or collapsed (the hot/cold
                                // split renders the tail in the footer), so the ref-based distance can read 0
                                // even while the user is scrolled up. Prefer the live DOM scroller metrics so
                                // the released/observed viewport intent is not discarded by a measurement zero.
                                const liveWebMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
                                const distanceFromBottom = liveWebMetrics
                                    ? getWebTranscriptDistanceFromBottom(liveWebMetrics)
                                    : refDistanceFromBottom;
                                const visualBottomScrollOffset = liveWebMetrics
                                    ? resolveWebTranscriptMaxScrollTop(liveWebMetrics)
                                    : refVisualBottomScrollOffset;
                                mountSettleCoordinatorRef.current?.sample({
                                    sessionId: props.sessionId,
                                    nowMs,
                                });
                                if (liveWebMetrics) {
                                    // A genuine web scroll-up (movement toward the top, away from the tail)
                                    // counts as user intent even without a trusted event or a preceding
                                    // pointer event (scrollbar drag / keyboard). Programmatic pin/restore
                                    // scroll writes update `lastObservedWebScrollTopRef` to their own target,
                                    // so they are not misread as user movement.
                                    const liveScrollTop = liveWebMetrics.scrollTop;
                                    const previousObservedScrollTop =
                                        lastObservedWebScrollTopRef.current
                                        ?? (wantsPinnedRef.current ? visualBottomScrollOffset : null);
                                    if (
                                        previousObservedScrollTop != null
                                        && liveScrollTop < previousObservedScrollTop
                                        && distanceFromBottom > pinThresholdPx
                                    ) {
                                        lastUserScrollIntentAtMsRef.current = nowMs;
                                    }
                                    lastObservedWebScrollTopRef.current = liveScrollTop;
                                }
                                observeMountSettleMetrics({
                                    nowMs,
                                    distanceFromBottom,
                                });
                                const recentUserIntent =
                                    isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
                                const passiveNativeBottomFollowDrift =
                                    Platform.OS !== 'web' &&
                                    usesNativeFlashListBottomMaintenance &&
                                    pinEnabled &&
                                    autoFollowWhenPinned &&
                                    props.jumpToSeq == null &&
                                    wantsPinnedRef.current &&
                                    !recentUserIntent;
                                const passiveNativeBottomFollowDriftRepinGated =
                                    passiveNativeBottomFollowDrift &&
                                    (
                                        !nativeMountSettleStable ||
                                        mountSettleCoordinatorRef.current?.shouldGatePassiveDriftRepin({
                                            wantsPinned: wantsPinnedRef.current,
                                            distanceFromBottom,
                                            pinThresholdPx,
                                        }) === true
                                    );
                                if (
                                    passiveNativeBottomFollowDrift &&
                                    !passiveNativeBottomFollowDriftRepinGated &&
                                    distanceFromBottom > pinThresholdPx &&
                                    nowMs - lastAutoRepinAtMsRef.current > TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS
                                ) {
                                    lastAutoRepinAtMsRef.current = nowMs;
                                        deferPinToBottomAfterScroll('passive-drift');
                                }
                                const effectiveDistanceFromBottom = passiveNativeBottomFollowDrift ? 0 : distanceFromBottom;
                                const effectiveScrollOffset =
                                    passiveNativeBottomFollowDrift && visualBottomScrollOffset != null
                                        ? visualBottomScrollOffset
                                        : liveWebMetrics
                                            ? liveWebMetrics.scrollTop
                                            : y;
                                const tuning = sync.getSyncTuning();
                                const backwardPrefetchThresholdPx = resolveBackwardPrefetchThresholdPx(layoutH);
                                const scrollable = layoutH > 0 && contentH > layoutH + 16;
                                if (shouldPrefetchOlderFromTop({
                                    scrollable: initialFillStatusRef.current === 'done' && scrollable,
                                    offsetY: effectiveScrollOffset,
                                    prefetchThresholdPx: backwardPrefetchThresholdPx,
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                    pinThresholdPx,
                                    wantsPinned: wantsPinnedRef.current,
                                })) {
                                    void loadOlder({
                                        loadingIndicatorDelayMs: tuning.transcriptOlderLoadSpinnerDelayMs,
                                    });
                                }
                                if (loadOlderInFlight.current) {
                                    refreshInFlightWebPrependAnchor();
                                }
                                const followIntent = resolveTranscriptBottomFollowIntent({
                                    direction: 'toward-max',
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                    pinThresholdPx,
                                    previousScrollOffset: lastScrollOffsetForIntentRef.current ?? (wantsPinnedRef.current ? visualBottomScrollOffset : null),
                                    recentUserIntent,
                                    scrollOffset: effectiveScrollOffset,
                                    wantsPinned: wantsPinnedRef.current,
                                });
                                lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                                lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset;
                                wantsPinnedRef.current = followIntent.wantsPinned;

                                const effectiveThresholdPx = followIntent.effectivePinnedOffsetThresholdPx;
                                const pinned = followIntent.isPinned;
                                if (
                                    !pinned &&
                                    wantsPinnedRef.current &&
                                    pinEnabled &&
                                    autoFollowWhenPinned &&
                                    props.jumpToSeq == null &&
                                    Platform.OS !== 'web' &&
                                    !passiveNativeBottomFollowDriftRepinGated &&
                                    nowMs - lastAutoRepinAtMsRef.current > TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS &&
                                    nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
                                ) {
                                    lastAutoRepinAtMsRef.current = nowMs;
                                        deferPinToBottomAfterScroll('stream-append');
                                }
                                isPinnedRef.current = pinned;
                                const viewportState = {
                                    isPinned: pinned,
                                    offsetY: effectiveDistanceFromBottom,
                                    shouldRestoreViewport: !wantsPinnedRef.current,
                                };
                                emitViewportChange(viewportState);
                                scheduleViewportAnchorCapture(viewportState, {
                                    suppressAnchorCapture: shouldRecordPassiveNativeMovement,
                                });
                                setJumpToBottomDistanceFromBottom(effectiveDistanceFromBottom);
                                setScrollPin((prev) =>
                                    reduceTranscriptScrollPinState(prev, {
                                        type: 'scroll',
                                        enabled: pinEnabled,
                                        offsetY: effectiveDistanceFromBottom,
                                        pinnedOffsetThresholdPx: effectiveThresholdPx,
                                    })
                                );

                                const prefetchThresholdPx = sync.getSyncTuning().transcriptForwardPrefetchThresholdPx;
                                if (!pinned && effectiveDistanceFromBottom <= prefetchThresholdPx && !loadNewerInFlight.current) {
                                    if (sync.hasDeferredNewerMessages(props.sessionId) === true) {
                                        loadNewerInFlight.current = true;
                                        const p = sync.loadNewerMessages(props.sessionId);
                                        p.finally(() => {
                                            loadNewerInFlight.current = false;
                                        }).catch(() => {});
                                        fireAndForget(p, { tag: 'ChatList.loadNewerMessages' });
                                    }
                                }
                            }}
                            onScrollBeginDrag={() => {
                                if (Platform.OS === 'web') return;
                                markNativeInitialViewportAppliedForCurrentSession();
                                recordNativeUserScrollIntent();
                            }}
                            scrollEventThrottle={16}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="none"
                            renderItem={renderItem}
                      onStartReachedThreshold={flashListStartReachedThreshold}
                      onStartReached={() => {
                          if (!shouldLoadOlderFromStartReached()) return;
                          void loadOlder({ loadingIndicatorDelayMs: 0 });
                      }}
                              onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                                  const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
                                      executeViewportCommand({
                                      kind: 'scroll-offset',
                                      sessionId: props.sessionId,
                                      reason: props.jumpToSeq != null ? 'jump-to-seq' : 'entry-restore',
                                      mode: props.jumpToSeq != null ? 'jump-to-seq' : 'restore-distance',
                                  offsetY: offset,
                                  animated: true,
                              });
                          }}
                      ListHeaderComponent={listHeaderNode}
                      ListFooterComponent={
                            flashListFooterNode
                        }
                  />
                  </LayoutCommitObserver>
              )}
              {showFirstPaintPlaceholder ? (
                  <TranscriptFirstPaintPlaceholder reducedMotion={reducedMotionPreferred} />
              ) : null}
              {showJumpToBottom ? (
                  <ComposerKeyboardFloatingInset
                      testID="transcript-jump-to-bottom-keyboard-offset"
                      baseBottom={12}
                      style={{ position: 'absolute', right: 12 }}
                  >
                      <JumpToBottomButton
                          testID="transcript-jump-to-bottom"
                          count={scrollPin.newActivityCount >= jumpMinNewCount ? scrollPin.newActivityCount : 0}
                          onPress={jumpToBottom}
                    />
                </ComposerKeyboardFloatingInset>
            ) : null}
            </View>
        </TranscriptMotionProvider>
    )
});
