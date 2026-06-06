import { KIMI_PROVIDER_FIELDS } from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export const KIMI_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'kimi',
    title: { key: 'settingsProviders.plugins.kimi.title' },
    icon: { ionName: 'leaf-outline', color: { kind: 'theme', token: 'green' } },
    settings: KIMI_PROVIDER_FIELDS,
    uiSections: [
        {
            id: 'kimiCompatibility',
            title: { key: 'settingsProviders.plugins.kimi.sections.compatibility.title' },
            footer: { key: 'settingsProviders.plugins.kimi.sections.compatibility.footer' },
            fields: [
                {
                    key: 'kimiAcpPythonSelector',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.title' },
                    subtitle: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.subtitle' },
                    enumOptions: [
                        {
                            id: 'auto',
                            title: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.auto.title' },
                            subtitle: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.auto.subtitle' },
                        },
                        {
                            id: 'poll',
                            title: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.poll.title' },
                            subtitle: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.poll.subtitle' },
                        },
                    ],
                },
            ],
        },
    ],
    buildOutgoingMessageMetaExtras: () => ({}),
};
