import { configuration } from '@/configuration';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

export function resolveServerHttpBaseUrl(): string {
  return resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
}
