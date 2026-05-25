import * as React from 'react';
import { useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.native';

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const windowDimensions = useWindowDimensions();
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modal?.isKeyboardLiftSuppressedByModal === true);
    const layout = useComposerKeyboardLayout({
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};
    const newSessionScaffoldMaxHeight = React.useMemo(() => {
        if (props.mode !== 'newSession') return undefined;
        if (typeof props.safeAreaTop !== 'number' || !Number.isFinite(props.safeAreaTop)) return undefined;
        const safeTop = Math.max(0, props.safeAreaTop);
        const headerHeight = typeof props.headerHeight === 'number' && Number.isFinite(props.headerHeight)
            ? Math.max(0, props.headerHeight)
            : 0;
        return Math.max(0, Math.round(windowDimensions.height - safeTop - headerHeight));
    }, [props.headerHeight, props.mode, props.safeAreaTop, windowDimensions.height]);

    // Composer translateY = the keyboard/safe-area inset. The root scaffold inherits the native
    // modal content frame; adding a separate window-derived sheet height can overflow cold modal
    // presentations and push this bottom-anchored composer below the visible screen.
    const composerAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -layout.bottomInset.value }],
    }), [layout]);
    const handleScaffoldLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setScaffoldMeasuredHeight?.(event.nativeEvent.layout.height);
    }, [layout]);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
    }, [layout]);

    return (
        <ComposerKeyboardProvider layout={layout}>
            <View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                onLayout={handleScaffoldLayout}
                testID={props.testID}
                style={[
                    { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
                    typeof newSessionScaffoldMaxHeight === 'number' ? { maxHeight: newSessionScaffoldMaxHeight } : null,
                    props.style,
                ]}
            >
                <View
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flex: 1, minHeight: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </View>
                <Animated.View
                    testID={props.composerTestID}
                    onLayout={handleComposerLayout}
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface.base,
                        },
                        composerAnimatedStyle,
                    ]}
                >
                    {props.composer}
                </Animated.View>
            </View>
        </ComposerKeyboardProvider>
    );
}
