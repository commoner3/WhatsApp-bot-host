# WhatsApp Bot Host

A panel where users sign in with Google, paste a WhatsApp session ID, and deploy their bot.
Each bot runs in its own Docker container with a RAM limit.

## Features
- Google login
- Deploy form (session ID, bot name, owner number, plan)
- My Bots: start, stop, restart, delete, renew/extend, live console
- Free and paid plans
- Paystack coin purchases
- Coupon credits
- Admin users, bots, coupons, and statistics

## Structure
- `backend/` — Express API, authentication, Docker, and Paystack integration
- `frontend/` — static user and admin pages
- `bot/` — Docker image and WhatsApp session loader
- `database/` — PostgreSQL schema and migration

## Setup
1. Copy `backend/.env.example` to `backend/.env` and fill in the values.
2. Run `database/schema.sql` against PostgreSQL.
3. Build the bot image: `cd bot && docker build -t my-whatsapp-bot:latest .`
4. Install and start the API: `cd backend && npm install && npm start`
5. Set `API` and `GOOGLE_CLIENT_ID` in `frontend/index.html`, then host the static files.

Generate `SESSION_ENC_KEY` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
