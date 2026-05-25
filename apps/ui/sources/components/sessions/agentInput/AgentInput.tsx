import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Pressable, ScrollView } from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { MultiTextInput, KeyPressEvent, type MultiTextInputSubmitBehavior } from '@/components/ui/forms/MultiTextInput';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import { Typography } from '@/constants/Typography';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { getModelOptionsForSession, supportsFreeformModelSelectionForSession, type ModelOption } from '@/sync/domains/models/modelOptions';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { Modal } from '@/modal';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeOptionsForSession,
} from '@/sync/domains/permissions/permissionModeOptions';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { hapticsLight, hapticsError } from '@/components/ui/theme/haptics';
import { type ShakeInstance } from '@/components/ui/feedback/Shaker';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useActiveWord } from '@/components/autocomplete/useActiveWord';
import { useActiveSuggestions } from '@/components/autocomplete/useActiveSuggestions';
import { TextInputState, MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import { findActiveWord, type ActiveWord } from '@/components/autocomplete/findActiveWord';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { type ModelPickerProbeState } from '@/components/model/ModelPickerOverlay';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    useSessionMessagesById,
    useSessionMessagesReducerState,
    useSessionMessagesVersion,
    useSessionTranscriptIds,
    useSetting,
} from '@/sync/domains/state/storage';
import { useUserMessageHistory } from '@/hooks/session/useUserMessageHistory';
import { Theme } from '@/theme';
import { t } from '@/text';

import { Metadata } from '@/sync/domains/state/storageTypes';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { DEFAULT_AGENT_ID, getAgentBehavior, getAgentCore, resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputScrollableChipRow } from './layout/AgentInputScrollableChipRow';
import { PathAndResumeRow } from './layout/PathAndResumeRow';
import {
    getHasAnyAgentInputActions,
    resolveAgentInputActionBarLayout,
    shouldShowSecondaryControlRow,
} from './layout/actionBarLogic';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    clampNumber,
    computeAgentInputDefaultMaxHeight,
    computeAgentInputKeyboardOpenVariableSectionMaxHeight,
    computeMeasuredPanelInputMaxHeight,
} from './inputMaxHeight';
import { getContextUsageState } from './contextWarning';
import { resolveContextWindowTokens } from './resolveContextWarningWindowTokens';
import { shouldRenderPermissionChip } from './permissionChipVisibility';
import { type AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import { AgentInputEngineDetail } from './components/AgentInputEngineDetail';
import { AgentInputContextUsageBadge } from './components/AgentInputContextUsageBadge';
import { mergeOptionPickerProbes } from '@/components/sessions/pickers/mergeOptionPickerProbes';
import { AgentInputAttachmentsRow } from './components/AgentInputAttachmentsRow';
import { AgentInputOverlayLayer } from './components/AgentInputOverlayLayer';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import type { PermissionModePickerStyles } from './components/permissionModePickerStyles';
import { AgentInputAttentionRequests } from './components/AgentInputPermissionRequests';
import { AgentInputSubmitButton } from './components/AgentInputSubmitButton';
import {
    DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
    resolveChipOptionInteraction,
    shouldRenderChipForOptions,
} from './chipOptionInteraction';
import { resolveSessionModeChipPresentation } from './controls/resolveSessionModeChipPresentation';
import { useAgentInputActionMenuControls } from './controls/useAgentInputActionMenuControls';
import { useAgentInputCoreControlHandlers } from './controls/useAgentInputCoreControlHandlers';
import { useRenderedAgentInputControlRows } from './controls/useRenderedAgentInputControlRows';
import { buildAgentInputSelectionOverlayViewModel } from './selection/buildAgentInputSelectionOverlayViewModel';
import { useAgentInputSelectionAnchors } from './selection/useAgentInputSelectionAnchors';
import { useAgentInputSelectionOverlayController } from './selection/useAgentInputSelectionOverlayController';
import { computeSessionModePickerControl } from '@/sync/acp/sessionModeControl';
import {
    computeAcpConfigOptionControls,
    computeAcpConfigOptionControlsFromOverride,
    type AcpConfigOption,
    type AcpConfigOptionValueId,
} from '@/sync/acp/configOptionsControl';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { Text } from '@/components/ui/text/Text';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { resolveApprovalToolCallLocations } from '@/utils/sessions/approvals/resolveApprovalToolCallLocations';
import {
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { buildSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { WebDropTargetView } from '@/components/sessions/files/repositoryTree/WebDropTargetView';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { useLocalSetting } from '@/sync/store/hooks';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type {
    AgentInputAttachment,
    AgentInputComposerAttachmentBadge,
    AgentInputExtraActionChip,
    AgentInputStatusBadge as AgentInputStatusBadgeDescriptor,
} from './agentInputContracts';
import { AgentInputStatusBadge } from './status/AgentInputStatusBadge';
import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { insertTextAtSelection } from './insertTextAtSelection';
import { subscribeToIosHardwareShiftEnter } from './subscribeToIosHardwareShiftEnter';
import {
    buildStructuredInputMetaOverrides,
    createStructuredInputMentionFromSuggestion,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from './structuredInputMentions';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import {
    COMPOSER_ABORT_CONFIRMATION_WINDOW_MS,
    resolveComposerEnterAction,
    resolveComposerEscapeAction,
    resolveComposerSendShortcutAction,
    shouldRunComposerModeCycleShortcut,
} from '@/keyboard/composer';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';

const NATIVE_ACTION_CHIP_GAP_Y = 1;
const NATIVE_ACTION_BAR_SECTION_GAP_Y = 0;
const WEB_ACTION_BAR_ROW_GAP_Y = 0;
const WEB_ACTION_BAR_ROW_GAP_MOBILE_Y = 0;
const ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT = 30;
const EMPTY_PERMISSION_LOCATIONS_BY_ID = new Map<string, PermissionToolCallMessageLocation | null>();
const HISTORY_INPUT_PROGRAMMATIC_STATE_NOTIFICATION_BUDGET = 2;

const AGENT_INPUT_TEST_IDS = {
    sessionInput: 'session-composer-input',
    sessionSend: 'session-composer-send',
    newSessionInput: 'new-session-composer-input',
    newSessionSend: 'new-session-composer-send',
    connectionStatusText: 'agent-input-connection-status-text',
} as const;

export type AgentInputAutocompleteSelectionResult =
    | Readonly<{ handled: false }>
    | Readonly<{ handled: true; text: string; cursorPosition: number }>;

export type AgentInputAutocompleteSelectionHandler = (args: Readonly<{
    suggestion: AutocompleteSuggestion;
    inputText: string;
    selection: Readonly<{ start: number; end: number }>;
    activeWord: ActiveWord | null;
}>) => AgentInputAutocompleteSelectionResult | Promise<AgentInputAutocompleteSelectionResult>;

function normalizeLayoutHeightPx(height: number): number {
    return Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
}

function updateNullableLayoutHeight(
    setHeight: React.Dispatch<React.SetStateAction<number | null>>,
    height: number,
): void {
    const nextHeight = normalizeLayoutHeightPx(height);
    setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
}

function updateLayoutHeight(
    setHeight: React.Dispatch<React.SetStateAction<number>>,
    height: number,
): void {
    const nextHeight = normalizeLayoutHeightPx(height);
    setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
}

type ProgrammaticHistoryInputState = Readonly<{
    state: TextInputState;
    remainingStateNotifications: number;
}>;

function resolveHistoryKeyInputState(event: KeyPressEvent, fallback: TextInputState): TextInputState {
    return event.inputState ?? fallback;
}

function scheduleAfterSynchronousInputStateNotifications(callback: () => void) {
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(callback);
        return;
    }
    setTimeout(callback, 0);
}

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: (options?: Readonly<{
        forceImmediate?: boolean;
        deliveryIntent?: 'server_pending';
        structuredInputMetaOverrides?: Record<string, unknown>;
    }>) => void;
    submitAccessibilityLabel?: string;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onPermissionClick?: () => void;
    onAcpSessionModeChange?: (modeId: string) => void;
    /**
     * Optional override for ACP "session mode" picker options (e.g. OpenCode plan/build).
     *
     * Used by new-session flows to surface ACP modes before a session exists.
     */
    acpSessionModeOptionsOverride?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    /**
     * Optional selected ACP mode when using `acpSessionModeOptionsOverride`.
     *
     * When null/empty, the UI should behave like "Default" (no override).
     */
    acpSessionModeSelectedIdOverride?: string | null;
    /**
     * Optional: show a probe/loading state + refresh control in the ACP mode picker.
     */
    acpSessionModeOptionsOverrideProbe?: ModelPickerProbeState;
    acpConfigOptionsOverride?: ReadonlyArray<AcpConfigOption>;
    acpConfigOptionsOverrideProbe?: ModelPickerProbeState;
    acpConfigOptionOverridesOverride?: AcpConfigOptionOverridesV1 | null;
    onAcpConfigOptionChange?: (configId: string, valueId: AcpConfigOptionValueId) => void;
    modelMode?: ModelMode;
    onModelModeChange?: (mode: ModelMode) => void;
    /**
     * Optional override for model picker options.
     *
     * Used by new-session flows to display preflight/probed model lists before a session exists.
     */
    modelOptionsOverride?: readonly ModelOption[];
    /**
     * Optional: show a probe/loading state + refresh control in the model picker.
     * Intended for preflight (no-session) flows that dynamically probe models.
     */
    modelOptionsOverrideProbe?: ModelPickerProbeState;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    };
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<AutocompleteSuggestion[]>;
    onAutocompleteSuggestionSelect?: AgentInputAutocompleteSelectionHandler;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowTokens?: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: AgentId;
    agentLabel?: string | null;
    onAgentClick?: () => void;
    agentPickerTitle?: string;
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    agentPickerSelectedOptionId?: string | null;
    onAgentPickerSelect?: (id: string) => void;
    agentPickerApplyLabel?: string;
    agentPickerProbe?: OptionPickerProbeState;
    machineName?: string | null;
    onMachineClick?: () => void;
    machinePopover?: AgentInputContentPopoverConfig;
    currentPath?: string | null;
    onPathClick?: () => void;
    pathPopover?: AgentInputContentPopoverConfig;
    resumeSessionId?: string | null;
    onResumeClick?: () => void;
    resumePopover?: AgentInputContentPopoverConfig;
    resumeIsChecking?: boolean;
    isSendDisabled?: boolean;
    isSending?: boolean;
    disabled?: boolean;
    minHeight?: number;
    inputMaxHeight?: number;
    inputExpansion?: Readonly<{
        expanded: boolean;
        collapsedMaxHeight?: number;
        onToggle: () => void;
    }>;
    maxPanelHeight?: number;
    profileId?: string | null;
    onProfileClick?: () => void;
    profilePopover?: AgentInputContentPopoverConfig;
    envVarsCount?: number;
    onEnvVarsClick?: () => void;
    envVarsPopover?: AgentInputContentPopoverConfig;
    contentPaddingHorizontal?: number;
    panelStyle?: ViewStyle;
    maxWidthCap?: number | null;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    attachments?: ReadonlyArray<AgentInputAttachment>;
    onAttachmentsAdded?: (files: readonly File[]) => void;
    hasSendableAttachments?: boolean;
    permissionRequests?: ReadonlyArray<PendingPermissionRequest>;
    userActionRequests?: ReadonlyArray<PendingPermissionRequest>;
    approvalRequests?: ReadonlyArray<OpenApprovalArtifactForSession>;
    canApprovePermissions?: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
}

function AgentInputAttentionRequestsWithLocations(
    props: Omit<React.ComponentProps<typeof AgentInputAttentionRequests>, 'permissionLocationsById' | 'approvalLocationsByArtifactId'>
) {
    const { ids: committedMessageIdsOldestFirst } = useSessionTranscriptIds(props.sessionId);
    const committedMessagesById = useSessionMessagesById(props.sessionId);
    const committedMessagesReducerState = useSessionMessagesReducerState(props.sessionId);
    const permissionLocationVersion = useSessionMessagesVersion(props.sessionId, props.permissionRequests.length > 0);
    const approvalLocationVersion = useSessionMessagesVersion(props.sessionId, (props.approvalRequests?.length ?? 0) > 0);

    const permissionLocationsById = React.useMemo(() => {
        if (props.permissionRequests.length === 0) {
            return EMPTY_PERMISSION_LOCATIONS_BY_ID;
        }

        const ids = props.permissionRequests.map((request) => request.id);
        return new Map(
            resolvePermissionToolCallLocations({
                permissionIds: ids,
                messageIdsOldestFirst: committedMessageIdsOldestFirst,
                messagesById: committedMessagesById,
                resolveRouteMessageId: (messageId, _message) =>
                    buildSessionMessageRouteId({
                        messageId,
                        messagesById: committedMessagesById,
                        reducerState: committedMessagesReducerState,
                    }),
            }),
        );
    }, [
        committedMessageIdsOldestFirst,
        committedMessagesById,
        committedMessagesReducerState,
        permissionLocationVersion,
        props.permissionRequests,
    ]);

    const approvalLocationsByArtifactId = React.useMemo(() => {
        const approvalRequests = props.approvalRequests ?? [];
        if (approvalRequests.length === 0) {
            return EMPTY_PERMISSION_LOCATIONS_BY_ID;
        }

        return new Map(
            resolveApprovalToolCallLocations({
                approvals: approvalRequests.map((entry) => ({
                    artifactId: entry.artifact.id,
                    approval: entry.approval,
                })),
                sessionId: props.sessionId,
                messageIdsOldestFirst: committedMessageIdsOldestFirst,
                messagesById: committedMessagesById,
                resolveRouteMessageId: (messageId, _message) =>
                    buildSessionMessageRouteId({
                        messageId,
                        messagesById: committedMessagesById,
                        reducerState: committedMessagesReducerState,
                    }),
            }),
        );
    }, [
        approvalLocationVersion,
        committedMessageIdsOldestFirst,
        committedMessagesById,
        committedMessagesReducerState,
        props.approvalRequests,
        props.sessionId,
    ]);

    return (
        <AgentInputAttentionRequests
            {...props}
            permissionLocationsById={permissionLocationsById}
            approvalLocationsByArtifactId={approvalLocationsByArtifactId}
        />
    );
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        width: '100%',
        paddingBottom: 8,
        paddingTop: 8,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.surface,
            highlightColor: theme.colors.effect.surfaceHighlight,
        }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        position: 'relative',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },
    nativeKeyboardPanelContent: {
        minHeight: 0,
    },
    nativeKeyboardVariableSection: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
    nativeKeyboardVariableSectionContent: {
        paddingBottom: 4,
    },
    webVariableSectionEdgeToEdge: {
        marginHorizontal: -8,
    },
    webVariableSectionContentInset: {
        paddingHorizontal: 8,
    },
    nativeKeyboardFooterSection: {
        flexShrink: 0,
    },

    // Overlay styles
    settingsOverlay: {
        // positioning is handled by `Popover`
    },
    overlaySection: {
        paddingVertical: 16,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    overlayInlineRefreshButton: {
        minWidth: 30,
        height: 30,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: 'transparent',
    },
    overlayInlineRefreshButtonPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    overlayInlineRefreshButtonDisabled: {
        opacity: 0.6,
    },
    overlayEffectivePolicy: {
        paddingHorizontal: 16,
        paddingTop: 2,
        paddingBottom: 8,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text.primary,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        flex: 1,
    },
    statusText: {
        fontSize: 11,
        marginRight: 8,
        ...Typography.default(),
    },
    statusDot: {
        marginRight: 6,
    },
    statusTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 12,
    },
    inputExpansionToggle: {
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 2,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputExpansionTogglePressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },
    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsColumn: {
        flexDirection: 'column',
        flex: 1,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_Y } : {}),
    },
    actionButtonsColumnMobile: {
        flexDirection: 'column',
        flex: 1,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_MOBILE_Y } : {}),
    },
    actionButtonsColumnNarrow: {
        flexDirection: 'column',
        flex: 1,
        ...(Platform.OS === 'web' ? { gap: WEB_ACTION_BAR_ROW_GAP_Y } : {}),
    },
    actionButtonsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    actionButtonsRowWithBelow: {
        // Match the vertical rhythm of wrapped chip rows on native.
        marginBottom: Platform.OS === 'web' ? 0 : NATIVE_ACTION_BAR_SECTION_GAP_Y,
    },
    pathRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        ...(Platform.OS === 'web' ? { columnGap: 6, rowGap: 1 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
        flex: 1,
        flexWrap: 'wrap',
        overflow: 'visible',
    },
    actionButtonsLeftScroll: {
        flex: 1,
        overflow: 'visible',
    },
    actionButtonsSecondaryScroll: {
        alignSelf: 'stretch',
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 32,
        overflow: 'visible',
    },
    actionButtonsScrollViewportContent: {
        paddingRight: ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT,
    },
    actionButtonsLeftScrollInline: {
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? { columnGap: 6 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionButtonsLeftScrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? { columnGap: 6 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
        paddingRight: ACTION_BAR_SCROLL_CONTENT_PADDING_RIGHT,
    },
    actionButtonsFadeLeft: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 24,
        zIndex: 2,
    },
    actionButtonsFadeRight: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 24,
        zIndex: 2,
    },
    actionButtonsLeftNarrow: {
        columnGap: 4,
    },
    actionButtonsLeftNoFlex: {
        flex: 0,
    },
    actionItemWrapper: {
        // Non-chip action items (e.g. SCM status) should align with chips on native.
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionChip: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 10,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
        gap: 6,
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionChipText: {
        fontSize: 13,
        color: theme.colors.button.secondary.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    actionChipCountText: {
        color: theme.colors.text.tertiary,
    },
    overlayOptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    overlayOptionRowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    overlayRadioOuter: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    overlayRadioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    overlayRadioOuterUnselected: {
        borderColor: theme.colors.radio.inactive,
    },
    overlayRadioInner: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    overlayOptionLabel: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    overlayOptionLabelSelected: {
        color: theme.colors.radio.active,
    },
    overlayOptionLabelUnselected: {
        color: theme.colors.text.primary,
    },
    overlayOptionDescription: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    overlayEmptyText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        ...Typography.default(),
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
        // Keep vertical alignment consistent with `actionChip` on native.
        ...(Platform.OS === 'web' ? {} : { marginRight: 6, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    fileDropOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.overlay.scrim,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: Platform.select({ default: 16, android: 20 }),
    },
    fileDropOverlayContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    fileDropOverlayText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    sessionInputText: {
        fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
    },
    newSessionInputText: {
        fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
    },
}));

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const voiceEnabled = useFeatureEnabled('voice');
    const uiBackdropBlurEnabled = useLocalSetting('uiBackdropBlurEnabled') !== false;
    const keyboardShortcutsV2Enabled = useSetting('keyboardShortcutsV2Enabled') === true;
    const keyboardSingleKeyShortcutsEnabled = useSetting('keyboardSingleKeyShortcutsEnabled') === true;
    const keyboardShortcutOverridesV1 = useSetting('keyboardShortcutOverridesV1') ?? {};
    const keyboardShortcutDisabledCommandIdsV1 = useSetting('keyboardShortcutDisabledCommandIdsV1') ?? [];
    const renderIoniconNode = React.useCallback(
        (
            name: React.ComponentProps<typeof Ionicons>['name'],
            size: number,
            color: string,
            style?: React.ComponentProps<typeof Ionicons>['style'],
        ) => normalizeNodeForView(<Ionicons name={name} size={size} color={color} style={style} />),
        [],
    );
    const renderOcticonNode = React.useCallback(
        (
            name: React.ComponentProps<typeof Octicons>['name'],
            size: number,
            color: string,
            style?: React.ComponentProps<typeof Octicons>['style'],
        ) => normalizeNodeForView(<Octicons name={name} size={size} color={color} style={style} />),
        [],
    );

    const defaultInputMaxHeight = React.useMemo(() => {
        return computeAgentInputDefaultMaxHeight({
            platform: Platform.OS,
            screenHeight,
            keyboardHeight: 0,
        });
    }, [screenHeight]);
    // Native-only: the native composer is position:absolute; bottom:0 and floats free,
    // so it needs an explicit panel maxHeight to stay above the keyboard. On web/Tauri the
    // composer is laid out inside a flex column (ComposerKeyboardScaffold.web), so it is
    // already viewport-bounded. Applying a web cap derived from the existing-session
    // `maxPanelHeight` (which can be `undefined` on the first frame and a measured number
    // shortly after) would re-constrain the panel from unconstrained to constrained during
    // session switches. Keep web unconstrained.
    const hostPanelMaxHeight = Platform.OS === 'web' ? undefined : props.maxPanelHeight;
    const [rootHeightPx, setRootHeightPx] = React.useState<number | null>(null);
    const [panelHeightPx, setPanelHeightPx] = React.useState<number | null>(null);
    const [inputContainerHeightPx, setInputContainerHeightPx] = React.useState<number | null>(null);
    const [inputViewportHeightPx, setInputViewportHeightPx] = React.useState<number | null>(null);
    const [inputContentHeightPx, setInputContentHeightPx] = React.useState<number | null>(null);
    const [actionFooterHeightPx, setActionFooterHeightPx] = React.useState<number>(0);
    const [composerAttentionHeightPx, setComposerAttentionHeightPx] = React.useState<number>(0);
    const effectivePanelMaxHeight = React.useMemo(() => {
        if (typeof hostPanelMaxHeight !== 'number') return undefined;
        const nonPanelChromeHeight = rootHeightPx != null && panelHeightPx != null
            ? Math.max(0, rootHeightPx - panelHeightPx)
            : 0;
        return Math.max(0, hostPanelMaxHeight - nonPanelChromeHeight);
    }, [hostPanelMaxHeight, panelHeightPx, rootHeightPx]);
    const panelVariableSectionMaxHeight = React.useMemo(() => {
        if (typeof effectivePanelMaxHeight !== 'number') return undefined;
        return computeAgentInputKeyboardOpenVariableSectionMaxHeight({
            panelMaxHeight: effectivePanelMaxHeight,
            footerHeight: actionFooterHeightPx + composerAttentionHeightPx,
        });
    }, [actionFooterHeightPx, composerAttentionHeightPx, effectivePanelMaxHeight]);
    const fallbackInputMaxHeight = props.inputMaxHeight ?? defaultInputMaxHeight;
    const resolvedInputMaxHeight = React.useMemo(() => {
        return computeMeasuredPanelInputMaxHeight({
            panelMaxHeight: effectivePanelMaxHeight,
            panelHeight: panelHeightPx,
            inputContainerHeight: inputContainerHeightPx,
            inputViewportHeight: inputViewportHeightPx,
            fallbackMaxHeight: fallbackInputMaxHeight,
            fallbackMaxHeightMode: props.sessionId ? 'cap' : 'seed',
        });
    }, [
        fallbackInputMaxHeight,
        effectivePanelMaxHeight,
        inputContainerHeightPx,
        inputViewportHeightPx,
        panelHeightPx,
        props.sessionId,
    ]);
    const inputExpansionCollapsedMaxHeight = typeof props.inputExpansion?.collapsedMaxHeight === 'number'
        && Number.isFinite(props.inputExpansion.collapsedMaxHeight)
        && props.inputExpansion.collapsedMaxHeight > 0
        ? props.inputExpansion.collapsedMaxHeight
        : null;
    const shouldShowInputExpansionToggle = Boolean(
        props.inputExpansion
        && inputExpansionCollapsedMaxHeight != null
        && inputContentHeightPx != null
        && inputContentHeightPx > inputExpansionCollapsedMaxHeight + 1,
    );
    const composerAnchorRef = React.useRef<View>(null);
    const hasText = props.value.trim().length > 0;
    const hasSendableContent = hasText || props.hasSendableAttachments === true;
    const micPressHandler = voiceEnabled ? props.onMicPress : undefined;
    const micActive = voiceEnabled && props.isMicActive === true;
    const [fileDragActive, setFileDragActive] = React.useState(false);

    const pendingPermissionRequests = props.permissionRequests ?? [];
    const pendingUserActionRequests = props.userActionRequests ?? [];
    const pendingApprovalRequests = props.approvalRequests ?? [];
    const canApprovePermissions = props.canApprovePermissions ?? true;
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const resolvedPermissionPromptSurface = resolvePermissionPromptSurface(permissionPromptSurface);
    const showComposerPermissionCards = resolvedPermissionPromptSurface === 'composer';
    const composerPermissionRequests = React.useMemo(
        () => pendingPermissionRequests.filter((req) => shouldShowGenericPermissionPromptForRequest({ toolName: req.tool, requestKind: req.kind })),
        [pendingPermissionRequests],
    );
    const hasComposerAttentionRequests = Boolean(
        props.sessionId
        && showComposerPermissionCards
        && (
            composerPermissionRequests.length > 0
            || pendingUserActionRequests.length > 0
            || pendingApprovalRequests.length > 0
        ),
    );

    React.useEffect(() => {
        if (!hasComposerAttentionRequests) {
            updateLayoutHeight(setComposerAttentionHeightPx, 0);
        }
    }, [hasComposerAttentionRequests]);
    const agentId: AgentId = resolveAgentIdFromFlavor(props.metadata?.flavor) ?? props.agentType ?? DEFAULT_AGENT_ID;
    const lastNonEmptySessionModelOptionsRef = React.useRef<readonly ModelOption[] | null>(null);
    React.useEffect(() => {
        lastNonEmptySessionModelOptionsRef.current = null;
    }, [agentId, props.sessionId]);

    const sessionModelsState = React.useMemo(() => {
        if (props.modelOptionsOverride) return { hasSessionModelsState: false, availableCount: 0 };
        const raw = readSessionModelsState(props.metadata ?? null);
        const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : '';
        if (!provider || provider !== agentId) return { hasSessionModelsState: false, availableCount: 0 };
        const available = Array.isArray(raw?.availableModels) ? raw.availableModels : [];
        return { hasSessionModelsState: true, availableCount: available.length };
    }, [agentId, props.metadata, props.modelOptionsOverride]);

    const baseModelOptions = React.useMemo(() => {
        if (props.modelOptionsOverride) return props.modelOptionsOverride;
        return getModelOptionsForSession(agentId, props.metadata ?? null);
    }, [agentId, props.metadata, props.modelOptionsOverride]);

    const modelOptions = React.useMemo(() => {
        if (props.modelOptionsOverride) return baseModelOptions;
        if (sessionModelsState.hasSessionModelsState && sessionModelsState.availableCount === 0) {
            const sticky = lastNonEmptySessionModelOptionsRef.current;
            if (sticky && sticky.length > 0) return sticky;
        }
        return baseModelOptions;
    }, [baseModelOptions, props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    const sessionModelOptionsProbe = React.useMemo<ModelPickerProbeState | null>(() => {
        if (props.modelOptionsOverride) return null;
        if (!sessionModelsState.hasSessionModelsState) return null;
        if (sessionModelsState.availableCount > 0) return null;
        const phase: ModelPickerProbeState['phase'] = lastNonEmptySessionModelOptionsRef.current ? 'refreshing' : 'loading';
        return { phase };
    }, [props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    React.useEffect(() => {
        if (props.modelOptionsOverride) return;
        if (!sessionModelsState.hasSessionModelsState) {
            lastNonEmptySessionModelOptionsRef.current = null;
            return;
        }
        if (sessionModelsState.availableCount > 0 && modelOptions.length > 0) {
            lastNonEmptySessionModelOptionsRef.current = modelOptions;
        }
    }, [modelOptions, props.modelOptionsOverride, sessionModelsState.availableCount, sessionModelsState.hasSessionModelsState]);

    // Profile data
    const profiles = useSetting('profiles');
    const currentProfile = React.useMemo(() => {
        if (props.profileId === undefined || props.profileId === null || props.profileId.trim() === '') {
            return null;
        }
        return resolveProfileById(props.profileId, profiles);
    }, [profiles, props.profileId]);

        const profileLabel = React.useMemo(() => {
            if (props.profileId === undefined) {
                return null;
            }
            if (props.profileId === null || props.profileId.trim() === '') {
                return t('profiles.noProfile');
            }
        if (currentProfile) {
            return getProfileDisplayName(currentProfile);
        }
        const shortId = props.profileId.length > 8 ? `${props.profileId.slice(0, 8)}…` : props.profileId;
        return `${t('status.unknown')} (${shortId})`;
        }, [props.profileId, currentProfile]);

            const profileIcon = React.useMemo(() => {
                // Always show a stable "profile" icon so the chip reads as Profile selection (not "current provider").
                return 'person-circle-outline';
            }, []);

    const supportsExactContextUsageBadge = React.useMemo(
        () => getAgentBehavior(agentId).sessionUsage?.supportsExactContextUsageBadge !== false,
        [agentId],
    );

    const contextWindowTokens = React.useMemo(
        () => (
            supportsExactContextUsageBadge
                ? resolveContextWindowTokens({ agentId, metadata: props.metadata ?? null, usageData: props.usageData })
                : null
        ),
        [agentId, props.metadata, props.usageData, supportsExactContextUsageBadge],
    );

    const contextUsageState = supportsExactContextUsageBadge && (
        (props.usageData && typeof props.usageData.contextSize === 'number')
        || props.alwaysShowContextSize === true
    )
        ? getContextUsageState(
            props.usageData?.contextSize ?? 0,
            props.alwaysShowContextSize ?? false,
            contextWindowTokens,
        )
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');
    const agentInputEnterToSendNative = useSetting('agentInputEnterToSendNative');
    const enterToSendEnabled = Platform.OS === 'web'
        ? agentInputEnterToSend === true
        : agentInputEnterToSendNative === true;
    const agentInputHistoryScope = useSetting('agentInputHistoryScope');
    const agentInputActionBarLayout = useSetting('agentInputActionBarLayout');
    const agentInputChipDensity = useSetting('agentInputChipDensity');
    const sessionPermissionModeApplyTiming = useSetting('sessionPermissionModeApplyTiming');

    const historyScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const messageHistory = useUserMessageHistory({
        scope: historyScope,
        sessionId: props.sessionId ?? null,
    });

    const sendActionDisabled = Boolean(props.disabled || props.isSendDisabled || props.isSending);
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: props.value.length, end: props.value.length }
    });
    const inputStateRef = React.useRef(inputState);
    const [structuredInputMentions, setStructuredInputMentions] = React.useState<ComposerStructuredInputMention[]>([]);
    const historyAppliedInputStateRef = React.useRef<ProgrammaticHistoryInputState | null>(null);

    const isHistoryBrowsing = React.useCallback(() => (
        typeof messageHistory.isBrowsing === 'function' && messageHistory.isBrowsing()
    ), [messageHistory]);

    const hasRetainedHistorySession = React.useCallback(() => (
        typeof messageHistory.hasRetainedSession === 'function' && messageHistory.hasRetainedSession()
    ), [messageHistory]);

    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        const previousText = inputStateRef.current.text;
        const historyAppliedInputState = historyAppliedInputStateRef.current;
        const isProgrammaticHistoryApply =
            historyAppliedInputState !== null
            && historyAppliedInputState.state.text === newState.text
            && historyAppliedInputState.remainingStateNotifications > 0;
        if (isProgrammaticHistoryApply) {
            const remainingStateNotifications = historyAppliedInputState.remainingStateNotifications - 1;
            historyAppliedInputStateRef.current = remainingStateNotifications > 0
                ? { ...historyAppliedInputState, remainingStateNotifications }
                : null;
        } else if (hasRetainedHistorySession()) {
            historyAppliedInputStateRef.current = null;
            messageHistory.pause(newState.text);
        }
        setStructuredInputMentions((current) => reconcileStructuredInputMentionsWithText({
            previousText,
            nextText: newState.text,
            mentions: current,
        }));
        inputStateRef.current = newState;
        setInputState(newState);
    }, [hasRetainedHistorySession, messageHistory]);

    React.useEffect(() => {
        historyAppliedInputStateRef.current = null;
    }, [props.sessionId, historyScope]);

    React.useEffect(() => {
        inputStateRef.current = inputState;
    }, [inputState]);

    React.useEffect(() => {
        const current = inputStateRef.current;
        if (current.text === props.value) return;

        const nextSelection = {
            start: Math.min(current.selection.start, props.value.length),
            end: Math.min(current.selection.end, props.value.length),
        };
        const nextState = {
            text: props.value,
            selection: nextSelection,
        };
        inputStateRef.current = nextState;
        setInputState(nextState);
    }, [props.value]);

    React.useEffect(() => {
        if (props.value.length === 0) {
            setStructuredInputMentions([]);
        }
    }, [props.value]);

    const handleSend = React.useCallback((options?: Readonly<{ forceImmediate?: boolean; deliveryIntent?: 'server_pending' }>) => {
        if (sendActionDisabled) {
            return;
        }
        if (props.sessionId) {
            inputRef.current?.blur();
        }
        if (props.sessionId && props.value.trim().length > 0 && props.hasSendableAttachments !== true) {
            // Clear immediately for existing sessions so Enter-to-send doesn't leave stale text behind
            // if the input emits a late change event after the send action.
            props.onChangeText('');
        }
        messageHistory.reset();
        const structuredInputMetaOverrides = buildStructuredInputMetaOverrides({
            mentions: structuredInputMentions,
            text: inputStateRef.current.text,
        });
        const hasStructuredInputMeta = Object.keys(structuredInputMetaOverrides).length > 0;
        props.onSend(
            options?.forceImmediate === true || options?.deliveryIntent != null || hasStructuredInputMeta
                ? {
                    ...(options?.forceImmediate === true ? { forceImmediate: true } : {}),
                    ...(options?.deliveryIntent != null ? { deliveryIntent: options.deliveryIntent } : {}),
                    ...(hasStructuredInputMeta ? { structuredInputMetaOverrides } : {}),
                }
                : undefined,
        );
    }, [
        messageHistory,
        props.hasSendableAttachments,
        props.onChangeText,
        props.onSend,
        props.sessionId,
        props.value,
        sendActionDisabled,
        structuredInputMentions,
    ]);

    const effectiveChipDensity = React.useMemo<'auto' | 'labels' | 'icons'>(() => {
        if (agentInputChipDensity === 'icons') {
            return 'icons';
        }
        if (agentInputChipDensity === 'labels') {
            return 'labels';
        }
        // auto: selectively hide labels for self-explanatory chips.
        return 'auto';
    }, [agentInputChipDensity]);

    const effectiveActionBarLayout = React.useMemo<'wrap' | 'scroll' | 'collapsed'>(() => {
        return resolveAgentInputActionBarLayout({
            configuredLayout: agentInputActionBarLayout,
            platform: Platform.OS,
            isMobileLayout: isMobileLayoutWidth(screenWidth),
        });
    }, [agentInputActionBarLayout, screenWidth]);

    // In labels mode: always show; in icons mode: never show; in auto: show for 'always' policy chips.
    const showChipLabels = effectiveChipDensity === 'labels' || effectiveChipDensity === 'auto';
    const showAutoHideChipLabels = effectiveChipDensity === 'labels';


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const abortConfirmationExpiresAtRef = React.useRef(0);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const [isInputFocused, setIsInputFocused] = React.useState(false);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    const handleComposerFocus = React.useCallback(() => {
        setIsInputFocused(true);
        messageHistory.warmup();
    }, [messageHistory]);

    const handleComposerBlur = React.useCallback(() => {
        setIsInputFocused(false);
    }, []);

    const applyHistoryInputText = React.useCallback((next: string) => {
        const nextState = { text: next, selection: { start: next.length, end: next.length } };
        const setTextAndSelection = inputRef.current?.setTextAndSelection;
        if (setTextAndSelection) {
            const pendingHistoryApply: ProgrammaticHistoryInputState = {
                state: nextState,
                remainingStateNotifications: HISTORY_INPUT_PROGRAMMATIC_STATE_NOTIFICATION_BUDGET,
            };
            historyAppliedInputStateRef.current = pendingHistoryApply;
            setTextAndSelection(next, nextState.selection);
            scheduleAfterSynchronousInputStateNotifications(() => {
                if (historyAppliedInputStateRef.current === pendingHistoryApply) {
                    historyAppliedInputStateRef.current = null;
                }
            });
        } else {
            props.onChangeText(next);
        }
    }, [props.onChangeText]);

    React.useEffect(() => {
        if (Platform.OS !== 'ios' || !enterToSendEnabled || !isInputFocused || props.disabled) {
            return;
        }

        const subscription = subscribeToIosHardwareShiftEnter(() => {
            const nextState = insertTextAtSelection({
                text: inputStateRef.current.text,
                selection: inputStateRef.current.selection,
                insertedText: '\n',
            });

            inputRef.current?.setTextAndSelection(nextState.text, nextState.selection);
        });

        return () => {
            subscription?.remove();
        };
    }, [enterToSendEnabled, isInputFocused, props.disabled]);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];
        const activeWordForSelection = findActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
        const insertionStart = activeWordForSelection?.offset ?? inputState.selection.start;

        const applyResolvedSelection = (result: Readonly<{ text: string; cursorPosition: number }>) => {
            inputRef.current?.setTextAndSelection(result.text, {
                start: result.cursorPosition,
                end: result.cursorPosition
            });
        };

        const applyDefaultSelection = () => {
            const result = applySuggestion(
                inputState.text,
                inputState.selection,
                suggestion.text,
                props.autocompletePrefixes,
                true
            );
            applyResolvedSelection(result);

            const mention = createStructuredInputMentionFromSuggestion({ suggestion, start: insertionStart });
            if (mention) {
                setStructuredInputMentions((current) => [
                    ...current.filter((existing) => existing.start !== mention.start || existing.end !== mention.end),
                    mention,
                ]);
            }
        };

        const override = props.onAutocompleteSuggestionSelect?.({
            suggestion,
            inputText: inputState.text,
            selection: inputState.selection,
            activeWord: activeWordForSelection ?? null,
        });

        if (override) {
            void Promise.resolve(override).then((result) => {
                if (result.handled) {
                    applyResolvedSelection(result);
                } else {
                    applyDefaultSelection();
                }
                hapticsLight();
            });
            return;
        }

        applyDefaultSelection();
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes, props.onAutocompleteSuggestionSelect]);

    const permissionRequestsFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });
    const permissionRequestsMaxHeightPx = React.useMemo(() => {
        const available = Math.max(1, props.maxPanelHeight ?? screenHeight);
        const desired = Math.round(available * 0.34);
        return clampNumber(desired, 160, Math.min(320, available));
    }, [props.maxPanelHeight, screenHeight]);

            const permissionModeOptions = React.useMemo(() => {
                return getPermissionModeOptionsForSession(agentId, props.metadata ?? null);
            }, [agentId, props.metadata]);

        const permissionModeOrder = React.useMemo(() => {
            return permissionModeOptions.map((o) => o.value);
        }, [permissionModeOptions]);

    const effectivePermissionPolicy = React.useMemo(() => {
                return describeEffectivePermissionMode({
                    agentType: agentId,
                    selectedMode: props.permissionMode ?? 'default',
                metadata: props.metadata ?? null,
                applyTiming: sessionPermissionModeApplyTiming ?? 'immediate',
            });
    }, [agentId, props.metadata, props.permissionMode, sessionPermissionModeApplyTiming]);

    const effectiveModelPolicy = React.useMemo(() => {
        return describeEffectiveModelMode({
            agentType: agentId,
            selectedModelId: props.modelMode ?? 'default',
            metadata: props.metadata ?? null,
        });
    }, [agentId, props.metadata, props.modelMode]);

    const effectiveModelLabel = React.useMemo(() => {
        const found = modelOptions.find((o) => o.value === effectiveModelPolicy.effectiveModelId);
        if (found) return found.label;
        return effectiveModelPolicy.effectiveModelId === 'default'
            ? t('agentInput.model.useCliSettings')
            : effectiveModelPolicy.effectiveModelId;
    }, [effectiveModelPolicy.effectiveModelId, modelOptions]);

    const canEnterCustomModel = React.useMemo(() => {
        return supportsFreeformModelSelectionForSession(agentId, props.metadata ?? null);
    }, [agentId, props.metadata]);

    const submitCustomModel = React.useCallback((value: string) => {
        const normalized = value.trim();
        if (!normalized) return;
        props.onModelModeChange?.(normalized);
    }, [props.onModelModeChange]);

    const preflightAcpSessionModeOptions = React.useMemo(() => {
        const raw = props.acpSessionModeOptionsOverride;
        if (!Array.isArray(raw) || raw.length === 0) return null;
        const cleaned = raw
            .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m) => ({
                id: String(m.id),
                name: String(m.name),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
            }))
            .filter((m) => m.id.trim().length > 0 && m.name.trim().length > 0);
        return cleaned.length > 0 ? cleaned : null;
    }, [props.acpSessionModeOptionsOverride]);

    const sessionModePickerControl = React.useMemo(() => {
        if (!props.onAcpSessionModeChange) return null;
        // When preflight options are provided (e.g. New Session), prefer the override surface so
        // selections can be reflected immediately without relying on session metadata updates.
        if (preflightAcpSessionModeOptions) return null;
        return computeSessionModePickerControl({ agentId, metadata: props.metadata ?? null });
    }, [agentId, props.metadata, preflightAcpSessionModeOptions, props.onAcpSessionModeChange]);

    const preflightAcpSessionModeEffective = React.useMemo(() => {
        const selected = typeof props.acpSessionModeSelectedIdOverride === 'string'
            ? props.acpSessionModeSelectedIdOverride.trim()
            : '';
        const effectiveId = selected || 'default';
        const opt = preflightAcpSessionModeOptions?.find((o) => o.id === effectiveId) ?? null;
        return { id: effectiveId, name: opt?.name ?? (effectiveId === 'default' ? t('common.default') : effectiveId) };
    }, [preflightAcpSessionModeOptions, props.acpSessionModeSelectedIdOverride]);
    const sessionModeOptionsOverrideProbe = props.acpSessionModeOptionsOverrideProbe ?? null;
    const acpConfigOptionsOverrideProbe = props.acpConfigOptionsOverrideProbe ?? null;

    const sessionModeChipControl = React.useMemo(() => {
        if (!props.onAcpSessionModeChange) return null;
        if (sessionModePickerControl) {
            return {
                options: sessionModePickerControl.options,
                selectedId: (
                    sessionModePickerControl.requestedModeId
                    ?? sessionModePickerControl.effectiveModeId
                    ?? 'default'
                ),
                label: sessionModePickerControl.effectiveModeName,
                isPending: sessionModePickerControl.isPending,
            };
        }
        if (preflightAcpSessionModeOptions) {
            return {
                options: preflightAcpSessionModeOptions,
                selectedId: preflightAcpSessionModeEffective.id,
                label: preflightAcpSessionModeEffective.name,
                isPending: false,
            };
        }
        return null;
    }, [
        preflightAcpSessionModeEffective.id,
        preflightAcpSessionModeEffective.name,
        preflightAcpSessionModeOptions,
        props.onAcpSessionModeChange,
        sessionModePickerControl,
    ]);

    const sessionModePickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!sessionModeChipControl) return [];
        const optionsById = new Map(sessionModeChipControl.options.map((option) => [option.id, option]));
        const uniqueIds = Array.from(
            new Set([
                'default',
                ...sessionModeChipControl.options.map((option) => option.id).filter((id) => id && id !== 'default'),
            ]),
        );
        return uniqueIds.map((id) => ({
            id,
            label: optionsById.get(id)?.name ?? (id === 'default' ? t('common.default') : id),
            subtitle: optionsById.get(id)?.description,
        }));
    }, [sessionModeChipControl]);

    const shouldRenderSessionModeChip = React.useMemo(() => {
        return shouldRenderChipForOptions({
            optionCount: sessionModePickerOptions.length,
            showWhenNoOptions: false,
            showWhenSingleOption: false,
        });
    }, [sessionModePickerOptions.length]);

    const sessionModeChipPresentation = React.useMemo(() => {
        return sessionModeChipControl ? resolveSessionModeChipPresentation(sessionModeChipControl) : null;
    }, [sessionModeChipControl]);

    const sessionModeChipInteraction = React.useMemo(() => {
        if (!sessionModeChipControl) return null;
        const selectableOptionIds = Array.from(new Set(
            sessionModeChipControl.options
                .map((option) => option.id?.trim?.() ?? option.id)
                .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ));
        return resolveChipOptionInteraction({
            currentOptionId: sessionModeChipControl.selectedId,
            selectableOptionIds,
            cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
        });
    }, [sessionModeChipControl]);

    const acpConfigOptionControls = React.useMemo(() => {
        if (!props.onAcpConfigOptionChange) return null;
        if (props.acpConfigOptionsOverride) {
            return computeAcpConfigOptionControlsFromOverride({
                agentId,
                configOptions: props.acpConfigOptionsOverride,
                overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
            });
        }
        return computeAcpConfigOptionControls({ agentId, metadata: props.metadata ?? null });
    }, [
        agentId,
        props.acpConfigOptionsOverride,
        props.acpConfigOptionOverridesOverride,
        props.metadata,
        props.onAcpConfigOptionChange,
    ]);

    const selectedModelOptionControls = React.useMemo(() => {
        if (!props.onAcpConfigOptionChange) return null;
        const selectedModel = modelOptions.find((option) => option.value === effectiveModelPolicy.effectiveModelId) ?? null;
        if (!selectedModel?.modelOptions?.length) return null;
        return computeAcpConfigOptionControlsFromOverride({
            agentId,
            configOptions: selectedModel.modelOptions,
            overrides: props.acpConfigOptionOverridesOverride?.overrides ?? null,
        });
    }, [
        agentId,
        effectiveModelPolicy.effectiveModelId,
        modelOptions,
        props.acpConfigOptionOverridesOverride,
        props.onAcpConfigOptionChange,
    ]);
    const hasSettingsAcpConfigSection = Boolean(acpConfigOptionControls);

    const shouldShowModelOptionDescriptions = React.useMemo(() => {
        return modelOptions.some((option) => {
            if (option.value === 'default') return false;
            return typeof option.description === 'string' && option.description.trim().length > 0;
        });
    }, [modelOptions]);

    const unifiedEnginePickerProbe = React.useMemo<OptionPickerProbeState | undefined>(() => {
        return mergeOptionPickerProbes([
            props.modelOptionsOverrideProbe ?? null,
            sessionModelOptionsProbe ?? null,
            props.agentPickerProbe ?? null,
            sessionModeOptionsOverrideProbe ?? null,
            acpConfigOptionsOverrideProbe ?? null,
        ]);
    }, [
        acpConfigOptionsOverrideProbe,
        props.agentPickerProbe,
        props.modelOptionsOverrideProbe,
        sessionModeOptionsOverrideProbe,
        sessionModelOptionsProbe,
    ]);

    const renderResolvedEngineDetail = React.useCallback((surfaceVariant: 'carded' | 'plain' = 'carded') => (
        <AgentInputEngineDetail
            modelOptions={modelOptions.map((option) => ({
                value: option.value,
                label: option.label,
                description:
                    option.value === 'default'
                    && shouldShowModelOptionDescriptions
                    && (typeof option.description !== 'string' || option.description.trim().length === 0)
                        ? t('agentInput.model.configureInCli')
                        : option.description,
                ...(option.modelOptions ? { modelOptions: option.modelOptions } : {}),
            }))}
            selectedModelId={effectiveModelPolicy.effectiveModelId}
            effectiveModelLabel={effectiveModelLabel}
            modelNotes={effectiveModelPolicy.notes}
            modelEmptyText={t('agentInput.model.configureInCli')}
            canEnterCustomModel={canEnterCustomModel}
            // Keep a single refresh affordance in the model section, but wire it to refresh all
            // probe surfaces that feed the engine popover (CLI detection, models, modes/config).
            modelProbe={unifiedEnginePickerProbe}
            onSelectModel={(value) => {
                hapticsLight();
                props.onModelModeChange?.(value);
            }}
            onSubmitCustomValue={canEnterCustomModel ? submitCustomModel : undefined}
            selectedModelOptionControls={selectedModelOptionControls}
            onSelectModelOptionValue={
                props.onAcpConfigOptionChange
                    ? (configId, valueId) => {
                        hapticsLight();
                        props.onAcpConfigOptionChange?.(configId, valueId);
                    }
                    : undefined
            }
            configControls={acpConfigOptionControls}
            onSelectConfigValue={
                props.onAcpConfigOptionChange
                    ? (configId, valueId) => {
                        hapticsLight();
                        props.onAcpConfigOptionChange?.(configId, valueId);
                    }
                    : undefined
            }
            sectionOrder={['model', 'config']}
            surfaceVariant={surfaceVariant}
        />
    ), [
        acpConfigOptionControls,
        canEnterCustomModel,
        effectiveModelLabel,
        effectiveModelPolicy.effectiveModelId,
        effectiveModelPolicy.notes,
        modelOptions,
        unifiedEnginePickerProbe,
        shouldShowModelOptionDescriptions,
        props.onAcpConfigOptionChange,
        props.onModelModeChange,
        submitCustomModel,
        selectedModelOptionControls,
    ]);

    const hasInternalAgentPickerOptions = Boolean(
        props.agentType
        && (props.onModelModeChange || hasSettingsAcpConfigSection),
    );

    const internalAgentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!hasInternalAgentPickerOptions || !props.agentType) return [];
        return [{
            id: `engine:${props.agentType}`,
            label: props.agentLabel ?? t(getAgentCore(props.agentType).displayNameKey),
            icon: (
                <AgentIcon
                    agentId={props.agentType}
                    size={12}
                    style={{ transform: [{ scale: getAgentPickerIconScale(props.agentType) }] }}
                />
            ),
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: `session-engine:${props.agentType}`,
            renderDetailContent: () => renderResolvedEngineDetail('carded'),
        }];
    }, [
        hasInternalAgentPickerOptions,
        props.agentLabel,
        props.agentType,
        renderResolvedEngineDetail,
    ]);

    const agentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if ((props.agentPickerOptions?.length ?? 0) > 0) {
            return props.agentPickerOptions ?? [];
        }
        return internalAgentPickerOptions;
    }, [internalAgentPickerOptions, props.agentPickerOptions]);

    const effectiveAgentPickerSelectedOptionId = React.useMemo(() => {
        if (typeof props.agentPickerSelectedOptionId === 'string' && props.agentPickerSelectedOptionId.length > 0) {
            return props.agentPickerSelectedOptionId;
        }
        return agentPickerOptions[0]?.id ?? null;
    }, [agentPickerOptions, props.agentPickerSelectedOptionId]);

    const hasAgentPickerOptions = agentPickerOptions.length > 0;

    const {
        overlayAnchorRef,
        actionMenuAnchorRef,
        agentChipAnchorRef,
        permissionChipAnchorRef,
        machineChipAnchorRef,
        sessionModeChipAnchorRef,
        pathChipAnchorRef,
        resumeChipAnchorRef,
        profileChipAnchorRef,
        envVarsChipAnchorRef,
    } = useAgentInputSelectionAnchors();
    const [showActionMenu, setShowActionMenu] = React.useState(false);
    const statusBadgeAnchorRef = React.useRef<any>(null);
    const [uncontrolledActiveStatusBadgeKey, setUncontrolledActiveStatusBadgeKey] = React.useState<string | null>(null);
    const activeStatusBadgeKey = props.activeStatusBadgeKey !== undefined
        ? props.activeStatusBadgeKey
        : uncontrolledActiveStatusBadgeKey;
    const setActiveStatusBadgeKey = props.onActiveStatusBadgeKeyChange ?? setUncontrolledActiveStatusBadgeKey;
    const closeActionMenu = React.useCallback(() => {
        setShowActionMenu(false);
    }, []);
    const closeStatusBadgePopover = React.useCallback(() => {
        setActiveStatusBadgeKey(null);
    }, []);
    const {
        activeSelectionOverlay,
        activeExtraCollapsedPopoverChip,
        openSelectionOverlay,
        toggleSelectionOverlay,
        closeSelectionOverlay,
        resetSelectionOverlays,
    } = useAgentInputSelectionOverlayController({
        extraActionChips: props.extraActionChips,
        shouldRenderSessionModeChip,
        canChangePermission: Boolean(props.onPermissionModeChange),
        hasMachinePopover: Boolean(props.machinePopover),
        hasPathPopover: Boolean(props.pathPopover),
        hasResumePopover: Boolean(props.resumePopover),
        hasProfilePopover: Boolean(props.profilePopover),
        hasEnvVarsPopover: Boolean(props.envVarsPopover),
        hasAgentPickerOptions,
    });
    const {
        showAgentPicker,
        agentPickerAnchor,
        closeAgentPicker,
        showSessionModePicker,
        sessionModePickerAnchor,
        closeSessionModePicker,
        showPermissionPopover,
        closePermissionPopover,
        showMachinePopover,
        machinePopoverAnchor,
        closeMachinePopover,
        showPathPopover,
        pathPopoverAnchor,
        closePathPopover,
        showResumePopover,
        resumePopoverAnchor,
        closeResumePopover,
        showProfilePopover,
        profilePopoverAnchor,
        closeProfilePopover,
        showEnvVarsPopover,
        envVarsPopoverAnchor,
        closeEnvVarsPopover,
        activeExtraCollapsedPopoverAnchor,
        closeActiveExtraCollapsedPopoverChip,
    } = buildAgentInputSelectionOverlayViewModel({
        activeSelectionOverlay,
        activeExtraCollapsedPopoverChip,
        closeSelectionOverlay,
    });

    const effectivePermissionLabel = React.useMemo(() => {
        return getPermissionModeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

    const activeStatusBadge = React.useMemo(() => (
        activeStatusBadgeKey
            ? props.statusBadges?.find((badge) => badge.key === activeStatusBadgeKey) ?? null
            : null
    ), [activeStatusBadgeKey, props.statusBadges]);

    const permissionChipLabel = React.useMemo(() => {
        return getPermissionModeBadgeLabelForAgentType(agentId, effectivePermissionPolicy.effectiveMode);
    }, [agentId, effectivePermissionPolicy.effectiveMode]);

    const showPermissionChip = Boolean(props.onPermissionModeChange || props.onPermissionClick);
    const hasProfile = Boolean(props.onProfileClick || props.profilePopover);
    const hasEnvVars = Boolean(props.onEnvVarsClick || props.envVarsPopover);
    const {
        hasAgentSelection: hasAgent,
        resolvedAgentLabel,
        handlePermissionPress,
        handleModePress,
        handleProfilePress,
        handleEnvVarsPress,
        handleAgentPress,
        handleMachinePress,
        handlePathPress,
        handleResumePress,
    } = useAgentInputCoreControlHandlers({
        agentType: props.agentType,
        agentLabel: props.agentLabel,
        hasAgentPickerOptions,
        onAgentClick: props.onAgentClick,
        onPermissionModeChange: props.onPermissionModeChange,
        onPermissionClick: props.onPermissionClick,
        sessionModeChipInteraction,
        onSessionModeChange: props.onAcpSessionModeChange,
        profilePopover: props.profilePopover,
        onProfileClick: props.onProfileClick,
        envVarsPopover: props.envVarsPopover,
        onEnvVarsClick: props.onEnvVarsClick,
        machinePopover: props.machinePopover,
        onMachineClick: props.onMachineClick,
        pathPopover: props.pathPopover,
        onPathClick: props.onPathClick,
        resumePopover: props.resumePopover,
        onResumeClick: props.onResumeClick,
        setShowActionMenu,
        closeSelectionOverlay,
        toggleSelectionOverlay,
    });
    const hasRecipient = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'recipient');
    }, [props.extraActionChips]);
    const hasDelivery = React.useMemo(() => {
        return (props.extraActionChips ?? []).some((chip) => chip.controlId === 'delivery');
    }, [props.extraActionChips]);
    const hasExtraActionChips = (props.extraActionChips?.length ?? 0) > 0;
    const composerAttachmentBadges = React.useMemo<readonly AgentInputComposerAttachmentBadge[]>(() => {
        return (props.extraActionChips ?? [])
            .map((chip) => chip.composerAttachmentBadge)
            .filter((badge): badge is AgentInputComposerAttachmentBadge => Boolean(badge));
    }, [props.extraActionChips]);
    const hasMachine = Boolean(props.onMachineClick || props.machinePopover);
    const hasPath = Boolean(props.onPathClick || props.pathPopover);
    const hasResume = Boolean(props.onResumeClick || props.resumePopover);
    const hasFiles = Boolean(props.sessionId && props.onFileViewerPress);
    const hasStop = Boolean(props.onAbort && props.showAbortButton);
    const hasAnyActions = getHasAnyAgentInputActions({
        showPermissionChip,
        hasProfile,
        hasEnvVars,
        hasAgent,
        hasRecipient,
        hasDelivery,
        hasExtraActionChips,
        hasMachine,
        hasPath,
        hasResume,
        hasFiles,
        hasStop,
    });

    const actionBarShouldScroll = effectiveActionBarLayout === 'scroll';
    const actionBarIsCollapsed = effectiveActionBarLayout === 'collapsed';
    const showSecondaryControlsRow = shouldShowSecondaryControlRow(
        effectiveActionBarLayout,
        hasMachine || hasPath || hasResume,
    );
    const actionChipTransientStyles = React.useMemo(() => ({
        iconOnly: {
            paddingHorizontal: 8,
            gap: 0,
        },
        pressed: {
            opacity: 0.7,
        },
    }), []);
    const chipStyle = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        !showChipLabels ? actionChipTransientStyles.iconOnly : null,
        pressed ? actionChipTransientStyles.pressed : null,
    ]), [
        actionChipTransientStyles.iconOnly,
        actionChipTransientStyles.pressed,
        showChipLabels,
        styles.actionChip,
    ]);
    const chipStyleAutoHide = React.useCallback((pressed: boolean) => ([
        styles.actionChip,
        !showAutoHideChipLabels ? actionChipTransientStyles.iconOnly : null,
        pressed ? actionChipTransientStyles.pressed : null,
    ]), [
        actionChipTransientStyles.iconOnly,
        actionChipTransientStyles.pressed,
        showAutoHideChipLabels,
        styles.actionChip,
    ]);

    const actionBarFadeColor = React.useMemo(() => {
        return theme.colors.input.background;
    }, [theme.colors.input.background]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;
        abortConfirmationExpiresAtRef.current = 0;

        hapticsError();
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    const runAbortShortcutAction = React.useCallback((action: 'armAbort' | 'confirmAbort') => {
        if (action === 'confirmAbort') {
            void handleAbortPress();
            return;
        }
        abortConfirmationExpiresAtRef.current = Date.now() + COMPOSER_ABORT_CONFIRMATION_WINDOW_MS;
        hapticsError();
        shakerRef.current?.shake();
    }, [handleAbortPress]);

    const handleComposerFocusShortcut = React.useCallback(() => {
        if (props.disabled) return;
        inputRef.current?.focus();
    }, [props.disabled]);

    const handleComposerAbortShortcut = React.useCallback(() => {
        const escapeAction = resolveComposerEscapeAction({ key: 'Escape', shiftKey: true }, {
            canAbort: Boolean(props.showAbortButton && props.onAbort),
            isAborting,
            abortConfirmationExpiresAt: abortConfirmationExpiresAtRef.current,
            nowMs: Date.now(),
        });
        if (escapeAction) {
            runAbortShortcutAction(escapeAction);
        }
    }, [isAborting, props.onAbort, props.showAbortButton, runAbortShortcutAction]);

    const keyboardShortcutHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        const handlers: KeyboardShortcutHandlers = {
            'composer.focus': handleComposerFocusShortcut,
        };
        if (props.showAbortButton && props.onAbort) {
            handlers['composer.abortConfirm'] = handleComposerAbortShortcut;
        }
        return handlers;
    }, [handleComposerAbortShortcut, handleComposerFocusShortcut, props.onAbort, props.showAbortButton]);
    useKeyboardShortcutHandlers(keyboardShortcutHandlers);

    const {
        handleActionMenuPress,
        actionMenuActions,
        hasActionMenuPopoverSections,
    } = useAgentInputActionMenuControls({
        showActionMenu,
        setShowActionMenu,
        closeSelectionOverlay,
        openSelectionOverlay,
        resetSelectionOverlays,
        inputRef,
        profilePopover: props.profilePopover,
        onProfileClick: props.onProfileClick,
        envVarsPopover: props.envVarsPopover,
        onEnvVarsClick: props.onEnvVarsClick,
        machinePopover: props.machinePopover,
        pathPopover: props.pathPopover,
        resumePopover: props.resumePopover,
        hasAgentPickerOptions,
        onAgentClick: props.onAgentClick,
        actionBarIsCollapsed,
        hasAnyActions,
        tint: theme.colors.button.secondary.tint,
        agentId,
        profileLabel,
        profileIcon,
        envVarsCount: props.envVarsCount,
        agentType: props.agentType,
        machineName: props.machineName,
        currentPath: props.currentPath,
        resumeSessionId: props.resumeSessionId,
        sessionId: props.sessionId,
        extraActionChips: props.extraActionChips,
        openCollapsedOptionsPopover: (chipKey) => {
            if (!chipKey) {
                closeSelectionOverlay('collapsedExtra');
                return;
            }
            openSelectionOverlay('collapsedExtra', 'actionMenu', chipKey);
        },
        sessionModeLabel: sessionModeChipControl?.label ?? null,
        sessionModeChipInteraction,
        onSessionModeChange: props.onAcpSessionModeChange,
        shouldExposeSessionModeAction: actionBarIsCollapsed && shouldRenderSessionModeChip,
        onMachineClick: handleMachinePress,
        onPathClick: handlePathPress,
        onResumeClick: handleResumePress,
        onFileViewerPress: props.onFileViewerPress,
        canStop: Boolean(props.onAbort && props.showAbortButton),
        onStop: () => {
            void handleAbortPress();
        },
        hasProfile,
        hasEnvVars,
        hasAgent,
    });
    const {
        controlNodes: renderedActionControlNodes,
        secondaryLeadingControls: secondaryLeadingControlsForWrap,
        extraChipAnchorRefsByKey,
    } = useRenderedAgentInputControlRows({
        layout: effectiveActionBarLayout,
        chips: props.extraActionChips,
        overlayAnchorRef,
        onToggleExtraChipCollapsedPopover: (chipKey) => {
            toggleSelectionOverlay('collapsedExtra', 'chip', chipKey);
        },
        themeTint: theme.colors.button.secondary.tint,
        showChipLabels,
        showAutoHideChipLabels,
        chipStyle,
        chipStyleAutoHide,
        textStyle: styles.actionChipText,
        countTextStyle: styles.actionChipCountText,
        actionButtonStyle: styles.actionButton,
        actionButtonPressedStyle: styles.actionButtonPressed,
        showPermissionChip,
        permissionChipAnchorRef,
        permissionChipLabel,
        onPermissionPress: handlePermissionPress,
        hasActionMenuPopoverSections,
        actionMenuAnchorRef,
        onActionMenuPress: handleActionMenuPress,
        actionBarIsCollapsed,
        sessionModeChipControl,
        shouldRenderSessionModeChip,
        sessionModeChipAnchorRef,
        sessionModeChipPresentation,
        onModePress: handleModePress,
        hasProfile,
        profileChipAnchorRef,
        profileIcon,
        profileLabel,
        onProfilePress: handleProfilePress,
        hasEnvVars,
        envVarsChipAnchorRef,
        envVarsCount: props.envVarsCount,
        onEnvVarsPress: handleEnvVarsPress,
        hasAgentSelection: hasAgent,
        agentChipAnchorRef,
        agentLabel: resolvedAgentLabel,
        onAgentPress: handleAgentPress,
        machineChipAnchorRef,
        onMachinePress: handleMachinePress,
        machineName: props.machineName,
        pathChipAnchorRef,
        onPathPress: handlePathPress,
        currentPath: props.currentPath,
        resumeChipAnchorRef,
        onResumePress: handleResumePress,
        blurInput: () => inputRef.current?.blur(),
        resumeSessionId: props.resumeSessionId,
        resumeIsChecking: props.resumeIsChecking,
        onAbort: props.onAbort,
        showAbortButton: props.showAbortButton,
        isAborting,
        shakerRef,
        onAbortPress: handleAbortPress,
        sessionId: props.sessionId,
        onFileViewerPress: props.onFileViewerPress,
        sourceControlCompact: actionBarShouldScroll || !showChipLabels,
        sourceControlWrapperStyle: styles.actionItemWrapper,
    });

    const handlePermissionSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        closePermissionPopover();
    }, [closePermissionPopover, props.onPermissionModeChange]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        const hasSendableInput = Boolean(props.value.trim()) || props.hasSendableAttachments === true;
        const sendShortcutAction = resolveComposerSendShortcutAction(event, {
            keyboardShortcutsV2Enabled,
            keyboardSingleKeyShortcutsEnabled,
            keyboardShortcutOverridesV1,
            keyboardShortcutDisabledCommandIdsV1,
            hasSendableInput,
            sendActionDisabled,
            platformOS: Platform.OS,
        });
        if (sendShortcutAction === 'sendImmediate') {
            // Explicit immediate-send bypasses autocomplete.
            handleSend({ forceImmediate: true });
            return true;
        }
        if (sendShortcutAction === 'sendPending') {
            // Explicit pending-send bypasses steering so the message can be reviewed/reordered.
            handleSend({ deliveryIntent: 'server_pending' });
            return true;
        }

        const enterAction = resolveComposerEnterAction(event, {
            enterToSendEnabled,
            hasSendableInput,
            sendActionDisabled,
            platformOS: Platform.OS,
        });
        const escapeAction = resolveComposerEscapeAction(event, {
            canAbort: Boolean(props.showAbortButton && props.onAbort),
            isAborting,
            abortConfirmationExpiresAt: abortConfirmationExpiresAtRef.current,
            nowMs: Date.now(),
        });
        if (escapeAction) {
            runAbortShortcutAction(escapeAction);
            return true;
        }

        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        if (enterAction === 'send') {
            handleSend();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // Shell-like history: only when suggestions are not visible and cursor is at the boundary.
            const historyInputState = resolveHistoryKeyInputState(event, inputStateRef.current);
            const isCollapsedSelection = historyInputState.selection.start === historyInputState.selection.end;
            if (isCollapsedSelection && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                const historyBrowsing = isHistoryBrowsing();
                if (event.key === 'ArrowUp' && (historyBrowsing || historyInputState.selection.start === 0)) {
                    const next = messageHistory.moveUp(historyInputState.text);
                    if (next !== null) {
                        applyHistoryInputText(next);
                        return true;
                    }
                }

                const canResumeRetainedSessionDown =
                    hasRetainedHistorySession()
                    && historyInputState.selection.end === historyInputState.text.length;
                if (event.key === 'ArrowDown' && (historyBrowsing || canResumeRetainedSessionDown)) {
                    const next = messageHistory.moveDown(historyInputState.text);
                    if (next !== null) {
                        applyHistoryInputText(next);
                        return true;
                    }
                }
            }

            // Handle Shift+Tab for permission mode switching
            if (
                event.key === 'Tab'
                && event.shiftKey
                && props.onPermissionModeChange
                && shouldRunComposerModeCycleShortcut(event, {
                    keyboardShortcutsV2Enabled,
                    keyboardSingleKeyShortcutsEnabled,
                    keyboardShortcutOverridesV1,
                    keyboardShortcutDisabledCommandIdsV1,
                    platformOS: Platform.OS,
                })
            ) {
                const modeOrder = permissionModeOrder;
                if (!modeOrder || modeOrder.length === 0) return false;
                const current = effectivePermissionPolicy.effectiveMode;
                const currentIndex = modeOrder.indexOf(current);
                const nextIndex = (currentIndex + 1) % modeOrder.length;
                props.onPermissionModeChange(modeOrder[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }
        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, inputState.text, inputState.selection.start, inputState.selection.end, props.showAbortButton, props.onAbort, isAborting, runAbortShortcutAction, enterToSendEnabled, props.value, props.hasSendableAttachments, handleSend, props.onPermissionModeChange, keyboardShortcutsV2Enabled, keyboardSingleKeyShortcutsEnabled, keyboardShortcutOverridesV1, keyboardShortcutDisabledCommandIdsV1, permissionModeOrder, effectivePermissionPolicy.effectiveMode, messageHistory, applyHistoryInputText, sendActionDisabled, isHistoryBrowsing, hasRetainedHistorySession]);

    const handleSubmitEditing = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        if (!enterToSendEnabled) return;
        if (sendActionDisabled) return;
        const hasSendableInput = Boolean(props.value.trim()) || props.hasSendableAttachments === true;
        if (!hasSendableInput) return;
        handleSend();
    }, [enterToSendEnabled, handleSend, props.hasSendableAttachments, props.value, sendActionDisabled]);

    const submitBehavior = React.useMemo<MultiTextInputSubmitBehavior | undefined>(() => {
        if (Platform.OS === 'web') return undefined;
        return enterToSendEnabled ? 'submit' : 'newline';
    }, [enterToSendEnabled]);

    const handlePanelFilesDropped = React.useCallback((event: any) => {
        const files = extractWebAttachmentFilesFromDataTransfer(event?.dataTransfer);
        if (files.length > 0) {
            props.onAttachmentsAdded?.(files);
        }
    }, [props.onAttachmentsAdded]);

    const panelDropZoneHandlers = useWebFileDropZone({
        enabled: Platform.OS === 'web' && typeof props.onAttachmentsAdded === 'function',
        onFilesDropped: handlePanelFilesDropped,
        onFileDragActiveChange: setFileDragActive,
    });

    const fileDropOverlayBackdropStyle = React.useMemo<ViewStyle>(() => {
        const backgroundColor = theme.colors.overlay.scrimWizard ?? theme.colors.overlay.scrim;
        if (Platform.OS === 'web') {
            return createBackdropWebStyle({
                backgroundColor,
                blurPx: 2,
                enableBlur: uiBackdropBlurEnabled,
                fallbackBackgroundColorWhenBlurDisabled: theme.colors.overlay.scrimStrong ?? theme.colors.overlay.scrim,
            }) as unknown as ViewStyle;
        }
        return createBackdropNativeStyle({ backgroundColor });
    }, [
        theme.colors.overlay.scrim,
        theme.colors.overlay.scrimStrong,
        theme.colors.overlay.scrimWizard,
        uiBackdropBlurEnabled,
    ]);

    const renderComposerInput = () => (
        <View
            ref={composerAnchorRef}
            collapsable={false}
            testID="agent-input-composer-input-container"
            style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}
            onLayout={(event) => {
                updateNullableLayoutHeight(setInputContainerHeightPx, event.nativeEvent.layout.height);
            }}
        >
            <MultiTextInput
                ref={inputRef}
                testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionInput : AGENT_INPUT_TEST_IDS.newSessionInput}
                textStyle={props.sessionId ? styles.sessionInputText : styles.newSessionInputText}
                value={props.value}
                paddingTop={Platform.OS === 'web' ? 10 : 8}
                paddingBottom={Platform.OS === 'web' ? 10 : 8}
                paddingRight={shouldShowInputExpansionToggle ? 32 : undefined}
                onChangeText={props.onChangeText}
                placeholder={props.placeholder}
                onKeyPress={handleKeyPress}
                onStateChange={handleInputStateChange}
                onFocus={handleComposerFocus}
                onBlur={handleComposerBlur}
                submitBehavior={submitBehavior}
                onSubmitEditing={handleSubmitEditing}
                maxHeight={resolvedInputMaxHeight}
                editable={!props.disabled}
                onFilesPasted={props.onAttachmentsAdded}
                onLayout={(event) => {
                    updateNullableLayoutHeight(setInputViewportHeightPx, event.nativeEvent.layout.height);
                }}
                onContentHeightChange={(height) => {
                    updateNullableLayoutHeight(setInputContentHeightPx, height);
                }}
            />
            {props.inputExpansion && shouldShowInputExpansionToggle ? (
                <Pressable
                    accessibilityLabel={props.inputExpansion.expanded ? t('common.collapse') : t('common.expand')}
                    accessibilityRole="button"
                    hitSlop={8}
                    testID="agent-input-expand-toggle"
                    onPress={props.inputExpansion.onToggle}
                    style={({ pressed }) => [
                        styles.inputExpansionToggle,
                        pressed ? styles.inputExpansionTogglePressed : null,
                    ]}
                >
                    {renderIoniconNode(
                        props.inputExpansion.expanded ? 'contract-outline' : 'expand-outline',
                        16,
                        theme.colors.text.secondary,
                    )}
                </Pressable>
            ) : null}
        </View>
    );

    const renderComposerAttentionRequests = () => (
        props.sessionId && hasComposerAttentionRequests ? (
            <View
                testID="agentInput.permissionRequests.fixed"
                onLayout={(event) => {
                    updateLayoutHeight(setComposerAttentionHeightPx, event.nativeEvent.layout.height);
                }}
            >
                {composerPermissionRequests.length > 0 || pendingApprovalRequests.length > 0 ? (
                    <AgentInputAttentionRequestsWithLocations
                        sessionId={props.sessionId}
                        permissionRequests={composerPermissionRequests}
                        userActionRequests={pendingUserActionRequests}
                        approvalRequests={pendingApprovalRequests}
                        metadata={props.metadata || null}
                        canApprovePermissions={canApprovePermissions}
                        disabledReason={props.permissionDisabledReason}
                        maxHeightPx={permissionRequestsMaxHeightPx}
                        onContentSizeChange={(_w, h) => {
                            permissionRequestsFades.onContentSizeChange?.(_w, h);
                        }}
                        onLayout={(e) => {
                            permissionRequestsFades.onViewportLayout?.(e);
                        }}
                        onScroll={(e) => {
                            permissionRequestsFades.onScroll?.(e);
                        }}
                        fadeVisibility={permissionRequestsFades.visibility}
                    />
                ) : (
                    <AgentInputAttentionRequests
                        sessionId={props.sessionId}
                        permissionRequests={composerPermissionRequests}
                        userActionRequests={pendingUserActionRequests}
                        approvalRequests={pendingApprovalRequests}
                        permissionLocationsById={EMPTY_PERMISSION_LOCATIONS_BY_ID}
                        approvalLocationsByArtifactId={EMPTY_PERMISSION_LOCATIONS_BY_ID}
                        metadata={props.metadata || null}
                        canApprovePermissions={canApprovePermissions}
                        disabledReason={props.permissionDisabledReason}
                        maxHeightPx={permissionRequestsMaxHeightPx}
                        onContentSizeChange={(_w, h) => {
                            permissionRequestsFades.onContentSizeChange?.(_w, h);
                        }}
                        onLayout={(e) => {
                            permissionRequestsFades.onViewportLayout?.(e);
                        }}
                        onScroll={(e) => {
                            permissionRequestsFades.onScroll?.(e);
                        }}
                        fadeVisibility={permissionRequestsFades.visibility}
                    />
                )}
            </View>
        ) : null
    );

    const renderComposerVariableContent = () => (
        <>
            {((props.attachments?.length ?? 0) > 0 || composerAttachmentBadges.length > 0) ? (
                <AgentInputAttachmentsRow
                    attachments={props.attachments ?? []}
                    composerBadges={composerAttachmentBadges}
                />
            ) : null}
            {renderComposerInput()}
        </>
    );

    const renderActionRows = () => (
        <View style={styles.actionButtonsContainer}>
            <View
                style={[
                    screenWidth < 420 ? styles.actionButtonsColumnNarrow : styles.actionButtonsColumn,
                    isMobileLayoutWidth(screenWidth) ? styles.actionButtonsColumnMobile : null,
                ]}
            >{[
                <View
                    key="row1"
                    style={[styles.actionButtonsRow, showSecondaryControlsRow ? styles.actionButtonsRowWithBelow : null]}
                >
                    {actionBarShouldScroll ? (
                        <AgentInputScrollableChipRow
                            containerStyle={styles.actionButtonsLeftScroll}
                            contentStyle={styles.actionButtonsLeftScrollContent}
                            fadeColor={actionBarFadeColor}
                            indicatorColor={theme.colors.button.secondary.tint}
                            fadeLeftStyle={styles.actionButtonsFadeLeft}
                            fadeRightStyle={styles.actionButtonsFadeRight}
                        >
                            {renderedActionControlNodes as any}
                        </AgentInputScrollableChipRow>
                    ) : (
                        <View style={[styles.actionButtonsLeft, screenWidth < 420 ? styles.actionButtonsLeftNarrow : null]}>
                            {renderedActionControlNodes as any}
                        </View>
                    )}
                    <AgentInputSubmitButton
                        testID={props.sessionId ? AGENT_INPUT_TEST_IDS.sessionSend : AGENT_INPUT_TEST_IDS.newSessionSend}
                        sessionId={props.sessionId}
                        submitAccessibilityLabel={props.submitAccessibilityLabel}
                        disabled={Boolean(props.disabled || props.isSendDisabled || props.isSending || (!hasSendableContent && !micPressHandler))}
                        isSending={props.isSending}
                        hasSendableContent={hasSendableContent}
                        micPressHandler={micPressHandler}
                        micActive={micActive}
                        onSend={handleSend}
                    />
                </View>,
                showSecondaryControlsRow ? (
                    actionBarShouldScroll ? (
                        <AgentInputScrollableChipRow
                            key="row2"
                            containerStyle={styles.actionButtonsSecondaryScroll}
                            contentStyle={styles.actionButtonsScrollViewportContent}
                            fadeColor={actionBarFadeColor}
                            indicatorColor={theme.colors.button.secondary.tint}
                            fadeLeftStyle={styles.actionButtonsFadeLeft}
                            fadeRightStyle={styles.actionButtonsFadeRight}
                        >
                            <PathAndResumeRow
                                styles={{
                                    pathRow: styles.pathRow,
                                    actionButtonsLeft: styles.actionButtonsLeftScrollInline,
                                    actionChip: styles.actionChip,
                                    actionChipIconOnly: actionChipTransientStyles.iconOnly,
                                    actionChipPressed: actionChipTransientStyles.pressed,
                                    actionChipText: styles.actionChipText,
                                }}
                                fillAvailableWidth={false}
                                leadingControls={secondaryLeadingControlsForWrap}
                                showChipLabels={showChipLabels}
                                iconColor={theme.colors.button.secondary.tint}
                                currentPath={props.currentPath}
                                pathChipAnchorRef={pathChipAnchorRef}
                                emptyPathLabel={t('newSession.selectPathTitle')}
                                onPathClick={handlePathPress}
                                resumeSessionId={props.resumeSessionId}
                                resumeChipAnchorRef={resumeChipAnchorRef}
                                onResumeClick={handleResumePress}
                                resumeLabelTitle={t('newSession.resume.chipOptional', {
                                    agent: resolvedAgentLabel,
                                })}
                                resumeLabelOptional={t('newSession.resume.chipOptional', {
                                    agent: resolvedAgentLabel,
                                })}
                            />
                        </AgentInputScrollableChipRow>
                    ) : (
                        <PathAndResumeRow
                            key="row2"
                            styles={{
                                pathRow: styles.pathRow,
                                actionButtonsLeft: styles.actionButtonsLeft,
                                actionChip: styles.actionChip,
                                actionChipIconOnly: actionChipTransientStyles.iconOnly,
                                actionChipPressed: actionChipTransientStyles.pressed,
                                actionChipText: styles.actionChipText,
                            }}
                            leadingControls={secondaryLeadingControlsForWrap}
                            showChipLabels={showChipLabels}
                            iconColor={theme.colors.button.secondary.tint}
                            currentPath={props.currentPath}
                            pathChipAnchorRef={pathChipAnchorRef}
                            emptyPathLabel={t('newSession.selectPathTitle')}
                            onPathClick={handlePathPress}
                            resumeSessionId={props.resumeSessionId}
                            resumeChipAnchorRef={resumeChipAnchorRef}
                            onResumeClick={handleResumePress}
                            resumeLabelTitle={t('newSession.resume.chipOptional', {
                                agent: resolvedAgentLabel,
                            })}
                            resumeLabelOptional={t('newSession.resume.chipOptional', {
                                agent: resolvedAgentLabel,
                            })}
                        />
                    )
                ) : null,
            ]}</View>
        </View>
    );

    const renderActionFooterSection = () => (
        <View
            style={styles.nativeKeyboardFooterSection}
            onLayout={(event) => {
                updateLayoutHeight(setActionFooterHeightPx, event.nativeEvent.layout.height);
            }}
        >
            {renderActionRows()}
        </View>
    );

    return (
        <View
            pointerEvents={Platform.OS === 'web' ? 'auto' : undefined}
            testID="agent-input-root"
            onLayout={(event) => {
                updateNullableLayoutHeight(setRootHeightPx, event.nativeEvent.layout.height);
            }}
            style={[
                styles.container,
                { paddingHorizontal: props.contentPaddingHorizontal ?? (screenWidth > 700 ? 16 : 8) },
            ]}
        >
            <View style={[
                styles.innerContainer,
                ...(typeof props.maxWidthCap === 'number'
                    ? [{ maxWidth: props.maxWidthCap }]
                    : props.maxWidthCap === null
                        ? []
                        : [{ maxWidth: layout.maxWidth }])
            ]} ref={overlayAnchorRef}>
                <AgentInputOverlayLayer
                    suggestions={suggestions}
                    overlayAnchorRef={overlayAnchorRef}
                    screenWidth={screenWidth}
                    autocompleteSelectedIndex={selected}
                    onAutocompleteSelect={handleSuggestionSelect}
                    showPermissionPopover={showPermissionPopover && Boolean(props.onPermissionModeChange)}
                    permissionChipAnchorRef={permissionChipAnchorRef}
                    onPermissionPopoverRequestClose={closePermissionPopover}
                    onPermissionSelect={handlePermissionSelect}
                    agentId={agentId}
                    permissionModeOptions={permissionModeOptions}
                    effectivePermissionMode={effectivePermissionPolicy.effectiveMode}
                    effectivePermissionLabel={effectivePermissionLabel}
                    effectivePermissionPolicy={effectivePermissionPolicy}
                    // FR4-16: Unistyles' inferred output type may not structurally
                    // match the narrow `PermissionModePickerStyles` contract, so
                    // we use a documented boundary cast here. The contract is
                    // enforced inside the overlay + picker; this cast is the only
                    // narrow seam between Unistyles and the typed picker fields.
                    styles={styles as unknown as PermissionModePickerStyles}
                    showActionMenu={showActionMenu}
                    hasActionMenuPopoverSections={hasActionMenuPopoverSections}
                    actionMenuAnchorRef={actionMenuAnchorRef}
                    onActionMenuRequestClose={closeActionMenu}
                    actionMenuActions={actionMenuActions}
                    maxWidthCap={layout.maxWidth}
                    showAgentPicker={showAgentPicker}
                    hasAgentPickerOptions={hasAgentPickerOptions}
                    agentPickerAnchor={agentPickerAnchor}
                    agentChipAnchorRef={agentChipAnchorRef}
                    agentPickerTitle={props.agentPickerTitle ?? ''}
                    agentPickerOptions={agentPickerOptions}
                    effectiveAgentPickerSelectedOptionId={effectiveAgentPickerSelectedOptionId}
                    onAgentPickerSelect={props.onAgentPickerSelect}
                    onAgentPickerRequestClose={closeAgentPicker}
                    agentPickerApplyLabel={props.agentPickerApplyLabel}
                    showSessionModePicker={showSessionModePicker}
                    shouldRenderSessionModeChip={shouldRenderSessionModeChip}
                    sessionModePickerAnchor={sessionModePickerAnchor}
                    sessionModeChipAnchorRef={sessionModeChipAnchorRef}
                    sessionModePickerOptions={sessionModePickerOptions}
                    sessionModeSelectedOptionId={sessionModeChipControl?.selectedId ?? null}
                    onSessionModeSelect={(selectedId) => {
                        props.onAcpSessionModeChange?.(selectedId);
                        closeSessionModePicker();
                    }}
                    onSessionModeRequestClose={closeSessionModePicker}
                    activeExtraCollapsedPopoverChip={activeExtraCollapsedPopoverChip}
                    activeExtraCollapsedPopoverAnchor={activeExtraCollapsedPopoverAnchor}
                    extraChipAnchorRefsByKey={extraChipAnchorRefsByKey}
                    onActiveExtraCollapsedPopoverChipClose={closeActiveExtraCollapsedPopoverChip}
                    showMachinePopover={showMachinePopover}
                    machinePopoverAnchor={machinePopoverAnchor}
                    machineChipAnchorRef={machineChipAnchorRef}
                    machinePopover={props.machinePopover}
                    onMachinePopoverRequestClose={closeMachinePopover}
                    showProfilePopover={showProfilePopover}
                    profilePopoverAnchor={profilePopoverAnchor}
                    profileChipAnchorRef={profileChipAnchorRef}
                    profilePopover={props.profilePopover}
                    onProfilePopoverRequestClose={closeProfilePopover}
                    showPathPopover={showPathPopover}
                    pathPopoverAnchor={pathPopoverAnchor}
                    pathChipAnchorRef={pathChipAnchorRef}
                    pathPopover={props.pathPopover}
                    onPathPopoverRequestClose={closePathPopover}
                    showResumePopover={showResumePopover}
                    resumePopoverAnchor={resumePopoverAnchor}
                    resumeChipAnchorRef={resumeChipAnchorRef}
                    resumePopover={props.resumePopover}
                    onResumePopoverRequestClose={closeResumePopover}
                    showEnvVarsPopover={showEnvVarsPopover}
                    envVarsPopoverAnchor={envVarsPopoverAnchor}
                    envVarsChipAnchorRef={envVarsChipAnchorRef}
                    envVarsPopover={props.envVarsPopover}
                    onEnvVarsPopoverRequestClose={closeEnvVarsPopover}
                />

                {/* Connection status, context usage, and permission mode */}
                {(props.connectionStatus || contextUsageState || (props.statusBadges && props.statusBadges.length > 0)) && (
                    <View style={styles.statusContainer}>
                        <View style={styles.statusRow}>
                            {props.connectionStatus && (
                                <>
                                    <StatusDot
                                        color={props.connectionStatus.dotColor}
                                        isPulsing={props.connectionStatus.isPulsing}
                                        size={6}
                                        style={styles.statusDot}
                                    />
                                    <Text
                                        testID={AGENT_INPUT_TEST_IDS.connectionStatusText}
                                        style={[styles.statusText, { color: props.connectionStatus.color }]}
                                    >
                                        {props.connectionStatus.text}
                                    </Text>
                                </>
                            )}
                            {props.statusBadges?.map(({ key, renderPopover, onPress, ...badge }) => (
                                <AgentInputStatusBadge
                                    key={key}
                                    anchorRef={renderPopover ? statusBadgeAnchorRef : undefined}
                                    onPress={renderPopover
                                        ? () => {
                                            setActiveStatusBadgeKey(activeStatusBadgeKey === key ? null : key);
                                            onPress?.();
                                        }
                                        : onPress}
                                    renderPopover={renderPopover}
                                    {...badge}
                                />
                            ))}
                        </View>
                        <View testID="agent-input-status-trailing" style={styles.statusTrailing}>
                            <View style={[styles.permissionModeContainer, contextUsageState ? { marginRight: 8 } : null]}>
                                {shouldRenderPermissionChip(permissionChipLabel) ? (
                                    <Text
                                        style={[
                                            styles.permissionModeText,
                                            {
                                                color: effectivePermissionPolicy.effectiveMode === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                                    effectivePermissionPolicy.effectiveMode === 'bypassPermissions' ? theme.colors.permission.bypass :
                                                        effectivePermissionPolicy.effectiveMode === 'plan' ? theme.colors.permission.plan :
                                                            effectivePermissionPolicy.effectiveMode === 'read-only' ? theme.colors.permission.readOnly :
                                                                effectivePermissionPolicy.effectiveMode === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                                    effectivePermissionPolicy.effectiveMode === 'yolo' ? theme.colors.permission.yolo :
                                                                        theme.colors.text.secondary, // Use secondary text color for default
                                            },
                                        ]}
                                    >
                                        {permissionChipLabel}
                                    </Text>
                                ) : null}
                            </View>
                            {contextUsageState ? (
                                <AgentInputContextUsageBadge state={contextUsageState} />
                            ) : null}
                        </View>
                    </View>
                )}
                {activeStatusBadge?.renderPopover?.({
                    open: true,
                    anchorRef: statusBadgeAnchorRef,
                    onRequestClose: closeStatusBadgePopover,
                })}

                {/* Box 2: Action Area (Input + Send) */}
                <WebDropTargetView
                    testID="agent-input-drop-zone"
                    style={[
                        styles.unifiedPanel,
                        props.panelStyle,
                        typeof effectivePanelMaxHeight === 'number' ? { maxHeight: effectivePanelMaxHeight } : null,
                    ]}
                    onLayout={(event) => {
                        updateNullableLayoutHeight(setPanelHeightPx, event.nativeEvent.layout.height);
                    }}
                    {...panelDropZoneHandlers}
                >
                    {fileDragActive && typeof props.onAttachmentsAdded === 'function' ? (
                        <View
                            testID="agent-input-drop-overlay"
                            pointerEvents="none"
                            style={[
                                styles.fileDropOverlay,
                                fileDropOverlayBackdropStyle,
                            ]}
                        >
                            <View style={styles.fileDropOverlayContent}>
                                {renderIoniconNode('attach-outline', 18, theme.colors.text.primary)}
                                <Text style={styles.fileDropOverlayText}>{t('agentInput.dropToAttach')}</Text>
                            </View>
                        </View>
                    ) : null}
                    {Platform.OS === 'web' ? (
                        <>
                            {renderComposerAttentionRequests()}
                            <ScrollView
                                style={[
                                    styles.nativeKeyboardVariableSection,
                                    styles.webVariableSectionEdgeToEdge,
                                    typeof panelVariableSectionMaxHeight === 'number'
                                        ? { maxHeight: panelVariableSectionMaxHeight }
                                        : null,
                                ]}
                                contentContainerStyle={[
                                    styles.nativeKeyboardVariableSectionContent,
                                    styles.webVariableSectionContentInset,
                                ]}
                                keyboardShouldPersistTaps="handled"
                            >
                                {renderComposerVariableContent()}
                            </ScrollView>
                            {renderActionFooterSection()}
                        </>
                    ) : (
                        <View style={styles.nativeKeyboardPanelContent}>
                            {renderComposerAttentionRequests()}
                            <View
                                style={[
                                    styles.nativeKeyboardVariableSection,
                                    styles.nativeKeyboardVariableSectionContent,
                                    typeof panelVariableSectionMaxHeight === 'number'
                                        ? { maxHeight: panelVariableSectionMaxHeight }
                                        : null,
                                ]}
                            >
                                {renderComposerVariableContent()}
                            </View>
                            {renderActionFooterSection()}
                        </View>
                    )}
                </WebDropTargetView>
            </View>
        </View>
    );
}));
