import { createHash } from 'node:crypto';

type NativeQuotaProfileIdKind = 'acct' | 'native';

function hashProfileMaterial(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 48);
}

export function buildNativeQuotaProfileId(params: Readonly<{
  kind: NativeQuotaProfileIdKind;
  providerId: string;
  material: string;
}>): string {
  const providerId = params.providerId.trim();
  const material = params.material.trim();
  const hash = hashProfileMaterial(`${providerId}:${material || 'unknown'}`);
  return `${params.kind}:${hash}`;
}
