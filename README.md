# LedgerLink Invoice & Payment Tracker

A lightweight prototype for Nigerian SMEs to create invoices, track payment status, send reminders, and connect customer invoice pages to Paystack.

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

The frontend sends the invoice email, amount in kobo, currency, invoice ID, and metadata to that endpoint. The backend initializes the transaction with Paystack and returns the access code used by Paystack Popup.

The backend marks an invoice paid only after confirming Paystack returned:

- successful transaction status
- NGN currency
- exact invoice amount
- matching invoice ID
- matching business owner metadata

## Public URL and webhooks

For deployment guidance, see `DEPLOYMENT.md`.


## Email reminders

The email buttons open Gmail compose in a new browser tab because many Windows machines do not have a default `mailto:` email app configured. If the browser blocks the popup, the app falls back to a standard `mailto:` link.

**Email all due** opens one Gmail compose window with due customers in BCC. It is a reminder broadcast, but recipients should not see each other's email addresses.

## Invoice branding

Open Settings to upload a logo and choose brand/accent colors. These settings appear on invoice previews and customer payment pages.
