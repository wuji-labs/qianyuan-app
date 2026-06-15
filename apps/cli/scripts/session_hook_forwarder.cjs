#!/usr/bin/env node
/**
 * Session Hook Forwarder
 * 
 * This script is executed by Claude's SessionStart hook.
 * It reads JSON data from stdin and forwards it to Happier's hook server.
 * 
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [hook_event_name]
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);

// Args after the port: an optional hook event name, then optional `--secret-file <path>`
// (keeps the secret off the world-visible command line; mirrors permission_hook_forwarder.cjs).
let hookEventName = '';
let secretFilePath = '';
const restArgs = process.argv.slice(3);
for (let i = 0; i < restArgs.length; i += 1) {
    const arg = restArgs[i];
    if (arg === '--secret-file') {
        secretFilePath = typeof restArgs[i + 1] === 'string' ? restArgs[i + 1] : '';
        i += 1;
        continue;
    }
    if (!hookEventName && typeof arg === 'string' && arg.length > 0) {
        hookEventName = arg;
    }
}

let secret = '';
if (secretFilePath) {
    try {
        secret = require('fs').readFileSync(secretFilePath, 'utf8').trim();
    } catch {
        // Unreadable secret file: forward without a secret; the server rejects if it requires one.
        secret = '';
    }
}

if (!port || isNaN(port)) {
    process.exit(1);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    let body = Buffer.concat(chunks);
    if (hookEventName) {
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.hook_event_name !== 'string') {
                parsed.hook_event_name = hookEventName;
                body = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
        } catch {
            // Preserve original payload if Claude sends unexpected data.
        }
    }
    
    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: '/hook/session-start',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            ...(secret.length > 0 ? { 'x-happier-hook-secret': secret } : {})
        }
    }, (res) => {
        res.resume(); // Drain response
    });
    
    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });
    
    req.end(body);
});

process.stdin.resume();
