import type { TabType } from '@/components/ui/navigation/tabTypes';

export function resolveMainViewTabRoute(tab: TabType): string | null {
    if (tab === 'settings') return '/settings';
    return null;
}
