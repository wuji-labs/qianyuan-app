import * as React from 'react';
import { Stack } from 'expo-router';

import { t } from '@/text';

export default function SetupLayout() {
    const indexScreenOptions = {
        title: t('setupOnboarding.screenTitle'),
    } as const;

    return (
        <Stack>
            <Stack.Screen
                name="index"
                options={indexScreenOptions}
            />
        </Stack>
    );
}
