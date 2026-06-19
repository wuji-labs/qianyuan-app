export type TerminalConnectLinks = Readonly<{
  webUrl: string;
  mobileUrl: string;
}>;

export type ConfigureServerLinks = Readonly<{
  webUrl: string;
  mobileUrl: string;
}>;

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);

// Brand deep-link scheme for the companion mobile app. The app (apps/ui) defines
// its scheme per variant in appVariantConfig.cjs (production = `qianyuan`); the CLI
// must emit the SAME scheme or the app rejects the pairing link as invalid.
// Defaults to the 乾元無極 (qianyuan) production scheme; override via
// HAPPIER_APP_SCHEME for other variants (qianyuan-dev, qianyuan-preview, …).
const APP_SCHEME = ((typeof process !== 'undefined' && process.env && process.env.HAPPIER_APP_SCHEME) || 'qianyuan')
  .trim()
  .replace(/:(\/\/)?$/, '') || 'qianyuan';

function isLoopbackHostname(hostname: string): boolean {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.localhost')) return true;
  return false;
}

function parseSafeServerUrl(raw: string): URL | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function isLocalWebappUrl(raw: string): boolean {
  const parsed = parseSafeServerUrl(raw);
  if (!parsed) return false;
  return isLoopbackHostname(parsed.hostname);
}

function sanitizeServerUrlForWebLink(raw: string, webappUrl: string): string | null {
  const parsed = parseSafeServerUrl(raw);
  if (!parsed) return null;
  if (isLoopbackHostname(parsed.hostname) && !isLocalWebappUrl(webappUrl)) return null;
  return stripTrailingSlash(parsed.toString());
}

function sanitizeServerUrlForMobileLink(raw: string): string | null {
  const parsed = parseSafeServerUrl(raw);
  if (!parsed) return null;
  if (isLoopbackHostname(parsed.hostname)) return null;
  return stripTrailingSlash(parsed.toString());
}

export function buildTerminalConnectLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
  publicKeyB64Url: string;
}>): TerminalConnectLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const webServerUrl = sanitizeServerUrlForWebLink(params.serverUrl, webappUrl);
  const mobileServerUrl = sanitizeServerUrlForMobileLink(params.serverUrl);
  const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
  const encodedWebServerUrl = webServerUrl ? encodeURIComponent(webServerUrl) : '';
  const encodedMobileServerUrl = mobileServerUrl ? encodeURIComponent(mobileServerUrl) : '';

  return {
    webUrl: webServerUrl
      ? `${webappUrl}/terminal/connect#key=${publicKeyB64Url}&server=${encodedWebServerUrl}`
      : `${webappUrl}/terminal/connect#key=${publicKeyB64Url}`,
    mobileUrl: mobileServerUrl
      ? `${APP_SCHEME}://terminal?key=${publicKeyB64Url}&server=${encodedMobileServerUrl}`
      : `${APP_SCHEME}://terminal?key=${publicKeyB64Url}`,
  };
}

export function buildConfigureServerLinks(params: Readonly<{
  webappUrl: string;
  serverUrl: string;
}>): ConfigureServerLinks {
  const webappUrl = stripTrailingSlash(String(params.webappUrl ?? '').trim());
  const webServerUrl = sanitizeServerUrlForWebLink(params.serverUrl, webappUrl);
  const mobileServerUrl = sanitizeServerUrlForMobileLink(params.serverUrl);
  const encodedWebServerUrl = webServerUrl ? encodeURIComponent(webServerUrl) : '';
  const encodedMobileServerUrl = mobileServerUrl ? encodeURIComponent(mobileServerUrl) : '';
  if (!webServerUrl && !mobileServerUrl) {
    return { webUrl: webappUrl, mobileUrl: `${APP_SCHEME}://server` };
  }

  return {
    // Prefer setting the server on any screen via `?server=` so callers don't need to navigate
    // to a dedicated server selection route first.
    webUrl: webServerUrl ? `${webappUrl}/?server=${encodedWebServerUrl}` : webappUrl,
    mobileUrl: mobileServerUrl ? `${APP_SCHEME}://server?url=${encodedMobileServerUrl}` : `${APP_SCHEME}://server`,
  };
}
