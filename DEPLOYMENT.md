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

This is the fastest route because the app is currently one Node server that serves HTML, APIs, sessions, Paystack routes, and JSON database storage.

## About Vercel

Vercel is excellent for frontend apps and serverless APIs, and you already know it, so it can be a good final target. But this exact backend should not rely on local JSON files when deployed there. For a Vercel version, move persistent data to a hosted database first:

- Neon Postgres
- Supabase Postgres
- Vercel Postgres/Marketplace database

Then convert the backend routes into serverless API routes or a Next.js app.

## Environment variables

Set these on your hosting provider:

```text
NODE_ENV=production
PAYSTACK_SECRET_KEY=sk_live_or_test_key
PUBLIC_BASE_URL=https://your-public-url
```

Optional:

```text
PORT=8787
DB_PATH=/app/data/ledgerlink-db.json
```

## Paystack dashboard setup

In Paystack, set your webhook URL to:

```text
https://your-public-url/paystack/webhook
```

The app verifies webhook signatures, amount, currency, invoice ID, and business owner metadata before marking an invoice as paid.

## Current limitation

The JSON database is acceptable for prototype/staging, but not ideal for real production. The next engineering step is replacing `data/ledgerlink-db.json` with Postgres.
