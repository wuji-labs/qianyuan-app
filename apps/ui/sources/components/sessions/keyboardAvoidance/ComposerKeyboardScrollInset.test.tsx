import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    ComposerKeyboardProvider,
    ComposerKeyboardScrollInset,
} from '@/components/sessions/keyboardAvoidance';
import {
    createMockComposerKeyboardLayout,
    renderScreen,
} from '@/dev/testkit';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

describe('ComposerKeyboardScrollInset', () => {
    it('renders the current list inset before subscription replay', async () => {
        const onHeightChange = vi.fn();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 68,
                composerHeight: 100,
                keyboardHeightForInset: 68,
                listBottomInset: 168,
            }),
            subscribeListBottomInset: () => () => {},
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        if (!node) {
            throw new Error('Expected transcript composer keyboard inset to render.');
        }
        const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
        const height = styles.reduce<number | undefined>((value, style) => (
            typeof style?.height === 'number' ? style.height : value
        ), undefined);

        expect(height).toBe(168);
        expect(onHeightChange).toHaveBeenCalledWith(168);
    });

    it('uses subscribed list inset updates so native lists reserve composer space', async () => {
        const listeners = new Set<(height: number) => void>();
        const layout = {
            ...createMockComposerKeyboardLayout({ listBottomInset: 0 }),
            subscribeListBottomInset: (listener: (height: number) => void) => {
                listeners.add(listener);
                listener(0);
                return () => {
                    listeners.delete(listener);
                };
            },
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
            </ComposerKeyboardProvider>,
        );

        const readHeight = () => {
            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            return styles.reduce<number | undefined>((height, style) => (
                typeof style?.height === 'number' ? style.height : height
            ), undefined);
        };

        expect(readHeight()).toBe(0);

        await act(async () => {
            layout.composerHeight.value = 120;
            layout.keyboardHeightForInset.value = 72;
            layout.bottomInset.value = 72;
            layout.listBottomInset.value = 192;
            for (const listener of listeners) {
                listener(192);
            }
        });

        expect(readHeight()).toBe(192);
    });

    it('ignores stale native total inset payloads after the composer and keyboard have collapsed', async () => {
        const onHeightChange = vi.fn();
        const listeners = new Set<(height: number) => void>();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 0,
                composerHeight: 134,
                keyboardHeightForInset: 0,
                listBottomInset: 134,
            }),
            subscribeListBottomInset: (listener: (height: number) => void) => {
                listeners.add(listener);
                listener(layout.listBottomInset.value);
                return () => {
                    listeners.delete(listener);
                };
            },
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const readHeight = () => {
            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            return styles.reduce<number | undefined>((height, style) => (
                typeof style?.height === 'number' ? style.height : height
            ), undefined);
        };

        expect(readHeight()).toBe(134);
        expect(onHeightChange).toHaveBeenCalledWith(134);

        await act(async () => {
            layout.listBottomInset.value = 303;
            for (const listener of listeners) {
                listener(303);
            }
        });

        expect(readHeight()).toBe(134);
        expect(onHeightChange).not.toHaveBeenCalledWith(303);
    });

    it('falls back to measured composer height when the native list inset has not replayed yet', async () => {
        const onHeightChange = vi.fn();
        const layout = {
            ...createMockComposerKeyboardLayout({
                bottomInset: 0,
                composerHeight: 125,
                listBottomInset: 0,
            }),
            subscribeListBottomInset: () => () => {},
        } satisfies ComposerKeyboardLayout;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        if (!node) {
            throw new Error('Expected transcript composer keyboard inset to render.');
        }
        const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
        const height = styles.reduce<number | undefined>((value, style) => (
            typeof style?.height === 'number' ? style.height : value
        ), undefined);

        expect(height).toBe(125);
        expect(onHeightChange).toHaveBeenCalledWith(125);
    });

    it('does not reserve composer fallback space on web because the composer is in normal layout flow', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        try {
            const layout = {
                ...createMockComposerKeyboardLayout({
                    bottomInset: 34,
                    composerHeight: 125,
                    listBottomInset: 0,
                }),
                subscribeListBottomInset: () => () => {},
            } satisfies ComposerKeyboardLayout;

            const screen = await renderScreen(
                <ComposerKeyboardProvider layout={layout}>
                    <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
                </ComposerKeyboardProvider>,
            );

            const node = screen.findByTestId('transcript-composer-keyboard-inset');
            if (!node) {
                throw new Error('Expected transcript composer keyboard inset to render.');
            }
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            const height = styles.reduce<number | undefined>((value, style) => (
                typeof style?.height === 'number' ? style.height : value
            ), undefined);

            expect(height).toBe(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
        }
    });
});
