import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';

import { deriveMeshGradientAvatar } from './deriveMeshGradientAvatar';
import { createMeshGradientCssBackground } from './meshGradientCssBackground';
import type { MeshGradientThemeInput } from './meshGradientTypes';

type AvatarMeshGradientProps = Readonly<{
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}>;

export const AvatarMeshGradient = React.memo((props: AvatarMeshGradientProps) => {
    const { id, square, size = 48, monochrome = false } = props;
    const { theme } = useUnistyles();
    const themeInput: MeshGradientThemeInput = React.useMemo(() => ({
        surface: theme.colors.surface,
        surfaceHigh: theme.colors.surfaceHigh,
        surfaceHighest: theme.colors.surfaceHighest,
        textSecondary: theme.colors.textSecondary,
        accentColors: [
            theme.colors.accent.blue,
            theme.colors.accent.green,
            theme.colors.accent.orange,
            theme.colors.accent.yellow,
            theme.colors.accent.red,
            theme.colors.accent.indigo,
            theme.colors.accent.purple,
        ],
    }), [theme]);
    const model = React.useMemo(() => deriveMeshGradientAvatar({
        id,
        size,
        monochrome,
        theme: themeInput,
    }), [id, monochrome, size, themeInput]);
    const containerStyle = React.useMemo((): ViewStyle => ({
        width: size,
        height: size,
        borderRadius: square ? 0 : size / 2,
        overflow: 'hidden',
        position: 'relative',
        ...(Platform.OS === 'web' ? createMeshGradientCssBackground(model, size) : null),
    }), [model, size, square]);

    if (Platform.OS === 'web') {
        return (
            <View
                testID="avatar-generated-meshGradient"
                style={containerStyle}
            />
        );
    }

    return (
        <View
            testID="avatar-generated-meshGradient"
            style={containerStyle}
        >
            <LinearGradient
                colors={[model.baseGradient.startColor, model.baseGradient.endColor]}
                start={{
                    x: model.baseGradient.startX / size,
                    y: model.baseGradient.startY / size,
                }}
                end={{
                    x: model.baseGradient.endX / size,
                    y: model.baseGradient.endY / size,
                }}
                style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                }}
            />
            {model.colorFields.map((field, index) => (
                <View
                    key={`field-${index}`}
                    style={{
                        position: 'absolute',
                        left: field.cx - field.radius,
                        top: field.cy - field.radius,
                        width: field.radius * 2,
                        height: field.radius * 2,
                        borderRadius: field.radius,
                        backgroundColor: field.color,
                        opacity: field.opacity,
                    }}
                />
            ))}
            {model.waveFields.map((field, index) => (
                <LinearGradient
                    key={`wave-${index}`}
                    colors={[field.transparentColor, field.color, field.transparentColor]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={{
                        position: 'absolute',
                        left: field.x,
                        top: field.y,
                        width: field.width,
                        height: field.height,
                        opacity: field.opacity,
                        transform: [{ rotate: `${field.rotation}deg` }],
                    }}
                />
            ))}
        </View>
    );
});
