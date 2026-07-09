# LedgerLink Invoice & Payment Tracker

A lightweight prototype for Nigerian SMEs to create invoices, track payment status, send reminders, and connect customer invoice pages to Paystack.

## Open the app

Run the backend and open the app at `http://localhost:8787`. The file-only mode still exists for quick UI viewing, but login, ownership, Paystack verification, and public invoice links require the backend.

## What is included

- Dashboard for outstanding, overdue, and paid invoices
- Invoice creation with VAT and line items
- Shareable invoice payment pages
- Paid, pending, overdue, and draft tracking
- Email, WhatsApp, email-all-due, and copyable reminder messages
- Brand logo, brand color, and accent color customization for invoices
- CSV export
- Account registration and login with secure password hashing
- Per-owner invoice/settings storage
- Paystack Popup V2 frontend flow
- Node backend with Postgres/MongoDB support, local JSON fallback, Paystack initialize, verify, and webhook routes

## Run with the backend

Open PowerShell in this folder:

```powershell
cd "C:\Users\ADMIN\Documents\Codex\2026-07-08\wha\outputs\invoice-tracker"
```

Start the app:

```powershell
node server.js
```

Then open:

```text
http://localhost:8787
```

When opened this way, invoices and settings are saved to:

```text
data/ledgerlink-db.json
```

On the first run, create an account in the browser. The first account claims any existing local invoices/settings from the previous prototype database. Each later account gets its own isolated business workspace.

If the page stays on **Loading your workspace...**, stop the running server with `Ctrl+C`, start `node server.js` again from this folder, and refresh the browser. You can also open this URL to check the session endpoint:

```text
http://localhost:8787/api/session
```

Before login it should return:

```json
{"authenticated":false}
```

## Paystack setup

LedgerLink now uses two Paystack roles:

- **Platform billing key:** your Feranmite/LedgerLink Paystack secret key. This collects the LedgerLink monthly subscription payment.
- **Business payment key:** each SME's own Paystack secret key. They add it in **Settings**, and their invoice customers pay into their own Paystack account.

Set these on Render:

```text
APP_SECRET=use_a_long_random_secret_at_least_32_characters
ADMIN_API_TOKEN=use_a_different_long_random_admin_token
PLATFORM_PAYSTACK_SECRET_KEY=sk_live_your_ledgerlink_billing_key
LEDGERLINK_MONTHLY_PRICE_KOBO=1200000
PUBLIC_BASE_URL=https://your-ledgerlink-domain.onrender.com
```

`APP_SECRET` encrypts business Paystack keys before storage. Do not change it after users have saved keys, or the old saved keys cannot be decrypted.

`ADMIN_API_TOKEN` is for owner-only subscription support actions. Keep it secret and do not put it in the browser.

For local testing in PowerShell:

```powershell
$env:APP_SECRET="replace_with_a_long_random_secret_32_chars_min"
$env:PLATFORM_PAYSTACK_SECRET_KEY="sk_test_your_platform_key"
node server.js
```

The app uses this backend route when a customer clicks **Pay with Paystack**:

```text
/paystack/initialize
```

That route uses the business owner's saved Paystack secret key, creates a transaction, and returns an access code for the Paystack popup.

The backend marks an invoice paid only after confirming Paystack returned:

- successful transaction status
- NGN currency
- exact invoice amount
- matching invoice ID
- matching business owner metadata

## Admin subscription support

Use this only for support/testing when you need to activate or deactivate an account without editing MongoDB directly.

```powershell
$body = @{ email = "customer@example.com"; action = "activate"; days = 30 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://your-ledgerlink-domain.onrender.com/api/admin/subscriptions" -Headers @{ "x-admin-token" = "your_admin_token" } -ContentType "application/json" -Body $body
```

To deactivate:

```powershell
$body = @{ email = "customer@example.com"; action = "deactivate" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://your-ledgerlink-domain.onrender.com/api/admin/subscriptions" -Headers @{ "x-admin-token" = "your_admin_token" } -ContentType "application/json" -Body $body
```

## Public URL and webhooks

For deployment guidance, see `DEPLOYMENT.md`.

Invoice payments do not depend only on webhooks: the app also verifies Paystack after the customer returns from checkout. Webhooks are still useful because they can mark invoices paid even when the customer closes the browser after payment.

For the LedgerLink platform billing Paystack account, if that account already has another project webhook, see `WEBHOOK_ROUTER.md` before changing the Paystack dashboard URL.

For automatic payment updates, Paystack must reach your webhook route:

```text
/paystack/webhook
```

When testing locally, use a tunnel such as ngrok or Cloudflare Tunnel, then start the app with your public base URL:

```powershell
$env:APP_SECRET="replace_with_a_long_random_secret_32_chars_min"
$env:PLATFORM_PAYSTACK_SECRET_KEY="sk_test_your_platform_key"
$env:PUBLIC_BASE_URL="https://your-public-url.example"
node server.js
```

Then set this webhook URL inside Paystack:

```text
https://your-public-url.example/paystack/webhook
```

`PUBLIC_BASE_URL` is also used for Paystack callback URLs after checkout.

## Email reminders

The email buttons open Gmail compose in a new browser tab because many Windows machines do not have a default `mailto:` email app configured. If the browser blocks the popup, the app falls back to a standard `mailto:` link.

Reminder timing is currently automatic, but sending is manual. LedgerLink builds a queue from each invoice due date using the **before due date** and **after due date** settings. To send reminders automatically in the background, add an email/SMS provider and a scheduled worker.

**Email all due** opens one Gmail compose window with due customers in BCC. It is a reminder broadcast, but recipients should not see each other's email addresses.

## Invoice branding

Open Settings to upload a logo and choose brand/accent colors. These settings appear on invoice previews and customer payment pages.
