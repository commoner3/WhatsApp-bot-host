const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const SESSION_DIR = path.join(__dirname, 'session');
const { SESSION_ID } = process.env;

function decodeSession(raw) {
  const encoded = raw.includes('!') ? raw.split('!').slice(1).join('!') : raw;
  let buf = Buffer.from(encoded, 'base64');
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const text = buf.toString('utf8');
  JSON.parse(text);
  return text;
}

if (!SESSION_ID) {
  console.error('SESSION_ID is missing.');
  process.exit(1);
}

try {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const credsFile = path.join(SESSION_DIR, 'creds.json');
  if (!fs.existsSync(credsFile)) {
    fs.writeFileSync(credsFile, decodeSession(SESSION_ID));
  }
} catch (err) {
  console.error('Could not read SESSION_ID:', err.message);
  process.exit(1);
}

delete process.env.SESSION_ID;

const bot = spawn('node', ['index.js'], { stdio: 'inherit', env: process.env });
bot.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => bot.kill('SIGTERM'));
