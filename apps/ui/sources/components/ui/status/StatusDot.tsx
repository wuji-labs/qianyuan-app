import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    testID?: string;
}

export const StatusDot = React.memo((props: StatusDotProps) => {
    if (Platform.OS === 'web') {
        return <WebStatusDot {...props} />;
    }
    if (props.isPulsing) {
        return <PulsingStatusDot {...props} />;
    }
    return <StaticStatusDot {...props} />;
});

function resolveBaseDotStyle(color: string, size: number): ViewStyle {
    return {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };
}

function WebStatusDot({ color, isPulsing, size = 6, style, testID }: StatusDotProps) {
    return (
        <View
            testID={testID}
            style={[
                resolveBaseDotStyle(color, size),
                isPulsing ? webPulseStyle : null,
                style,
            ]}
        />
    );
}

/**
 * Non-pulsing native dot. Renders a plain `View` with no Reanimated hooks so an idle dot does not
 * register an animated node with the native Reanimated registry. Hooks live only in
 * `PulsingStatusDot`, which the parent mounts behind a stable `isPulsing` boundary, keeping the
 * Rules of Hooks intact (each subcomponent has a fixed hook order).
 */
function StaticStatusDot({ color, size = 6, style, testID }: StatusDotProps) {
    return (
        <View
            testID={testID}
            style={[
                resolveBaseDotStyle(color, size),
                style,
            ]}
        />
    );
}

function PulsingStatusDot({ color, size = 6, style, testID }: StatusDotProps) {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        opacity.value = withRepeat(
            withTiming(0.3, { duration: 1000 }),
            -1, // infinite
            true // reverse
        );
    }, [opacity]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    return (
        <Animated.View
            testID={testID}
            style={[
                resolveBaseDotStyle(color, size),
                animatedStyle,
                style,
            ]}
        />
    );
}

type WebPulseStyle = ViewStyle & {
    animationDirection?: 'alternate';
    animationDuration?: string;
    animationIterationCount?: string;
    animationName?: string;
    animationTimingFunction?: string;
};

const webPulseStyle: WebPulseStyle = {
    animationDirection: 'alternate',
    animationDuration: '1000ms',
    animationIterationCount: 'infinite',
    animationName: 'happierStatusDotPulse',
    animationTimingFunction: 'ease-in-out',
};
