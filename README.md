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
- Node backend with JSON database storage, Paystack initialize, verify, and webhook routes

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

1. In Paystack, copy your test secret key from **Settings > API Keys & Webhooks**. It usually starts with `sk_test_`.
2. Open PowerShell in this folder and run:

```powershell
$env:PAYSTACK_SECRET_KEY="sk_test_your_key"
node server.js
```

The first line creates a temporary environment variable for that PowerShell window only. It gives the backend permission to talk to Paystack without putting your secret key inside the browser app.

The second line starts the local backend server. By default it listens at:

```text
http://localhost:8787
```

The app automatically uses this backend route when a customer clicks **Pay with Paystack**:

```text
/paystack/initialize
```

That route creates a transaction with Paystack and returns an access code for the Paystack popup.

The frontend sends the invoice email, amount in kobo, currency, invoice ID, and metadata to that endpoint. The backend initializes the transaction with Paystack and returns the access code used by Paystack Popup.

The backend marks an invoice paid only after confirming Paystack returned:

- successful transaction status
- NGN currency
- exact invoice amount
- matching invoice ID
- matching business owner metadata

## Public URL and webhooks

For deployment guidance, see `DEPLOYMENT.md`.

For automatic payment updates, Paystack must reach your webhook route:

```text
/paystack/webhook
```

When testing locally, use a tunnel such as ngrok or Cloudflare Tunnel, then start the app with your public base URL:

```powershell
$env:PAYSTACK_SECRET_KEY="sk_test_your_key"
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

**Email all due** opens one Gmail compose window with due customers in BCC. It is a reminder broadcast, but recipients should not see each other's email addresses.

## Invoice branding

Open Settings to upload a logo and choose brand/accent colors. These settings appear on invoice previews and customer payment pages.
