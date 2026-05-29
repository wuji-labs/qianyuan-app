import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_ACCESS_TOKEN',
] as const;

let envScope = createEnvKeyScope(ENV_KEYS);
const tempDirs = new Set<string>();

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(ENV_KEYS);
  for (const dir of tempDirs) removeTempDirSync(dir);
  tempDirs.clear();
  vi.resetModules();
});

describe('buildHappierToolsShellBridgeCommand', () => {
  it('pins the Happier home as a defense-in-depth fallback and invokes the tools CLI without embedding credentials', async () => {
    const happierHome = createTempDirSync('happier-tools-shell-bridge-home-');
    tempDirs.add(happierHome);
    envScope.patch({
      HAPPIER_HOME_DIR: happierHome,
      HAPPIER_ACTIVE_SERVER_ID: 'preview',
      HAPPIER_SERVER_URL: 'https://preview.happier.example',
      HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:48999',
      HAPPIER_PUBLIC_SERVER_URL: 'https://public.happier.example',
      HAPPIER_WEBAPP_URL: 'https://app.happier.example',
      HAPPIER_ACCESS_TOKEN: 'secret-token-that-must-not-be-embedded',
    });
    vi.resetModules();

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');

    const command = buildHappierToolsShellBridgeCommand([
      'call',
      '--source',
      'happier',
      '--tool',
      'change_title',
      '--args-json',
      '{"title":"Renamed"}',
      '--json',
    ]);

    // Home dir stays inline as a credential-resolution safety net.
    expect(command).toContain(`HAPPIER_HOME_DIR='${happierHome}'`);
    // The full server context is now injected at the coding-agent spawn boundary
    // (and inherited by this command), so it must NOT bloat every tool command.
    expect(command).not.toContain('HAPPIER_ACTIVE_SERVER_ID=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_LOCAL_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_PUBLIC_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_WEBAPP_URL=');
    // Still a binary-safe invocation of the tools CLI.
    expect(command).toContain("'tools' 'call'");
    expect(command).toContain("'--tool' 'change_title'");
    // Never embed credentials.
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });
});
