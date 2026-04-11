import * as React from 'react';
import { useRouter } from 'expo-router';

import { t } from '@/text';

import { SessionEmptyStateCard } from './SessionEmptyStateCard';

export function HiddenInactiveSessionsEmptyState(): React.ReactElement {
    const router = useRouter();

    return (
        <SessionEmptyStateCard
            title={t('settingsFeatures.hiddenInactiveSessionsEmptyStateTitle')}
            subtitle={t('settingsFeatures.hiddenInactiveSessionsEmptyStateSubtitle')}
            iconName="eye-off-outline"
            actionLabel={t('sessionInfo.inactiveAndArchivedSessions')}
            onPressAction={() => router.push('/session/archived' as any)}
        />
    );
}
