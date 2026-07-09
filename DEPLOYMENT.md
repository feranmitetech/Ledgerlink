# LedgerLink Deployment Notes

## What "public URL" means

A public URL is an HTTPS address that Paystack can reach from the internet, such as:

```text
https://ledgerlink.yourdomain.com
```

`localhost` only exists on your own laptop, so Paystack cannot deliver webhooks to it. For automatic payment updates, Paystack needs:

```text
https://your-public-url/paystack/webhook
```

## Recommended path

For the current `server.js` version, use a host that runs a normal Node web server:

- Render
- Railway
- Fly.io
- DigitalOcean App Platform

This is the fastest route because the app is currently one Node server that serves HTML, APIs, sessions, and Paystack routes.

## About Vercel

Vercel is excellent for frontend apps and serverless APIs, and you already know it, so it can be a good final target. Keep using hosted Postgres, then convert the backend routes into serverless API routes or a Next.js app later.

- Neon Postgres
- Supabase Postgres
- Vercel Postgres/Marketplace database

## Database

Use hosted database storage instead of a Render disk.

Option A, Postgres:

```text
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

Option B, MongoDB Atlas:

```text
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=ledgerlink
```

Storage priority is `DATABASE_URL`, then `MONGODB_URI`, then local JSON fallback. On Render, set only one hosted database option.

## Environment variables

Set these on your hosting provider:

```text
NODE_ENV=production
APP_SECRET=long_random_secret_at_least_32_chars
ADMIN_API_TOKEN=different_long_random_admin_token
PLATFORM_PAYSTACK_SECRET_KEY=sk_live_or_test_platform_billing_key
LEDGERLINK_MONTHLY_PRICE_KOBO=1200000
LEDGERLINK_BILLING_DAYS=30
PUBLIC_BASE_URL=https://your-public-url
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=ledgerlink
```

Use Node 20 LTS. The project pins this through `package.json` and `.node-version` because some MongoDB Atlas TLS handshakes can fail on newer non-LTS Node versions.

Optional:

```text
PORT=8787
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
DB_PATH=./data/ledgerlink-db.json
```

Do not set `PAYSTACK_SECRET_KEY` for normal SaaS operation. Each business adds its own Paystack key inside LedgerLink Settings, and `PLATFORM_PAYSTACK_SECRET_KEY` is only for LedgerLink subscription billing.

## Paystack dashboard setup

In Paystack, set your webhook URL to:

```text
https://your-public-url/paystack/webhook
```

The app verifies webhook signatures, amount, currency, invoice ID, and business owner metadata before marking an invoice as paid.

If the same Paystack account already powers another project, do not overwrite that project's webhook blindly. Use `paystack-router.js` as the single Paystack webhook URL, then route events to LedgerLink and the old project separately. See `WEBHOOK_ROUTER.md`.

## Current limitation

The current hosted database adapter stores app state as one document. That is durable enough for staging and early production testing. The next engineering step is normalizing users, businesses, invoices, and sessions into proper database tables/collections.
