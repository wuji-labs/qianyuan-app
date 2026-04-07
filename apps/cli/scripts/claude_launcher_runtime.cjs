const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { withWindowsHide } = require('./childProcessOptions.cjs');

function resolvePathSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return fs.realpathSync(filePath);
    } catch {
        return filePath;
    }
}

function resolveHomeDir() {
    const envHome =
        process.platform === 'win32'
            ? (process.env.USERPROFILE || process.env.HOME)
            : process.env.HOME;
    const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
    return trimmed.length > 0 ? trimmed : os.homedir();
}

function expandHomeDirPath(filePath) {
    const raw = String(filePath ?? '').trim();
    if (raw === '~') return resolveHomeDir();
    if (raw.startsWith('~/') || raw.startsWith('~\\')) {
        return path.join(resolveHomeDir(), raw.slice(2));
    }
    return raw;
}

function shouldLogClaudeDetection() {
    const raw = ((process.env.HAPPIER_DEBUG_CLAUDE_LAUNCHER ?? process.env.DEBUG) || '').toString().trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (lower === '0' || lower === 'false' || lower === 'off' || lower === 'no') return false;
    return true;
}

function getClaudeCliPath() {
    const happierOverrideRaw = (process.env.HAPPIER_CLAUDE_PATH || '').trim();
    const happyOverrideRaw = (process.env.HAPPY_CLAUDE_PATH || '').trim();
    const envVarName = happierOverrideRaw ? 'HAPPIER_CLAUDE_PATH' : happyOverrideRaw ? 'HAPPY_CLAUDE_PATH' : null;
    const overrideRaw = (happierOverrideRaw || happyOverrideRaw || '').trim();
    if (overrideRaw) {
        if (overrideRaw === 'claude') {
            if (shouldLogClaudeDetection()) {
                console.error(`\x1b[90mUsing Claude Code from ${envVarName ?? 'HAPPIER_CLAUDE_PATH'}=claude\x1b[0m`);
            }
            return 'claude';
        }

        const expandedOverride = expandHomeDirPath(overrideRaw);
        const resolvedOverride = resolvePathSafe(expandedOverride) || expandedOverride;
        if (!fs.existsSync(resolvedOverride)) {
            console.error(`\n\x1b[1m\x1b[33mClaude Code path not found\x1b[0m\n`);
            console.error(`${envVarName ?? 'HAPPIER_CLAUDE_PATH'} points to a missing file: ${overrideRaw}\n`);
            process.exit(1);
        }

        if (shouldLogClaudeDetection()) {
            console.error(`\x1b[90mUsing Claude Code from ${envVarName ?? 'HAPPIER_CLAUDE_PATH'} (${resolvedOverride})\x1b[0m`);
        }
        return resolvedOverride;
    }

    if (shouldLogClaudeDetection()) {
        console.error('\x1b[90mUsing Claude Code from PATH (claude)\x1b[0m');
    }
    return 'claude';
}

function isWindowsShellShimPath(filePath) {
    const lower = (filePath || '').toString().toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function buildClaudeBinarySpawnInvocation(params) {
    const platform = params.platform || process.platform;
    const cliPath = (params.cliPath || '').toString();
    const args = Array.isArray(params.args) ? params.args : [];

    if (platform === 'win32') {
        const forceViaComspecRaw = (process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC || '').toString().trim().toLowerCase();
        const forceViaComspec =
            forceViaComspecRaw.length > 0 &&
            forceViaComspecRaw !== '0' &&
            forceViaComspecRaw !== 'false' &&
            forceViaComspecRaw !== 'off' &&
            forceViaComspecRaw !== 'no';

        if (forceViaComspec || isWindowsShellShimPath(cliPath)) {
            const comspec = (params.comspec || process.env.ComSpec || 'cmd.exe').toString();
            return {
                command: comspec,
                args: ['/d', '/s', '/c', cliPath, ...args],
            };
        }
    }

    return { command: cliPath, args };
}

function attachChildSignalForwarding(child, proc = process) {
    const forwardSignal = (signal) => {
        try {
            if (child && child.pid && !child.killed) {
                child.kill(signal);
            }
        } catch {
            // ignore
        }
    };

    const signals = ['SIGTERM', 'SIGINT'];
    if (proc.platform !== 'win32') {
        signals.push('SIGHUP');
    }

    for (const signal of signals) {
        proc.on(signal, () => forwardSignal(signal));
    }
}

function runClaudeCli(cliPath) {
    const isJsFile = cliPath.endsWith('.js') || cliPath.endsWith('.cjs') || cliPath.endsWith('.mjs');

    if (isJsFile) {
        const importUrl = pathToFileURL(cliPath).href;
        import(importUrl);
        return;
    }

    const args = process.argv.slice(2);
    const invocation = buildClaudeBinarySpawnInvocation({ cliPath, args });
    const child = spawn(invocation.command, invocation.args, withWindowsHide({
        stdio: 'inherit',
        env: process.env,
    }));

    attachChildSignalForwarding(child);
    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}

module.exports = {
    attachChildSignalForwarding,
    buildClaudeBinarySpawnInvocation,
    getClaudeCliPath,
    runClaudeCli,
};
