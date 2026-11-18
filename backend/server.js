require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Docker = require('dockerode');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const docker = new Docker();

const {
  JWT_SECRET,
  SESSION_ENC_KEY,
  PAYSTACK_SECRET_KEY,
  PAYSTACK_CALLBACK_URL,
  BOT_IMAGE,
} = process.env;
const MAX_BOTS = parseInt(process.env.MAX_BOTS_PER_USER || '3', 10);
const MAX_FREE_BOTS = parseInt(process.env.MAX_FREE_BOTS || '20', 10);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KEY = Buffer.from(SESSION_ENC_KEY || '', 'hex');
if (KEY.length !== 32) {
  console.error('SESSION_ENC_KEY must be 64 hex characters (32 bytes).');
  process.exit(1);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('hex')).join(':');
}

function decrypt(payload) {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted session');
  const [iv, tag, enc] = parts.map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function startBotContainer(bot, sessionId, ramMb) {
  const container = await docker.createContainer({
    Image: BOT_IMAGE,
    name: `bot-${bot.id}`,
    Env: [
      `SESSION_ID=${sessionId}`,
      `OWNER_NUMBER=${bot.owner_number}`,
      `BOT_NAME=${bot.name}`,
    ],
    HostConfig: {
      Memory: ramMb * 1024 * 1024,
      NanoCpus: 500000000,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'bridge',
    },
  });
  await container.start();
  return container.id;
}

async function stopAndRemoveContainer(containerId) {
  if (!containerId) return;
  try {
    const c = docker.getContainer(containerId);
    await c.stop({ t: 5 }).catch(() => {});
    await c.remove({ force: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

async function countRunningFree() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM bots b JOIN plans p ON p.id=b.plan_id
      WHERE p.coin_cost=0 AND b.status='running'`
  );
  return rows[0].n;
}

app.post(
  '/api/paystack/webhook',
  express.raw({ type: 'application/json' }),
  wrap(async (req, res) => {
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');

    if (!signature || signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success') await creditPayment(event.data.reference);
    res.sendStatus(200);
  })
);

async function creditPayment(reference) {
  const r = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const body = await r.json();
  if (!body.status || body.data.status !== 'success') return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query(
      `SELECT p.id, p.user_id, p.amount, p.status, c.coins
         FROM payments p JOIN coin_packages c ON c.id=p.package_id
        WHERE p.reference=$1 FOR UPDATE OF p`,
      [reference]
    );
    const pay = p.rows[0];
    if (!pay || pay.status === 'success') {
      await client.query('ROLLBACK');
      return;
    }
    if (body.data.amount !== pay.amount) {
      await client.query(`UPDATE payments SET status='failed' WHERE id=$1`, [pay.id]);
      await client.query('COMMIT');
      return;
    }
    await client.query(`UPDATE payments SET status='success', paid_at=now() WHERE id=$1`, [pay.id]);
    await client.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [pay.coins, pay.user_id]);
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, payment_id)
       VALUES ($1, 'purchase', $2, $3)`,
      [pay.user_id, pay.coins, pay.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false }));
app.use(express.json({ limit: '100kb' }));
app.use('/auth', require('./auth')(pool, wrap));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, coins, role FROM users WHERE id=$1`, [req.userId]
  );
  if (!rows[0]) throw new HttpError(404, 'User not found');
  res.json(rows[0]);
}));

app.get('/api/plans', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, coin_cost, duration_days FROM plans WHERE active ORDER BY coin_cost`
  );
  res.json(rows);
}));

app.get('/api/packages', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, price, currency, coins FROM coin_packages
      WHERE active ORDER BY price`
  );
  res.json(rows);
}));

app.post('/api/payments/init', requireAuth, wrap(async (req, res) => {
  const pkg = (await pool.query(
    `SELECT * FROM coin_packages WHERE id=$1 AND active`, [req.body.packageId]
  )).rows[0];
  if (!pkg) throw new HttpError(404, 'Package not found');

  const user = (await pool.query(`SELECT email FROM users WHERE id=$1`, [req.userId])).rows[0];
  const reference = 'pay_' + crypto.randomBytes(12).toString('hex');

  await pool.query(
    `INSERT INTO payments (user_id, package_id, reference, amount)
     VALUES ($1, $2, $3, $4)`,
    [req.userId, pkg.id, reference, pkg.price]
  );

  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      amount: pkg.price,
      currency: pkg.currency,
      reference,
      callback_url: PAYSTACK_CALLBACK_URL,
    }),
  });
  const body = await r.json();
  if (!body.status) throw new HttpError(502, 'Could not start payment');

  res.json({ checkoutUrl: body.data.authorization_url, reference });
}));

app.post('/api/deploy', requireAuth, wrap(async (req, res) => {
  const { sessionId, name, ownerNumber, planId } = req.body;

  if (typeof sessionId !== 'string' || sessionId.length < 10 || sessionId.length > 20000)
    throw new HttpError(400, 'Invalid session ID');
  if (typeof name !== 'string' || !name.trim() || name.length > 40)
    throw new HttpError(400, 'Bot name is required (max 40 characters)');
  if (!/^\d{7,15}$/.test(ownerNumber || ''))
    throw new HttpError(400, 'Owner number: digits only, with country code, no + or spaces');

  const plan = (await pool.query(`SELECT * FROM plans WHERE id=$1 AND active`, [planId])).rows[0];
  if (!plan) throw new HttpError(404, 'Plan not found');

  const count = (await pool.query(`SELECT count(*)::int AS n FROM bots WHERE user_id=$1`, [req.userId])).rows[0].n;
  if (count >= MAX_BOTS) throw new HttpError(403, `Limit of ${MAX_BOTS} bots reached`);

  if (plan.coin_cost === 0) {
    const mine = (await pool.query(
      `SELECT count(*)::int AS n FROM bots b JOIN plans p ON p.id=b.plan_id
        WHERE b.user_id=$1 AND p.coin_cost=0`, [req.userId]
    )).rows[0].n;
    if (mine >= 1) throw new HttpError(403, 'You already have a free bot. Delete it or choose a paid plan.');
    if ((await countRunningFree()) >= MAX_FREE_BOTS)
      throw new HttpError(503, 'Free slots are full right now. Try later or use a paid plan.');
  }

  const client = await pool.connect();
  let bot;
  try {
    await client.query('BEGIN');
    const paid = await client.query(
      `UPDATE users SET coins=coins-$1 WHERE id=$2 AND coins>= $1 RETURNING coins`,
      [plan.coin_cost, req.userId]
    );
    if (!paid.rowCount) throw new HttpError(402, 'Not enough coins');

    bot = (await client.query(
      `INSERT INTO bots (user_id, plan_id, name, owner_number, session_data, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'stopped',now()+($6||' days')::interval)
       RETURNING id,name,owner_number,expires_at`,
      [req.userId, plan.id, name.trim(), ownerNumber, encrypt(sessionId), String(plan.duration_days)]
    )).rows[0];

    if (plan.coin_cost > 0) {
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, bot_id)
         VALUES ($1,'rental',$2,$3)`,
        [req.userId, -plan.coin_cost, bot.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  try {
    const containerId = await startBotContainer(bot, sessionId, plan.ram_limit_mb);
    await pool.query(`UPDATE bots SET container_id=$1,status='running' WHERE id=$2`, [containerId, bot.id]);
  } catch (err) {
    console.error('Container start failed:', err.message);
    if (plan.coin_cost > 0) {
      await pool.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [plan.coin_cost, req.userId]);
      await pool.query(
        `INSERT INTO transactions (user_id,type,amount,bot_id)
         VALUES ($1,'admin',$2,NULL)`,
        [req.userId, plan.coin_cost]
      );
    }
    await pool.query(`DELETE FROM bots WHERE id=$1`, [bot.id]);
    throw new HttpError(500, 'Could not start your bot. Your coins were refunded.');
  }

  res.status(201).json({ id: bot.id, name: bot.name, status: 'running', expiresAt: bot.expires_at });
}));

app.get('/api/bots', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id,b.name,b.owner_number,b.status,b.expires_at,b.created_at,
            p.name AS plan_name,COALESCE(p.coin_cost,0) AS coin_cost,
            GREATEST(0,EXTRACT(EPOCH FROM (b.expires_at-now())))::int AS seconds_left
       FROM bots b LEFT JOIN plans p ON p.id=b.plan_id
      WHERE b.user_id=$1 ORDER BY b.created_at DESC`,
    [req.userId]
  );
  res.json(rows);
}));

async function getOwnBot(botId, userId) {
  const bot = (await pool.query(
    `SELECT b.*,p.ram_limit_mb FROM bots b LEFT JOIN plans p ON p.id=b.plan_id
      WHERE b.id=$1 AND b.user_id=$2`,
    [botId, userId]
  )).rows[0];
  if (!bot) throw new HttpError(404, 'Bot not found');
  return bot;
}

app.post('/api/bots/:id/stop', requireAuth, wrap(async (req, res) => {
  const bot = await getOwnBot(req.params.id, req.userId);
  await stopAndRemoveContainer(bot.container_id);
  await pool.query(`UPDATE bots SET status='stopped',container_id=NULL WHERE id=$1`, [bot.id]);
  res.json({ status: 'stopped' });
}));

app.post('/api/bots/:id/start', requireAuth, wrap(async (req, res) => {
  const bot = await getOwnBot(req.params.id, req.userId);
  if (bot.expires_at && bot.expires_at < new Date()) throw new HttpError(403, 'Rental expired. Extend it first.');
  if (bot.status === 'running') return res.json({ status: 'running' });
  const containerId = await startBotContainer(bot, decrypt(bot.session_data), bot.ram_limit_mb || 256);
  await pool.query(`UPDATE bots SET status='running',container_id=$1 WHERE id=$2`, [containerId, bot.id]);
  res.json({ status: 'running' });
}));

app.post('/api/bots/:id/restart', requireAuth, wrap(async (req, res) => {
  const bot = await getOwnBot(req.params.id, req.userId);
  await stopAndRemoveContainer(bot.container_id);
  const containerId = await startBotContainer(bot, decrypt(bot.session_data), bot.ram_limit_mb || 256);
  await pool.query(`UPDATE bots SET status='running',container_id=$1 WHERE id=$2`, [containerId, bot.id]);
  res.json({ status: 'running' });
}));

app.delete('/api/bots/:id', requireAuth, wrap(async (req, res) => {
  const bot = await getOwnBot(req.params.id, req.userId);
  await stopAndRemoveContainer(bot.container_id);
  await pool.query(`DELETE FROM bots WHERE id=$1`, [bot.id]);
  res.json({ deleted: true });
}));

const claimAttempts = new Map();
app.post('/api/coupons/claim', requireAuth, wrap(async (req, res) => {
  const now = Date.now();
  const recent = (claimAttempts.get(req.userId) || []).filter((t) => now-t < 60000);
  if (recent.length >= 5) throw new HttpError(429, 'Too many tries. Wait a minute and try again.');
  recent.push(now);
  claimAttempts.set(req.userId, recent);

  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new HttpError(400, 'Invalid coupon code');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = (await client.query(`SELECT * FROM coupons WHERE code=$1 FOR UPDATE`, [code])).rows[0];
    if (!c) throw new HttpError(404, 'Invalid coupon code');
    if (c.expires_at && new Date(c.expires_at) < new Date()) throw new HttpError(400, 'This coupon has expired');
    if (c.used_count >= c.max_uses) throw new HttpError(400, 'This coupon has been fully used');

    const claim = await client.query(
      `INSERT INTO coupon_redemptions (user_id,coupon_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [req.userId, c.id]
    );
    if (!claim.rowCount) throw new HttpError(400, 'You already claimed this coupon');

    await client.query(`UPDATE coupons SET used_count=used_count+1 WHERE id=$1`, [c.id]);
    const u = await client.query(`UPDATE users SET coins=coins+$1 WHERE id=$2 RETURNING coins`, [c.coins, req.userId]);
    await client.query(`INSERT INTO transactions (user_id,type,amount) VALUES ($1,'coupon',$2)`, [req.userId, c.coins]);
    await client.query('COMMIT');
    res.json({ added: c.coins, coins: u.rows[0].coins });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

function parseDockerLogs(buf) {
  if (!buf.length || buf[0] > 2) return buf.toString('utf8');
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.slice(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out;
}

app.get('/api/bots/:id/logs', requireAuth, wrap(async (req, res) => {
  const bot = await getOwnBot(req.params.id, req.userId);
  if (!bot.container_id) return res.json({ logs: '', running: false });

  let raw;
  try {
    raw = await docker.getContainer(bot.container_id).logs({ stdout: true, stderr: true, tail: 200 });
  } catch (err) {
    if (err.statusCode === 404) return res.json({ logs: '', running: false });
    throw err;
  }

  let text = parseDockerLogs(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
  text = text.replace(/\u001b\[[0-9;]*m/g, '');
  const sid = decrypt(bot.session_data);
  const secrets = [sid, sid.split('!').slice(1).join('!')].filter((s) => s.length >= 10);
  for (const s of secrets) text = text.split(s).join('[hidden]');
  res.json({ logs: text.slice(-20000), running: bot.status === 'running' });
}));

app.post('/api/bots/:id/extend', requireAuth, wrap(async (req, res) => {
  const bot = await getOwnBot(req.params.id, req.userId);
  const plan = (await pool.query(`SELECT * FROM plans WHERE id=$1`, [bot.plan_id])).rows[0];
  if (!plan) throw new HttpError(400, 'This bot has no plan to renew');

  const wasExpired = bot.status === 'expired';
  const secondsLeft = bot.expires_at ? (new Date(bot.expires_at) - Date.now()) / 1000 : 0;

  if (plan.coin_cost === 0) {
    if (secondsLeft > 86400) throw new HttpError(400, 'You can renew a free bot when less than 1 day is left.');
    if (wasExpired && (await countRunningFree()) >= MAX_FREE_BOTS)
      throw new HttpError(503, 'Free slots are full right now. Try later or use a paid plan.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (plan.coin_cost > 0) {
      const paid = await client.query(
        `UPDATE users SET coins=coins-$1 WHERE id=$2 AND coins>= $1 RETURNING coins`,
        [plan.coin_cost, req.userId]
      );
      if (!paid.rowCount) throw new HttpError(402, 'Not enough coins');
      await client.query(`INSERT INTO transactions (user_id,type,amount,bot_id) VALUES ($1,'extend',$2,$3)`, [req.userId,-plan.coin_cost,bot.id]);
    }
    await client.query(
      `UPDATE bots SET expires_at=GREATEST(now(),COALESCE(expires_at,now()))+($1||' days')::interval,
              status=CASE WHEN status='expired' THEN 'stopped' ELSE status END WHERE id=$2`,
      [String(plan.duration_days), bot.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (wasExpired) {
    try {
      const containerId = await startBotContainer(bot, decrypt(bot.session_data), bot.ram_limit_mb || 256);
      await pool.query(`UPDATE bots SET status='running',container_id=$1 WHERE id=$2`, [containerId, bot.id]);
    } catch (err) {
      console.error('Restart after renew failed:', err.message);
      throw new HttpError(500, 'Renewed, but the bot did not start. Tap Start to try again.');
    }
  }

  const { rows } = await pool.query(`SELECT expires_at FROM bots WHERE id=$1`, [bot.id]);
  res.json({ renewed: true, expiresAt: rows[0].expires_at });
}));

const requireAdmin = wrap(async (req, res, next) => {
  const { rows } = await pool.query(`SELECT role FROM users WHERE id=$1`, [req.userId]);
  if (!rows[0] || rows[0].role !== 'admin') throw new HttpError(403, 'Admins only');
  next();
});

app.get('/api/admin/stats', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM bots) AS bots,
       (SELECT count(*)::int FROM bots WHERE status='running') AS running,
       (SELECT count(*)::int FROM bots b JOIN plans p ON p.id=b.plan_id WHERE p.coin_cost=0 AND b.status='running') AS free_running,
       (SELECT COALESCE(sum(amount),0)::int FROM payments WHERE status='success') AS revenue`
  );
  res.json({ ...rows[0], maxFree: MAX_FREE_BOTS });
}));

app.get('/api/admin/users', requireAuth, requireAdmin, wrap(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  const { rows } = await pool.query(
    `SELECT u.id,u.email,u.name,u.coins,u.role,u.created_at,
            (SELECT count(*)::int FROM bots b WHERE b.user_id=u.id) AS bots
       FROM users u
      WHERE $1='' OR u.email ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%'
      ORDER BY u.created_at DESC LIMIT 100`,
    [q]
  );
  res.json(rows);
}));

app.post('/api/admin/users/:id/coins', requireAuth, requireAdmin, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000)
    throw new HttpError(400, 'Amount must be a whole number (not 0, max 100000)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `UPDATE users SET coins=coins+$1 WHERE id=$2 AND coins+$1>=0 RETURNING coins`,
      [amount, req.params.id]
    );
    if (!u.rowCount) throw new HttpError(400, 'User not found, or balance would go below 0');
    await client.query(`INSERT INTO transactions (user_id,type,amount) VALUES ($1,'admin',$2)`, [req.params.id, amount]);
    await client.query('COMMIT');
    res.json({ coins: u.rows[0].coins });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/api/admin/bots', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id,b.name,b.owner_number,b.status,b.expires_at,
            u.email AS user_email,p.name AS plan_name,
            GREATEST(0,EXTRACT(EPOCH FROM (b.expires_at-now())))::int AS seconds_left
       FROM bots b JOIN users u ON u.id=b.user_id LEFT JOIN plans p ON p.id=b.plan_id
      ORDER BY b.created_at DESC LIMIT 200`
  );
  res.json(rows);
}));

async function adminBot(id) {
  const bot = (await pool.query(`SELECT id,container_id FROM bots WHERE id=$1`, [id])).rows[0];
  if (!bot) throw new HttpError(404, 'Bot not found');
  return bot;
}

app.post('/api/admin/bots/:id/stop', requireAuth, requireAdmin, wrap(async (req, res) => {
  const bot = await adminBot(req.params.id);
  await stopAndRemoveContainer(bot.container_id);
  await pool.query(`UPDATE bots SET status='stopped',container_id=NULL WHERE id=$1`, [bot.id]);
  res.json({ status: 'stopped' });
}));

app.delete('/api/admin/bots/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const bot = await adminBot(req.params.id);
  await stopAndRemoveContainer(bot.container_id);
  await pool.query(`DELETE FROM bots WHERE id=$1`, [bot.id]);
  res.json({ deleted: true });
}));

app.get('/api/admin/coupons', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,code,coins,max_uses,used_count,expires_at
       FROM coupons ORDER BY id DESC LIMIT 100`
  );
  res.json(rows);
}));

app.post('/api/admin/coupons', requireAuth, requireAdmin, wrap(async (req, res) => {
  const coins = Number(req.body.coins);
  const maxUses = Number(req.body.maxUses);
  const days = req.body.expireDays ? Number(req.body.expireDays) : null;
  let code = String(req.body.code || '').trim().toUpperCase();

  if (!code) code = crypto.randomBytes(4).toString('hex').toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new HttpError(400, 'Code: 3-40 letters, numbers, - or _');
  if (!Number.isInteger(coins) || coins < 1 || coins > 100000) throw new HttpError(400, 'Coins must be 1 to 100000');
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) throw new HttpError(400, 'Uses must be 1 to 100000');
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new HttpError(400, 'Expiry must be 1 to 365 days');

  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (code,coins,max_uses,expires_at)
       VALUES ($1,$2,$3,CASE WHEN $4::int IS NULL THEN NULL ELSE now()+($4::int||' days')::interval END)
       RETURNING id,code,coins,max_uses,expires_at`,
      [code, coins, maxUses, days]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(400, 'That code already exists');
    throw err;
  }
}));

app.delete('/api/admin/coupons/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  await pool.query(`DELETE FROM coupons WHERE id=$1`, [req.params.id]);
  res.json({ deleted: true });
}));

async function expireBots() {
  try {
    const { rows } = await pool.query(
      `SELECT id,container_id FROM bots
        WHERE status IN ('running','crashed') AND expires_at<now()`
    );
    for (const bot of rows) {
      await stopAndRemoveContainer(bot.container_id).catch((e) => console.error('Expire stop failed', bot.id, e.message));
      await pool.query(`UPDATE bots SET status='expired',container_id=NULL WHERE id=$1`, [bot.id]);
    }
  } catch (err) {
    console.error('expireBots error:', err.message);
  }
}
setInterval(expireBots, 60*1000);

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend running on port ${port}`));
