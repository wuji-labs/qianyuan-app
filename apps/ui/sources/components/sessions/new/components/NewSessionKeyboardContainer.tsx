import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

export function NewSessionKeyboardContainer(props: Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    headerHeight: number;
    safeAreaBottom: number;
}>): React.ReactElement {
    if (Platform.OS === 'android') {
        return <View style={props.style}>{props.children}</View>;
    }

    const useTranslateKeyboardAvoidance = Platform.OS === 'ios';

    return (
        <KeyboardAvoidingView
            behavior={useTranslateKeyboardAvoidance ? 'translate-with-padding' : 'height'}
            keyboardVerticalOffset={useTranslateKeyboardAvoidance ? props.headerHeight : 0}
            style={props.style}
        >
            {props.children}
        </KeyboardAvoidingView>
    );
}
