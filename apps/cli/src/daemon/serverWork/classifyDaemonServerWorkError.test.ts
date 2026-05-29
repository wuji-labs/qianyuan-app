import { describe, expect, it } from 'vitest';

import { createHttpStatusError } from '../../api/client/httpStatusError';
import { ConnectedServiceQuotaApiError } from '../../api/connectedServices/connectedServiceQuotaApiError';

type Classification = Readonly<{
  kind: string;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}>;

type ClassifierModule = {
  classifyDaemonServerWorkError?: (
    error: unknown,
    options?: Readonly<{ featureAbsentStatusCodes?: readonly number[] }>,
  ) => Classification;
};

async function loadClassifierModule(): Promise<ClassifierModule> {
  try {
    const path = './classifyDaemonServerWorkError';
    return (await import(path)) as unknown as ClassifierModule;
  } catch {
    return {};
  }
}

describe('classifyDaemonServerWorkError', () => {
  it('surfaces auth failures distinctly from transient network failures', async () => {
    const mod = await loadClassifierModule();

    expect(mod.classifyDaemonServerWorkError).toEqual(expect.any(Function));

    const classify = mod.classifyDaemonServerWorkError!;

    expect(classify(createHttpStatusError(401, 'auth expired'))).toMatchObject({
      kind: 'auth_failed',
      retryable: false,
      statusCode: 401,
    });

    expect(classify({ code: 'ECONNRESET' })).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('honors retry-after for rate-limited server work', async () => {
    const mod = await loadClassifierModule();

    expect(mod.classifyDaemonServerWorkError).toEqual(expect.any(Function));

    const classify = mod.classifyDaemonServerWorkError!;
    const classification = classify({
      response: {
        status: 429,
        headers: { 'retry-after': '3' },
      },
    });

    expect(classification).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 3000,
    });
  });

  it('classifies connected-service quota API rate limits from preserved error fields', async () => {
    const mod = await loadClassifierModule();

    expect(mod.classifyDaemonServerWorkError).toEqual(expect.any(Function));

    const classify = mod.classifyDaemonServerWorkError!;
    const classification = classify(new ConnectedServiceQuotaApiError({
      message: 'quota write failed',
      kind: 'retryable',
      status: 429,
      retryable: true,
      retryAfterMs: 7000,
    }));

    expect(classification).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 7000,
    });
  });

  it('classifies configured 404 responses as unsupported feature absence', async () => {
    const mod = await loadClassifierModule();

    expect(mod.classifyDaemonServerWorkError).toEqual(expect.any(Function));

    const classify = mod.classifyDaemonServerWorkError!;

    expect(classify(createHttpStatusError(404, 'not found'), { featureAbsentStatusCodes: [404] })).toMatchObject({
      kind: 'unsupported',
      retryable: false,
      statusCode: 404,
    });

    expect(classify(createHttpStatusError(404, 'not found'))).toMatchObject({
      kind: 'client_error',
      retryable: false,
      statusCode: 404,
    });
  });
});
