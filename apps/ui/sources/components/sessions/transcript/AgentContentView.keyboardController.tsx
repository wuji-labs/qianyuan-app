import { useHeaderHeight } from '@/utils/platform/responsive';
import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { useKeyboardDismissOnTap } from './useKeyboardDismissOnTap';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder }) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const keyboardDismissOnTapHandlers = useKeyboardDismissOnTap();

    return (
        <KeyboardAvoidingView
            testID="agent-content-keyboard-host"
            behavior={Platform.OS === 'ios' ? 'translate-with-padding' : 'padding'}
            keyboardVerticalOffset={0}
            style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base }}
        >
            <View
                testID="agent-content-scroll-region"
                style={{ flex: 1, minHeight: 0 }}
                {...keyboardDismissOnTapHandlers}
            >
                {content ? (
                    <View style={{ flex: 1, minHeight: 0 }}>
                        {content}
                    </View>
                ) : null}
                {placeholder ? (
                    <ScrollView
                        style={{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                ) : null}
            </View>
            <View
                testID="agent-content-input-footer"
                style={{ backgroundColor: theme.colors.surface.base }}
            >
                {input}
            </View>
        </KeyboardAvoidingView>
    );
});
