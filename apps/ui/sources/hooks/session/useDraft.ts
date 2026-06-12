import { useEffect, useRef, useCallback, useMemo } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { useIsFocused } from '@react-navigation/native';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearForkInitialPromptV1, readForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import {
    clearSessionInitialPromptV1,
    readSessionInitialPromptV1,
    type SessionInitialPromptV1,
} from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import { containsLikelyNonWhitespace, isLargeTextInputValueLength } from '@/components/ui/forms/largeTextInputPolicy';
import { useWebLifecycleFlush } from './useWebLifecycleFlush';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
}

export type SessionDraftTextSnapshot = Readonly<{
    sessionId: string;
    text: string;
}>;

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedValue = useRef<string>('');
    const lastSessionId = useRef<string | null>(null);
    const latestValue = useRef<string>(value);
    const autosaveSkip = useRef<Readonly<{ sessionId: string; value: string }> | null>(null);
    const isFocused = useIsFocused();
    const session = sessionId ? storage.getState().sessions[sessionId] : null;
    const storedDraft = typeof session?.draft === 'string' ? session.draft : null;
    const forkInitialPrompt = readForkInitialPromptV1(session?.metadata);
    const forkInitialPromptText = forkInitialPrompt?.text ?? null;
    const sessionInitialPrompt = readSessionInitialPromptV1(session?.metadata);
    const consumedSessionInitialPromptKeyRef = useRef<string | null>(null);
    const sessionInitialPromptKey = useMemo(() => {
        if (!sessionId || !sessionInitialPrompt) return null;
        return [
            sessionId,
            sessionInitialPrompt.mode,
            String(sessionInitialPrompt.createdAtMs),
            sessionInitialPrompt.sourceSessionId ?? '',
            (sessionInitialPrompt.sourceMessageIds ?? []).join(','),
            sessionInitialPrompt.text,
        ].join('\u0000');
    }, [sessionId, sessionInitialPrompt]);
    const activeSessionInitialPrompt = sessionInitialPromptKey && consumedSessionInitialPromptKeyRef.current !== sessionInitialPromptKey
        ? sessionInitialPrompt
        : null;

    latestValue.current = value;

    const saveDraftForSession = useCallback((targetSessionId: string, draft: string) => {
        storage.getState().updateSessionDraft(targetSessionId, draft);
        if (lastSessionId.current === targetSessionId) {
            lastSavedValue.current = draft;
        }
    }, []);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        saveDraftForSession(sessionId, draft);
    }, [saveDraftForSession, sessionId]);

    const flushLatestDraftIfChanged = useCallback(() => {
        if (!sessionId) return;
        const currentValue = latestValue.current;
        if (currentValue === lastSavedValue.current) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        saveDraft(currentValue);
    }, [saveDraft, sessionId]);

    const setDraftValue = useCallback((nextValueOrUpdater: string | ((currentValue: string) => string)) => {
        const nextValue = typeof nextValueOrUpdater === 'function'
            ? nextValueOrUpdater(latestValue.current)
            : nextValueOrUpdater;
        latestValue.current = nextValue;
        onChange(nextValue);
    }, [onChange]);

    const clearForkInitialPrompt = useCallback((tag: string) => {
        if (!sessionId || !forkInitialPromptText) return;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) =>
                clearForkInitialPromptV1({ metadata }),
            ),
            { tag },
        );
    }, [forkInitialPromptText, sessionId]);

    const clearSessionInitialPrompt = useCallback((tag: string) => {
        if (!sessionId || !sessionInitialPromptKey) return;
        consumedSessionInitialPromptKeyRef.current = sessionInitialPromptKey;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) =>
                clearSessionInitialPromptV1({ metadata }),
            ),
            { tag },
        );
    }, [sessionId, sessionInitialPromptKey]);

    const composeSessionInitialPromptText = useCallback((baseText: string, prompt: SessionInitialPromptV1): string => {
        if (prompt.mode === 'replace') return prompt.text;
        const trimmedBase = baseText.trimEnd();
        if (!trimmedBase) return prompt.text;
        return `${trimmedBase}\n\n${prompt.text}`;
    }, []);

    const adoptDraftText = useCallback((draft: string) => {
        onChange(draft);
        saveDraft(draft);
        lastSavedValue.current = draft;
    }, [onChange, saveDraft]);

    // Load draft on mount and when focused. When switching sessions, always sync the composer
    // to the target session (draft or empty) to avoid leaking the previous session's text.
    useEffect(() => {
        if (!sessionId) return;

        const previousSessionId = lastSessionId.current;
        lastSessionId.current = sessionId;
        const didSessionChange = previousSessionId !== null && previousSessionId !== sessionId;

        const currentValue = latestValue.current;

        if (didSessionChange) {
            if (previousSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(previousSessionId, currentValue);
            }
            autosaveSkip.current = { sessionId, value: currentValue };
            const baseStoredDraft = storedDraft && storedDraft.trim() ? storedDraft : null;
            const baseText = baseStoredDraft ?? forkInitialPromptText ?? null;
            const nextDraft = baseText !== null && activeSessionInitialPrompt
                ? composeSessionInitialPromptText(baseText, activeSessionInitialPrompt)
                : baseText ?? (activeSessionInitialPrompt ? composeSessionInitialPromptText('', activeSessionInitialPrompt) : null);

            if (nextDraft !== null) {
                adoptDraftText(nextDraft);
                if (baseStoredDraft !== null) {
                    clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange.storedDraft');
                } else if (forkInitialPromptText) {
                    clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange');
                }
                clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.sessionChange');
            } else if (currentValue.trim()) {
                onChange('');
                lastSavedValue.current = '';
            } else {
                lastSavedValue.current = '';
            }
            return;
        }

        if (!isFocused) return;

        const externalDraft = storedDraft && storedDraft.trim() ? storedDraft : null;
        if (externalDraft != null && externalDraft === currentValue && lastSavedValue.current !== externalDraft && !activeSessionInitialPrompt) {
            lastSavedValue.current = externalDraft;
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.syncedDraft');
        }
        const canAdoptExternalDraft =
            externalDraft != null
                ? currentValue === lastSavedValue.current || (!currentValue.trim() && !lastSavedValue.current.trim())
                : false;
        const canAdoptWithoutExternalDraft = currentValue === lastSavedValue.current || !currentValue.trim();

        if (externalDraft != null && canAdoptExternalDraft) {
            const nextDraft = activeSessionInitialPrompt
                ? composeSessionInitialPromptText(externalDraft, activeSessionInitialPrompt)
                : externalDraft;
            adoptDraftText(nextDraft);
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.storedDraft');
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.storedDraft');
        } else if (forkInitialPromptText && !currentValue.trim()) {
            const nextDraft = activeSessionInitialPrompt
                ? composeSessionInitialPromptText(forkInitialPromptText, activeSessionInitialPrompt)
                : forkInitialPromptText;
            adoptDraftText(nextDraft);
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus');
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.forkPrompt');
        } else if (activeSessionInitialPrompt && canAdoptWithoutExternalDraft) {
            const nextDraft = composeSessionInitialPromptText(currentValue, activeSessionInitialPrompt);
            adoptDraftText(nextDraft);
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus');
        } else if (!storedDraft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [activeSessionInitialPrompt, adoptDraftText, clearForkInitialPrompt, clearSessionInitialPrompt, composeSessionInitialPromptText, forkInitialPromptText, isFocused, onChange, saveDraftForSession, sessionId, storedDraft]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Only save if value has changed
        const skip = autosaveSkip.current;
        if (skip && skip.sessionId === sessionId && skip.value === value) {
            autosaveSkip.current = null;
            return;
        }

        if (value !== lastSavedValue.current) {
            const wasEmpty = !containsLikelyNonWhitespace(lastSavedValue.current);
            const isEmpty = !containsLikelyNonWhitespace(value);
            const shouldDebounceForLargeDraft = isLargeTextInputValueLength(value.length);

            if (wasEmpty !== isEmpty && !shouldDebounceForLargeDraft) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback on normal-sized drafts.
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (or is too large for synchronous first-transition persistence).
                // Debounce to avoid excessive synchronous storage writes while the composer is active.
                saveTimeoutRef.current = setTimeout(() => {
                    saveDraft(value);
                }, autoSaveInterval);
            }
            // If both are empty, no need to save
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, sessionId, autoSaveInterval, saveDraft]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                flushLatestDraftIfChanged();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [flushLatestDraftIfChanged, sessionId]);

    useWebLifecycleFlush(Boolean(sessionId), flushLatestDraftIfChanged);

    // Save on unmount only; session changes are handled explicitly above so they do not race with clearDraft().
    useEffect(() => {
        return () => {
            const currentSessionId = lastSessionId.current;
            const currentValue = latestValue.current;
            if (currentSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(currentSessionId, currentValue);
            }
        };
    }, [saveDraftForSession]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        storage.getState().updateSessionDraft(sessionId, null);
        latestValue.current = '';
        lastSavedValue.current = '';
    }, [sessionId]);

    const clearDraftForSessionIfCurrentValueMatches = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            const targetDraft = storage.getState().sessions[targetSessionId]?.draft;
            if (targetDraft !== snapshot.text) return false;
            storage.getState().updateSessionDraft(targetSessionId, null);
            return true;
        }

        if (latestValue.current !== snapshot.text) {
            if (latestValue.current !== lastSavedValue.current) {
                saveDraftForSession(targetSessionId, latestValue.current);
            }
            return false;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        storage.getState().updateSessionDraft(targetSessionId, null);
        onChange('');
        latestValue.current = '';
        lastSavedValue.current = '';
        autosaveSkip.current = { sessionId: targetSessionId, value: '' };
        return true;
    }, [onChange, saveDraftForSession]);

    const clearDraftIfCurrentValueMatches = useCallback((expectedValue: string) => {
        if (!sessionId) return false;
        return clearDraftForSessionIfCurrentValueMatches({
            sessionId,
            text: expectedValue,
        });
    }, [clearDraftForSessionIfCurrentValueMatches, sessionId]);

    const restoreDraft = useCallback((draft: string) => {
        if (!sessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        onChange(draft);
        saveDraftForSession(sessionId, draft);
        latestValue.current = draft;
        lastSavedValue.current = draft;
        autosaveSkip.current = { sessionId, value: draft };
    }, [onChange, saveDraftForSession, sessionId]);

    const restoreComposerSnapshot = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return;

        if (lastSessionId.current !== targetSessionId) {
            saveDraftForSession(targetSessionId, snapshot.text);
            return;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        onChange(snapshot.text);
        saveDraftForSession(targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
    }, [onChange, saveDraftForSession]);

    const restoreDraftForSessionIfCurrentValueMatches = useCallback((
        snapshot: SessionDraftTextSnapshot,
        expectedCurrentValue: string,
    ) => {
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            const targetDraft = storage.getState().sessions[targetSessionId]?.draft;
            const currentValue = typeof targetDraft === 'string' ? targetDraft : '';
            if (currentValue !== expectedCurrentValue) return false;
            saveDraftForSession(targetSessionId, snapshot.text);
            return true;
        }

        if (latestValue.current !== expectedCurrentValue) {
            if (latestValue.current !== lastSavedValue.current) {
                saveDraftForSession(targetSessionId, latestValue.current);
            }
            return false;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        onChange(snapshot.text);
        saveDraftForSession(targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
        return true;
    }, [onChange, saveDraftForSession]);

    return {
        clearDraft,
        clearDraftIfCurrentValueMatches,
        clearDraftForSessionIfCurrentValueMatches,
        setDraftValue,
        restoreDraftForSessionIfCurrentValueMatches,
        restoreDraft,
        restoreComposerSnapshot,
    };
}
