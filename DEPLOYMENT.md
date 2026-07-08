# LedgerLink Deployment Notes

## What "public URL" means

A public URL is an HTTPS address that Paystack can reach from the internet, such as:

```text
https://ledgerlink.yourdomain.com
```

`localhost` only exists on your own laptop, so Paystack cannot deliver webhooks to it. For automatic payment updates, Paystack needs:

