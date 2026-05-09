import { describe, expect, it } from 'vitest';

import { readServerEnabledBit } from '../serverEnabledBit.js';
import { FeaturesResponseSchema } from './featuresResponseSchema.js';

describe('FeatureGatesSchema', () => {
  it('preserves pets companion and sync gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        pets: {
          companion: { enabled: true },
          sync: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'pets.companion' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'pets.sync' as never)).toBe(true);
  });

  it('preserves channel bridge gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        channelBridges: {
          enabled: true,
          telegram: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'channelBridges')).toBe(true);
    expect(readServerEnabledBit(parsed, 'channelBridges.telegram')).toBe(true);
  });

  it('preserves generated session media gates separately from attachment upload gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        attachments: {
          uploads: { enabled: true },
        },
        session: {
          media: {
            generated: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'attachments.uploads')).toBe(true);
    expect(readServerEnabledBit(parsed, 'session.media.generated')).toBe(true);
  });
});
