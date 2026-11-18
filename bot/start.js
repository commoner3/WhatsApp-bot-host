#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const SESSION_DIR = path.join(__dirname, 'session');
const SESSION_FILE = path.join(SESSION_DIR, 'creds.json');
const { SESSION_ID } = process.env;

function decodeSession(raw) {
  const encoded = raw.includes('!') ? raw.split('!').slice(1).join('!') : raw;
  let buf = Buffer.from(encoded, 'base64');

  if (!buf.length || buf.toString('base64').replace(/=+$/, '') === '====') {
    throw new Error('SESSION_ID is not valid base64');
  }

  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf);
  }

  const text = buf.toString('utf8');
  JSON.parse(text);
  return text;
}

try {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  if (!fs.existsSync(SESSION_FILE) && SESSION_ID) {
    fs.writeFileSync(SESSION_FILE, decodeSession(SESSION_ID), { mode: 0o600 });
  }

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('SESSION_ID is missing and no persisted session exists');
  }
} catch (err) {
  console.error('Could not initialize WhatsApp session:', err.message);
  process.exit(1);
}

// Remove credentials from both the bot process environment and shell after decoding.
delete process.env.SESSION_ID;

if (!fs.existsSync(path.join(__dirname, 'index.js'))) {
  console.error('Bot entrypoint is missing: bot/index.js');
  process.exit(1);
}

const bot = spawn(process.execPath, ['index.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

bot.on('exit', (code, signal) => {
  if (signal) process.exit(128);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => bot.kill('SIGTERM'));
process.on('SIGINT', () => bot.kill('SIGINT'));
