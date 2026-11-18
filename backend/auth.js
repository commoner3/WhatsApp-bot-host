const express = require('express');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

module.exports = function authRoutes(pool, wrap) {
  const router = express.Router();

  router.post('/google', wrap(async (req, res) => {
    const { credential } = req.body;
    if (typeof credential !== 'string' || credential.length > 5000) {
      return res.status(400).json({ error: 'Missing Google credential' });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Google sign-in failed' });
    }

    if (!payload || !payload.email || !payload.email_verified) {
      return res.status(401).json({ error: 'Google email not verified' });
    }

    const email = payload.email.toLowerCase();
    const name = payload.name || email.split('@')[0];

    const { rows } = await pool.query(
      `INSERT INTO users (email, name, google_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET google_id = COALESCE(users.google_id, EXCLUDED.google_id)
       RETURNING id, email, name, coins, role`,
      [email, name, payload.sub]
    );
    const user = rows[0];

    if (ADMIN_EMAILS.includes(email) && user.role !== 'admin') {
      await pool.query(`UPDATE users SET role='admin' WHERE id=$1`, [user.id]);
      user.role = 'admin';
    }

    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  }));

  return router;
};
