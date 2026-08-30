# MYCOIN Telegram Mini App

A secure Telegram Mini App starter for a points/reward product with:

- Home
- Daily check-in + streak
- Tasks
- Referrals (default 2%)
- Profile
- Points -> USDT exchange calculation
- Withdrawal requests
- Admin panel for tasks, economy settings and withdrawals
- PostgreSQL/Supabase database
- Telegram Mini App `initData` verification
- Server-side points ledger
- Rate limiting + Helmet
- Rewarded-ad callback endpoint designed for server-to-server verification

## Important security rule

The browser is never trusted for points. Do NOT award points from a plain JavaScript "ad finished" event.

Telegram explicitly says `initDataUnsafe` must not be trusted and that `initData` must be validated on the server. This project does that in `server/telegram.js`.

For rewarded ads, connect an ad provider that supports a verifiable server callback/webhook. Put its secret in `AD_CALLBACK_SECRET` and send signed events to:

`POST /api/ads/reward-callback`

The callback implementation rejects duplicate `event_id`s through the ledger reference constraint pattern and validates an HMAC signature.

## Local setup

1. Create a Telegram bot with BotFather.
2. Create a free PostgreSQL database (Supabase is a common option).
3. Copy `.env.example` to `.env`.
4. Fill `BOT_TOKEN`, `MINI_APP_URL`, `DATABASE_URL`, and admin credentials.
5. Run:

```bash
npm install
npm start
```

6. Open `/admin` in a browser to manage the app.
7. In BotFather, set the Mini App/menu URL to your HTTPS deployment.

## GitHub/deployment

Upload the project to one GitHub repository. Deploy the Node app to a host that supports Node + PostgreSQL environment variables. Use Supabase for PostgreSQL if you want a free database tier.

Required environment variables are listed in `.env.example`.

## Admin

`/admin`

Use the `ADMIN_USER` and `ADMIN_PASSWORD` environment variables. Use a long random password and HTTPS.

## Ad integration

The app intentionally does not pretend a client-side ad callback is secure. Add your provider's official rewarded-ad SDK to `web/index.html` and connect its server-side reward verification to `/api/ads/reward-callback`.

Until `ADS_ENABLED=true` and a valid callback is configured, the UI does not award ad points.

## Withdrawal

The app records withdrawal requests and lets an admin approve/reject them. It does NOT automatically send crypto. If you later add an external payout provider, use its official API and keep secrets only on the server.
