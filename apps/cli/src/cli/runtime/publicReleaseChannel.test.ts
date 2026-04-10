import { describe, expect, it } from 'vitest';

import { inferPublicReleaseRingIdFromEnvAndArgv } from './publicReleaseChannel';

describe('inferPublicReleaseRingIdFromEnvAndArgv', () => {
    it('infers preview from the installed preview runtime path when argv no longer carries the preview launcher basename', () => {
        expect(
            inferPublicReleaseRingIdFromEnvAndArgv({
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
                    HAPPIER_RELEASE_RING: '',
                    HAPPIER_RELEASE_CHANNEL: '',
                },
                argv: [
                    '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                    '/home/test/.happier/cli-preview/versions/0.2.3/package-dist/index.mjs',
                    'service',
                    'install',
                ],
                execPath: '/home/test/.happier/cli-preview/current/happier',
            }),
        ).toBe('preview');
    });

    it('infers public dev from an explicit packaged entrypoint hint when argv and execPath are generic runtime paths', () => {
        expect(
            inferPublicReleaseRingIdFromEnvAndArgv({
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
                    HAPPIER_RELEASE_RING: '',
                    HAPPIER_RELEASE_CHANNEL: '',
                },
                argv: [
                    '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                    'service',
                    'install',
                ],
                execPath: '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                additionalCandidates: [
                    '/home/test/.happier/cli-dev/versions/0.2.3/package-dist/index.mjs',
                ],
            }),
        ).toBe('publicdev');
    });
});
