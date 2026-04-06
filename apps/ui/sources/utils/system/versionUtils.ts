/**
 * Utility functions for version comparison and validation
 */

// Minimum required CLI version for full compatibility
export const MINIMUM_CLI_VERSION = '0.1.0';
// Minimum required CLI version to safely consume server-side pending queue V2.
// Keep separate from MINIMUM_CLI_VERSION so it can be bumped independently.
export const MINIMUM_CLI_PENDING_QUEUE_V2_VERSION = MINIMUM_CLI_VERSION;
// Minimum CLI version that supports the active-session runtime prompt RPC path.
// The protocol landed during 0.1.0 dev builds, before the 0.2.0 release line.
export const MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION = '0.1.0-dev.0';
// Minimum CLI version that accepts the backendTarget-based spawn payload contract.
// The protocol landed during 0.1.0 dev builds, before the 0.2.0 release line.
export const MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION = '0.1.0-dev.0';

function normalizeComparableVersion(version: string): number[] {
    const trimmed = String(version ?? '').trim();
    const [baseVersion, rawSuffix = ''] = trimmed.split('-', 2);
    const baseParts = baseVersion.split('.').map(Number);

    if (!rawSuffix) {
        return baseParts;
    }

    const suffixParts = rawSuffix.split('.');
    const channel = suffixParts[0];
    if (channel !== 'dev' && channel !== 'preview') {
        return baseParts;
    }

    const channelRank = channel === 'dev' ? 1 : 2;
    const numericSuffixParts = suffixParts
        .slice(1)
        .map(Number)
        .filter((part) => Number.isFinite(part));

    return [...baseParts, channelRank, ...numericSuffixParts];
}

/**
 * Compare two semantic version strings
 * @param version1 First version to compare
 * @param version2 Second version to compare
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
    const v1Parts = normalizeComparableVersion(version1);
    const v2Parts = normalizeComparableVersion(version2);
    
    // Pad with zeros if needed
    const maxLength = Math.max(v1Parts.length, v2Parts.length);
    while (v1Parts.length < maxLength) v1Parts.push(0);
    while (v2Parts.length < maxLength) v2Parts.push(0);
    
    for (let i = 0; i < maxLength; i++) {
        if (v1Parts[i] > v2Parts[i]) return 1;
        if (v1Parts[i] < v2Parts[i]) return -1;
    }
    
    return 0;
}

/**
 * Check if a version meets the minimum requirement
 * @param version Version to check
 * @param minimumVersion Minimum required version (defaults to MINIMUM_CLI_VERSION)
 * @returns true if version >= minimumVersion
 */
export function isVersionSupported(version: string | undefined, minimumVersion: string = MINIMUM_CLI_VERSION): boolean {
    if (!version) return false;
    
    try {
        return compareVersions(version, minimumVersion) >= 0;
    } catch {
        // If version comparison fails, assume it's not supported
        return false;
    }
}

/**
 * Parse version string to extract major, minor, and patch numbers
 * @param version Version string to parse
 * @returns Object with major, minor, and patch numbers, or null if invalid
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    try {
        const cleanVersion = version.split('-')[0];
        const [major, minor, patch] = cleanVersion.split('.').map(Number);
        
        if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
            return null;
        }
        
        return { major, minor, patch };
    } catch {
        return null;
    }
}
