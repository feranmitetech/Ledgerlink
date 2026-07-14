const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = __dirname;
const LOADED_ENV_FILES = loadEnvFiles([".env.local", ".env"]);

const PORT = Number(process.env.PORT || 8787);
const PLATFORM_PAYSTACK_SECRET_KEY = (process.env.PLATFORM_PAYSTACK_SECRET_KEY || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const APP_SECRET = (process.env.APP_SECRET || "").trim();
const ADMIN_API_TOKEN = (process.env.ADMIN_API_TOKEN || "").trim();
const TERMII_API_KEY = (process.env.TERMII_API_KEY || "").trim();
const TERMII_BASE_URL = (process.env.TERMII_BASE_URL || "").replace(/\/$/, "");
const TERMII_EMAIL_CONFIGURATION_ID = (process.env.TERMII_EMAIL_CONFIGURATION_ID || "").trim();
const TERMII_EMAIL_TEMPLATE_ID = (process.env.TERMII_EMAIL_TEMPLATE_ID || "").trim();
const REMINDER_DAILY_HOUR = Number(process.env.REMINDER_DAILY_HOUR || 8);
const REMINDER_TIME_ZONE = process.env.REMINDER_TIME_ZONE || "Africa/Lagos";
const BILLING_DURATION_DAYS = Number(process.env.LEDGERLINK_BILLING_DAYS || 30);
const BILLING_PLANS = buildBillingPlans();
const BILLING_ADDONS = buildBillingAddons();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const MONGODB_URI = (process.env.MONGODB_URI || "").trim();
const MONGODB_DB = process.env.MONGODB_DB || "ledgerlink";
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "ledgerlink-db.json");
const SESSION_COOKIE = "ledgerlink_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
let pgPool = null;
let mongoClient = null;
const rateLimitBuckets = new Map();
let lastReminderScheduleKey = "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const seedSettings = {
  businessName: "Aduke Foods & Catering",
  ownerEmail: "hello@adukefoods.ng",
  phone: "+234 801 234 5678",
  address: "18 Allen Avenue, Ikeja, Lagos",
  bank: "GTBank - 0123456789",
  brandColor: "#107c55",
  accentColor: "#2f4f9e",
  logoDataUrl: "",
  automatedRemindersEnabled: false,
  automatedReminderChannels: {
    email: true,
    whatsapp: false
  },
  reminderBeforeDays: 2,
  reminderAfterDays: 1,
  vatRate: 7.5
};

const seedInvoices = [
  {
    id: "INV-1007",
    customer: "Nora Martins",
    email: "nora@example.com",
    phone: "+234 806 110 2304",
    issueDate: dateOffset(-9),
    dueDate: dateOffset(-2),
    status: "overdue",
    notes: "Thank you for trusting us with your staff lunch service.",
    items: [
      { description: "Corporate lunch packs", quantity: 45, price: 3800 },
      { description: "Delivery to Victoria Island", quantity: 1, price: 18000 }
    ],
    reminders: [{ date: dateOffset(-1), channel: "Email" }]
  },
  {
    id: "INV-1008",
    customer: "Tola Design Studio",
    email: "accounts@toladesign.test",
    phone: "+234 803 222 4199",
    issueDate: dateOffset(-3),
    dueDate: dateOffset(4),
    status: "pending",
    notes: "Payment validates the final brand assets handover.",
    items: [
      { description: "Brand strategy workshop", quantity: 1, price: 220000 },
      { description: "Identity design balance", quantity: 1, price: 430000 }
    ],
    reminders: []
  },
  {
    id: "INV-1009",
    customer: "Musa Auto Parts",
    email: "musa@example.com",
    phone: "+234 809 908 7781",
    issueDate: dateOffset(-15),
    dueDate: dateOffset(-8),
    status: "paid",
    notes: "Paid by bank transfer.",
    paidAt: dateOffset(-7),
    items: [{ description: "Website maintenance", quantity: 1, price: 150000 }],
    reminders: []
  }
];

function buildBillingPlans() {
  const emailPrice = Number(process.env.LEDGERLINK_EMAIL_PLAN_PRICE_KOBO || process.env.LEDGERLINK_MONTHLY_PRICE_KOBO || 1200000);
  return [
    {
      id: "email",
      name: "Email reminders",
      description: "Invoice tracking, Paystack collection, and automated email reminders.",
      priceKobo: emailPrice,
      emailLimit: Number(process.env.LEDGERLINK_EMAIL_PLAN_EMAIL_LIMIT || 300),
      whatsappLimit: 0,
      channels: ["email"]
    }
  ];
}

function buildBillingAddons() {
  return [
    {
      id: "extra_email_500",
      name: "Extra 500 emails",
      description: "Adds 500 automated email reminders for the current billing period.",
      priceKobo: Number(process.env.LEDGERLINK_EXTRA_EMAIL_500_PRICE_KOBO || 300000),
      emailLimit: 500,
      whatsappLimit: 0
    }
  ];
}

function getBillingPlan(planId = "") {
  return BILLING_PLANS.find(plan => plan.id === planId) || BILLING_PLANS[0];
}

function getBillingAddon(addonId = "") {
  return BILLING_ADDONS.find(addon => addon.id === addonId) || null;
}

function publicBillingPlans() {
  return BILLING_PLANS.map(plan => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    priceKobo: plan.priceKobo,
    priceNaira: plan.priceKobo / 100,
    emailLimit: plan.emailLimit,
    whatsappLimit: plan.whatsappLimit,
    channels: plan.channels
  }));
}

function publicBillingAddons() {
  return BILLING_ADDONS.map(addon => ({
    id: addon.id,
    name: addon.name,
    description: addon.description,
    priceKobo: addon.priceKobo,
    priceNaira: addon.priceKobo / 100,
    emailLimit: addon.emailLimit,
    whatsappLimit: addon.whatsappLimit
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!allowSameOriginMutation(req, url)) {
      writeJson(res, 403, { error: "Cross-origin request blocked." });
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      writeJson(res, 200, { ok: true, service: "ledgerlink", time: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      const { user, db } = await getUserFromRequest(req);
      writeJson(res, 200, user ? sessionPayload(user, db) : { authenticated: false });
      return;
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      if (!checkRateLimit(req, res, "auth:register", 5, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const db = await readDb();
      const email = normalizeEmail(body.email);
      if (!email || !body.password || String(body.password).length < 8) {
        writeJson(res, 400, { error: "Use a valid email and a password with at least 8 characters." });
        return;
      }
      if (db.users.some(user => user.email === email)) {
        writeJson(res, 409, { error: "An account with this email already exists." });
        return;
      }

      const user = createUser(body.name || email.split("@")[0], email, String(body.password));
      const businessId = newId("biz");
      const claimed = claimInitialState(db);
      const settings = sanitizeSettings({
        ...claimed.settings,
        businessName: body.businessName || claimed.settings.businessName,
        ownerEmail: email
      });
      const invoices = claimed.invoices.map(invoice => ({ ...sanitizeInvoice(invoice), businessId }));

      db.users.push(user);
      db.businesses.push({ id: businessId, ownerUserId: user.id, settings, paystack: {}, subscription: {}, billingHistory: [] });
      db.invoices.push(...invoices);
      db.orphanState = null;
      logAudit(db, {
        event: "auth.register",
        actorUserId: user.id,
        actorEmail: user.email,
        businessId,
        message: "Business account registered"
      });

      const session = createSession(user.id);
      db.sessions.push(session);
      logAudit(db, {
        event: "auth.login",
        actorUserId: user.id,
        actorEmail: user.email,
        businessId: getBusinessForUser(db, user).id,
        message: "User signed in"
      });
      await writeDb(db);
      setSessionCookie(res, session.id);
      writeJson(res, 201, sessionPayload(user, db));
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!checkRateLimit(req, res, "auth:login", 8, 15 * 60 * 1000)) return;
      const body = await readJson(req);
      const db = await readDb();
      const user = db.users.find(item => item.email === normalizeEmail(body.email));
      if (!user || !verifyPassword(String(body.password || ""), user.password)) {
        writeJson(res, 401, { error: "Invalid email or password." });
        return;
      }
      const session = createSession(user.id);
      db.sessions.push(session);
      await writeDb(db);
      setSessionCookie(res, session.id);
      writeJson(res, 200, sessionPayload(user, db));
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const db = await readDb();
      const sessionId = getCookie(req, SESSION_COOKIE);
      db.sessions = db.sessions.filter(session => session.id !== sessionId);
      await writeDb(db);
      clearSessionCookie(res);
      writeJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      writeJson(res, 200, getStateForUser(db, user));
      return;
    }

    if (url.pathname === "/api/state" && req.method === "PUT") {
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const business = getBusinessForUser(db, user);
      if (!subscriptionStatus(business).active) {
        writeJson(res, 402, { error: "This LedgerLink subscription is inactive. Renew the plan before changing your workspace." });
        return;
      }
      business.settings = sanitizeSettings(body.settings || {});
      const incomingInvoices = Array.isArray(body.invoices) ? body.invoices : [];
      db.invoices = db.invoices.filter(invoice => invoice.businessId !== business.id);
      db.invoices.push(...incomingInvoices.map(invoice => ({
        ...sanitizeInvoice(invoice),
        businessId: business.id
      })));
      await writeDb(db);
      writeJson(res, 200, getStateForUser(db, user));
      return;
    }

    if (url.pathname === "/api/business/paystack" && req.method === "PUT") {
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const business = getBusinessForUser(db, user);
      if (!subscriptionStatus(business).active) {
        writeJson(res, 402, { error: "Renew the LedgerLink plan before connecting Paystack." });
        return;
      }
      const body = await readJson(req);
      const secretKey = String(body.secretKey || "").trim();
      if (!/^sk_(test|live)_/i.test(secretKey)) {
        writeJson(res, 400, { error: "Enter a valid Paystack secret key. It should start with sk_test_ or sk_live_." });
        return;
      }
      business.paystack = {
        secretKeyEncrypted: encryptSecret(secretKey),
        keyLast4: secretKey.slice(-4),
        mode: secretKey.startsWith("sk_live_") ? "live" : "test",
        updatedAt: new Date().toISOString()
      };
      logAudit(db, {
        event: "paystack.key_saved",
        actorUserId: user.id,
        actorEmail: user.email,
        businessId: business.id,
        message: `Business Paystack ${business.paystack.mode} key saved`
      });
      await writeDb(db);
      writeJson(res, 200, { paystack: publicPaystackStatus(business) });
      return;
    }

    if (url.pathname === "/api/billing/status" && req.method === "GET") {
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      writeJson(res, 200, { billing: subscriptionStatus(getBusinessForUser(db, user), db), billingPlans: publicBillingPlans(), billingAddons: publicBillingAddons() });
      return;
    }

    if (url.pathname === "/api/billing/initialize" && req.method === "POST") {
      if (!checkRateLimit(req, res, "billing:init", 10, 10 * 60 * 1000)) return;
      requirePlatformSecret();
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const plan = getBillingPlan(body.planId || body.plan);
      const business = getBusinessForUser(db, user);
      const callbackBase = PUBLIC_BASE_URL || `${url.protocol}//${req.headers.host}`;
      const reference = `LL-SUB-${plan.id}-${business.id}-${Date.now()}`;
      const payload = {
        email: user.email,
        amount: plan.priceKobo,
        currency: "NGN",
        reference,
        callback_url: `${callbackBase}/?billing=return`,
        metadata: {
          project: "ledgerlink-saas",
          plan: plan.id,
          planName: plan.name,
          businessId: business.id,
          userId: user.id,
          expectedAmount: plan.priceKobo,
          expectedCurrency: "NGN"
        }
      };
      const paystackResponse = await paystackFetch("transaction/initialize", PLATFORM_PAYSTACK_SECRET_KEY, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const paystackPayload = await paystackResponse.json();
      if (paystackResponse.ok && paystackPayload.status) {
        addBillingEvent(business, {
          type: "subscription_initialize",
          status: "pending",
          amountKobo: plan.priceKobo,
          currency: "NGN",
          reference,
          source: "paystack",
          plan: plan.id
        });
        logAudit(db, {
          event: "billing.initialize",
          actorUserId: user.id,
          actorEmail: user.email,
          businessId: business.id,
          message: `${plan.name} payment initialized`,
          metadata: { plan: plan.id }
        });
        await writeDb(db);
      }
      writeJson(res, paystackResponse.status, paystackPayload);
      return;
    }

    if (url.pathname === "/api/billing/addons/initialize" && req.method === "POST") {
      if (!checkRateLimit(req, res, "billing:addon:init", 12, 10 * 60 * 1000)) return;
      requirePlatformSecret();
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const business = getBusinessForUser(db, user);
      if (!subscriptionStatus(business, db).active) {
        writeJson(res, 402, { error: "Renew your LedgerLink plan before buying reminder add-ons." });
        return;
      }
      const body = await readJson(req);
      const addon = getBillingAddon(body.addonId || body.addon);
      if (!addon) {
        writeJson(res, 400, { error: "Unknown add-on bundle." });
        return;
      }
      const callbackBase = PUBLIC_BASE_URL || `${url.protocol}//${req.headers.host}`;
      const reference = `LL-ADDON-${addon.id}-${business.id}-${Date.now()}`;
      const payload = {
        email: user.email,
        amount: addon.priceKobo,
        currency: "NGN",
        reference,
        callback_url: `${callbackBase}/?addon=return`,
        metadata: {
          project: "ledgerlink-saas",
          billingType: "addon",
          addon: addon.id,
          addonName: addon.name,
          businessId: business.id,
          userId: user.id,
          expectedAmount: addon.priceKobo,
          expectedCurrency: "NGN"
        }
      };
      const paystackResponse = await paystackFetch("transaction/initialize", PLATFORM_PAYSTACK_SECRET_KEY, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const paystackPayload = await paystackResponse.json();
      if (paystackResponse.ok && paystackPayload.status) {
        addBillingEvent(business, {
          type: "addon_initialize",
          status: "pending",
          amountKobo: addon.priceKobo,
          currency: "NGN",
          reference,
          source: "paystack",
          addon: addon.id,
          emailCredits: addon.emailLimit,
          whatsappCredits: addon.whatsappLimit
        });
        logAudit(db, {
          event: "billing.addon_initialize",
          actorUserId: user.id,
          actorEmail: user.email,
          businessId: business.id,
          message: `${addon.name} payment initialized`,
          metadata: { addon: addon.id }
        });
        await writeDb(db);
      }
      writeJson(res, paystackResponse.status, paystackPayload);
      return;
    }

    if (url.pathname === "/api/billing/verify" && req.method === "GET") {
      if (!checkRateLimit(req, res, "billing:verify", 30, 10 * 60 * 1000)) return;
      requirePlatformSecret();
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const reference = url.searchParams.get("reference");
      if (!reference) {
        writeJson(res, 400, { error: "Missing transaction reference." });
        return;
      }
      const data = await verifyPaystack(reference, PLATFORM_PAYSTACK_SECRET_KEY);
      if (data.status && data.data?.status === "success") {
        const result = await markSubscriptionPaidFromTransaction(data.data, user.id);
        if (!result.ok) {
          writeJson(res, 422, { error: result.error, paystack: data });
          return;
        }
      }
      const freshDb = await readDb();
      writeJson(res, 200, { ...data, billing: subscriptionStatus(getBusinessForUser(freshDb, user), freshDb), billingPlans: publicBillingPlans(), billingAddons: publicBillingAddons() });
      return;
    }

    if (url.pathname === "/api/billing/addons/verify" && req.method === "GET") {
      if (!checkRateLimit(req, res, "billing:addon:verify", 30, 10 * 60 * 1000)) return;
      requirePlatformSecret();
      const { user } = await requireUser(req, res);
      if (!user) return;
      const reference = url.searchParams.get("reference");
      if (!reference) {
        writeJson(res, 400, { error: "Missing transaction reference." });
        return;
      }
      const data = await verifyPaystack(reference, PLATFORM_PAYSTACK_SECRET_KEY);
      if (data.status && data.data?.status === "success") {
        const result = await markAddonPaidFromTransaction(data.data, user.id);
        if (!result.ok) {
          writeJson(res, 422, { error: result.error, paystack: data });
          return;
        }
      }
      const freshDb = await readDb();
      writeJson(res, 200, { ...data, billing: subscriptionStatus(getBusinessForUser(freshDb, user), freshDb), billingPlans: publicBillingPlans(), billingAddons: publicBillingAddons() });
      return;
    }

    const publicInvoice = url.pathname.match(/^\/api\/public\/invoices\/([^/]+)$/);
    if (publicInvoice && req.method === "GET") {
      if (!checkRateLimit(req, res, "public:invoice", 120, 10 * 60 * 1000)) return;
      const db = await readDb();
      const token = decodeURIComponent(publicInvoice[1]);
      const invoice = db.invoices.find(item => item.publicId === token);
      if (!invoice) {
        writeJson(res, 404, { error: "Invoice not found." });
        return;
      }
      const business = db.businesses.find(item => item.id === invoice.businessId);
      writeJson(res, 200, {
        settings: business.settings,
        paystack: { configured: publicPaystackStatus(business).configured },
        invoice: publicInvoicePayload(invoice)
      });
      return;
    }

    if (url.pathname === "/api/invoices" && req.method === "POST") {
      if (!checkRateLimit(req, res, "invoice:create", 30, 10 * 60 * 1000)) return;
      const body = await readJson(req);
      const invoice = await createInvoiceForRequest(req, body);
      writeJson(res, 201, { invoice: publicInvoicePayload(invoice) });
      return;
    }

    const invoicePatch = url.pathname.match(/^\/api\/invoices\/([^/]+)$/);
    if (invoicePatch && req.method === "PATCH") {
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const business = getBusinessForUser(db, user);
      if (!subscriptionStatus(business).active) {
        writeJson(res, 402, { error: "Renew the LedgerLink plan before editing invoices." });
        return;
      }
      const invoice = db.invoices.find(item => item.id === decodeURIComponent(invoicePatch[1]) && item.businessId === business.id);
      if (!invoice) {
        writeJson(res, 404, { error: "Invoice not found." });
        return;
      }
      Object.assign(invoice, sanitizeInvoice({ ...invoice, ...(await readJson(req)) }), { businessId: business.id });
      await writeDb(db);
      writeJson(res, 200, invoice);
      return;
    }

    if (url.pathname === "/paystack/initialize" && req.method === "POST") {
      if (!checkRateLimit(req, res, "paystack:init", 30, 10 * 60 * 1000)) return;
      const body = await readJson(req);
      const db = await readDb();
      const invoiceToken = body.publicId || body.invoiceId;
      const invoice = db.invoices.find(item => item.publicId === invoiceToken);
      if (!invoice || !["pending", "overdue"].includes(effectiveStatus(invoice))) {
        writeJson(res, 404, { error: "Payable invoice not found." });
        return;
      }

      const business = db.businesses.find(item => item.id === invoice.businessId);
      if (!subscriptionStatus(business).active) {
        writeJson(res, 402, { error: "This LedgerLink subscription is inactive. Renew the plan before accepting invoice payments." });
        return;
      }
      const merchantSecret = businessPaystackSecret(business);
      if (!merchantSecret) {
        writeJson(res, 400, { error: "This business has not added its Paystack secret key yet." });
        return;
      }
      const amount = Math.round(invoiceTotal(invoice, business.settings) * 100);
      const reference = `${invoice.publicId || invoice.id}-${Date.now()}`;
      const payload = {
        email: invoice.email,
        amount,
        currency: "NGN",
        reference,
        metadata: {
          project: "ledgerlink",
          invoiceId: invoice.id,
          publicId: invoice.publicId,
          businessId: business.id,
          expectedAmount: amount,
          expectedCurrency: "NGN"
        }
      };

      const callbackBase = PUBLIC_BASE_URL || `${url.protocol}//${req.headers.host}`;
      payload.callback_url = `${callbackBase}/#pay/${encodeURIComponent(invoice.publicId || invoice.id)}`;

      const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${merchantSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      writeJson(res, paystackResponse.status, await paystackResponse.json());
      return;
    }

    if (url.pathname === "/paystack/verify" && req.method === "GET") {
      if (!checkRateLimit(req, res, "paystack:verify", 60, 10 * 60 * 1000)) return;
      const reference = url.searchParams.get("reference");
      if (!reference) {
        writeJson(res, 400, { error: "Missing transaction reference." });
        return;
      }
      const db = await readDb();
      const invoice = findInvoiceByReference(db, reference);
      if (!invoice) {
        writeJson(res, 404, { error: "Invoice not found for transaction reference." });
        return;
      }
      const business = db.businesses.find(item => item.id === invoice.businessId);
      const merchantSecret = businessPaystackSecret(business);
      if (!merchantSecret) {
        writeJson(res, 400, { error: "This business has not added its Paystack secret key yet." });
        return;
      }
      const data = await verifyPaystack(reference, merchantSecret);
      if (data.status && data.data?.status === "success") {
        const result = await markInvoicePaidFromTransaction(data.data);
        if (!result.ok) {
          writeJson(res, 422, { error: result.error, paystack: data });
          return;
        }
      }
      writeJson(res, 200, data);
      return;
    }

    if (url.pathname === "/api/admin/subscriptions" && req.method === "POST") {
      requireAdmin(req);
      const body = await readJson(req);
      const result = await setSubscriptionByAdmin(body);
      writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/admin/overview" && req.method === "GET") {
      requireAdmin(req);
      const db = await readDb();
      writeJson(res, 200, adminOverview(db));
      return;
    }

    if (url.pathname === "/api/admin/reminders/run" && req.method === "POST") {
      requireAdmin(req);
      const body = await readJson(req);
      const result = await runAutomatedReminders({
        dryRun: body.dryRun !== false,
        reason: "admin"
      });
      writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/paystack/webhook" && req.method === "POST") {
      if (!checkRateLimit(req, res, "paystack:webhook", 240, 10 * 60 * 1000)) return;
      const rawBody = await readRaw(req);
      const signature = String(req.headers["x-paystack-signature"] || "");
      const webhookMatch = await matchPaystackWebhookSecret(rawBody, signature);
      if (!webhookMatch) {
        writeJson(res, 401, { error: "Invalid webhook signature." });
        return;
      }
      const event = JSON.parse(rawBody);
      if (event.event === "charge.success") {
        let result;
        if (event.data?.metadata?.project === "ledgerlink-saas" && event.data?.metadata?.billingType === "addon") {
          result = await markAddonPaidFromTransaction(event.data);
        } else if (event.data?.metadata?.project === "ledgerlink-saas") {
          result = await markSubscriptionPaidFromTransaction(event.data);
        } else {
          result = await markInvoicePaidFromTransaction(event.data);
        }
        if (!result.ok) console.error("Webhook payment rejected:", result.error);
      }
      writeJson(res, 200, { received: true });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    writeJson(res, error.statusCode || 500, { error: error.message });
  }
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error("Close the previous LedgerLink server, or start this one on another port:");
    console.error('$env:PORT="8788"');
    console.error("node server.js");
    process.exit(1);
  }
  throw error;
});

startServer().catch(error => {
  console.error("LedgerLink failed to start.");
  console.error(error.message);
  if (MONGODB_URI && /SSL|TLS|Server selection|MongoNetwork|ENOTFOUND|ECONN/i.test(String(error.stack || error.message))) {
    console.error("MongoDB connection checklist:");
    console.error("1. In MongoDB Atlas, Network Access must allow 0.0.0.0/0 for Render.");
    console.error("2. Use the standard Drivers connection string, not a private endpoint string.");
    console.error("3. URL-encode special characters in the database password.");
    console.error("4. Keep MONGODB_URI as one line in Render environment variables.");
  }
  process.exit(1);
});

async function startServer() {
  await ensureDatabase();
  server.listen(PORT, () => {
    console.log(`LedgerLink running at http://localhost:${PORT}`);
    console.log(`Storage: ${storageLabel()}`);
    if (LOADED_ENV_FILES.length) console.log(`Loaded env: ${LOADED_ENV_FILES.join(", ")}`);
    if (!PLATFORM_PAYSTACK_SECRET_KEY) console.log("Platform billing is disabled until PLATFORM_PAYSTACK_SECRET_KEY is set.");
    if (!reminderProviderReady()) console.log("Automated reminders are in dry-run mode until Termii email settings are configured.");
    if (PUBLIC_BASE_URL) console.log(`Public webhook/callback base URL: ${PUBLIC_BASE_URL}`);
  });
  setInterval(runReminderScheduleIfDue, 60 * 60 * 1000).unref();
  runReminderScheduleIfDue().catch(error => console.error("Reminder schedule failed:", error.message));
}

function storageLabel() {
  if (DATABASE_URL) return "Postgres";
  if (MONGODB_URI) return `MongoDB (${MONGODB_DB})`;
  return `JSON file (${DB_PATH})`;
}

async function ensureDatabase() {
  if (DATABASE_URL) {
    const pool = getPgPool();
    await pool.query(`
      create table if not exists ledgerlink_state (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(
      `insert into ledgerlink_state (id, data)
       values ($1, $2::jsonb)
       on conflict (id) do nothing`,
      ["app", JSON.stringify(emptyDb())]
    );
    await writeDb(await readDb());
    return;
  }

  if (MONGODB_URI) {
    const collection = await getMongoCollection();
    await collection.updateOne(
      { _id: "app" },
      { $setOnInsert: { data: emptyDb(), updatedAt: new Date() } },
      { upsert: true }
    );
    await writeDb(await readDb());
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    await writeDb(emptyDb());
    return;
  }
  await writeDb(await readDb());
}

async function readDb() {
  if (DATABASE_URL) {
    const result = await getPgPool().query("select data from ledgerlink_state where id = $1", ["app"]);
    return migrateDb(result.rows[0]?.data || emptyDb());
  }
  if (MONGODB_URI) {
    const document = await (await getMongoCollection()).findOne({ _id: "app" });
    return migrateDb(document?.data || emptyDb());
  }
  return migrateDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
}

async function writeDb(data) {
  const clean = sanitizeDb(data);
  if (DATABASE_URL) {
    await getPgPool().query(
      `insert into ledgerlink_state (id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      ["app", JSON.stringify(clean)]
    );
    return;
  }
  if (MONGODB_URI) {
    await (await getMongoCollection()).updateOne(
      { _id: "app" },
      { $set: { data: clean, updatedAt: new Date() } },
      { upsert: true }
    );
    return;
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(clean, null, 2));
}

function getPgPool() {
  if (!pgPool) {
    const { Pool } = require("pg");
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined
    });
  }
  return pgPool;
}

async function getMongoCollection() {
  if (!mongoClient) {
    const { MongoClient } = require("mongodb");
    mongoClient = new MongoClient(MONGODB_URI, {
      tls: true,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });
    await mongoClient.connect();
  }
  return mongoClient.db(MONGODB_DB).collection("app_state");
}

function emptyDb(orphanState = null) {
  return { schemaVersion: 2, users: [], businesses: [], invoices: [], sessions: [], auditLogs: [], reminderRuns: [], orphanState };
}

function migrateDb(data) {
  if (data.schemaVersion === 2) return sanitizeDb(data);
  return emptyDb({
    settings: sanitizeSettings(data.settings || seedSettings),
    invoices: Array.isArray(data.invoices) ? data.invoices.map(sanitizeInvoice) : seedInvoices.map(sanitizeInvoice)
  });
}

function sanitizeDb(data) {
  const db = {
    schemaVersion: 2,
    users: Array.isArray(data.users) ? data.users : [],
    businesses: Array.isArray(data.businesses) ? data.businesses : [],
    invoices: Array.isArray(data.invoices) ? data.invoices : [],
    sessions: Array.isArray(data.sessions) ? data.sessions.filter(session => new Date(session.expiresAt) > new Date()) : [],
    auditLogs: Array.isArray(data.auditLogs) ? data.auditLogs : [],
    reminderRuns: Array.isArray(data.reminderRuns) ? data.reminderRuns : [],
    orphanState: data.orphanState || null
  };
  db.businesses = db.businesses.map(business => ({
    id: String(business.id || newId("biz")),
    ownerUserId: String(business.ownerUserId || ""),
    settings: sanitizeSettings(business.settings || {}),
    paystack: sanitizePaystack(business.paystack || {}),
    subscription: sanitizeSubscription(business.subscription || {}),
    billingHistory: sanitizeBillingHistory(business.billingHistory || [])
  }));
  db.invoices = db.invoices.map(invoice => sanitizeInvoice(invoice));
  db.auditLogs = db.auditLogs.map(sanitizeAuditLog).filter(Boolean).slice(-800);
  db.reminderRuns = db.reminderRuns.map(sanitizeReminderRun).filter(Boolean).slice(-120);
  return db;
}

function claimInitialState(db) {
  if (db.orphanState) return db.orphanState;
  return { settings: seedSettings, invoices: [] };
}

function createUser(name, email, password) {
  return {
    id: newId("usr"),
    name: String(name || "").trim() || email,
    email,
    password: hashPassword(password),
    createdAt: new Date().toISOString()
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

function createSession(userId) {
  return {
    id: newId("sess"),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
}

function sessionPayload(user, db) {
  return {
    authenticated: true,
    user: { id: user.id, name: user.name, email: user.email },
    state: getStateForUser(db, user)
  };
}

async function getUserFromRequest(req) {
  const db = await readDb();
  const sessionId = getCookie(req, SESSION_COOKIE);
  const session = db.sessions.find(item => item.id === sessionId && new Date(item.expiresAt) > new Date());
  return { user: session ? db.users.find(user => user.id === session.userId) : null, db };
}

async function requireUser(req, res) {
  const db = await readDb();
  const sessionId = getCookie(req, SESSION_COOKIE);
  const session = db.sessions.find(item => item.id === sessionId && new Date(item.expiresAt) > new Date());
  const user = session ? db.users.find(item => item.id === session.userId) : null;
  if (!user) {
    writeJson(res, 401, { error: "Sign in required." });
    return {};
  }
  return { user, db };
}

function getBusinessForUser(db, user) {
  let business = db.businesses.find(item => item.ownerUserId === user.id);
  if (!business) {
    business = {
      id: newId("biz"),
      ownerUserId: user.id,
      settings: sanitizeSettings({ ...seedSettings, ownerEmail: user.email }),
      paystack: {},
      subscription: {},
      billingHistory: []
    };
    db.businesses.push(business);
  }
  return business;
}

function getStateForUser(db, user) {
  const business = getBusinessForUser(db, user);
  return {
    settings: business.settings,
    paystack: publicPaystackStatus(business),
    billing: subscriptionStatus(business, db),
    billingPlans: publicBillingPlans(),
    billingAddons: publicBillingAddons(),
    billingHistory: (business.billingHistory || []).slice(-20).map(publicBillingEvent),
    invoices: db.invoices.filter(invoice => invoice.businessId === business.id).map(({ businessId, ...invoice }) => invoice)
  };
}

function sanitizeSettings(settings) {
  const clean = {
    ...seedSettings,
    ...settings,
    brandColor: validColor(settings.brandColor, seedSettings.brandColor),
    accentColor: validColor(settings.accentColor, seedSettings.accentColor),
    logoDataUrl: validLogoDataUrl(settings.logoDataUrl) ? settings.logoDataUrl : "",
    automatedRemindersEnabled: settings.automatedRemindersEnabled === true || settings.automatedRemindersEnabled === "true" || settings.automatedRemindersEnabled === "on",
    automatedReminderChannels: sanitizeReminderChannels(settings.automatedReminderChannels),
    vatRate: Number(settings.vatRate ?? seedSettings.vatRate),
    reminderBeforeDays: Number(settings.reminderBeforeDays ?? seedSettings.reminderBeforeDays),
    reminderAfterDays: Number(settings.reminderAfterDays ?? seedSettings.reminderAfterDays)
  };
  delete clean.paystackInitUrl;
  delete clean.reminderEmailChannel;
  delete clean.reminderWhatsappChannel;
  return clean;
}

function sanitizeReminderChannels(channels = {}) {
  return {
    email: channels.email !== false && channels.email !== "false" && channels.email !== "off",
    whatsapp: false
  };
}

function sanitizePaystack(paystack) {
  return {
    secretKeyEncrypted: typeof paystack.secretKeyEncrypted === "string" ? paystack.secretKeyEncrypted : "",
    keyLast4: typeof paystack.keyLast4 === "string" ? paystack.keyLast4 : "",
    mode: paystack.mode === "live" ? "live" : paystack.mode === "test" ? "test" : "",
    updatedAt: paystack.updatedAt || ""
  };
}

function sanitizeSubscription(subscription) {
  return {
    status: subscription.status === "active" ? "active" : "inactive",
    expiresAt: subscription.expiresAt || "",
    paystackReference: subscription.paystackReference || "",
    plan: getBillingPlan(subscription.plan).id,
    updatedAt: subscription.updatedAt || ""
  };
}

function sanitizeBillingHistory(history) {
  return (Array.isArray(history) ? history : []).map(event => ({
    id: String(event.id || newId("bill")),
    type: String(event.type || "subscription"),
    status: String(event.status || ""),
    amountKobo: Number(event.amountKobo || 0),
    currency: String(event.currency || "NGN"),
    reference: String(event.reference || ""),
    source: String(event.source || ""),
    plan: getBillingPlan(event.plan).id,
    addon: String(event.addon || ""),
    emailCredits: Number(event.emailCredits || 0),
    whatsappCredits: Number(event.whatsappCredits || 0),
    periodStart: event.periodStart || "",
    periodEnd: event.periodEnd || "",
    createdAt: event.createdAt || new Date().toISOString()
  })).slice(-200);
}

function publicBillingEvent(event) {
  return {
    id: event.id,
    type: event.type,
    status: event.status,
    amountKobo: event.amountKobo,
    currency: event.currency,
    reference: event.reference,
    source: event.source,
    plan: event.plan,
    addon: event.addon,
    emailCredits: event.emailCredits,
    whatsappCredits: event.whatsappCredits,
    periodStart: event.periodStart,
    periodEnd: event.periodEnd,
    createdAt: event.createdAt
  };
}

function sanitizeAuditLog(log) {
  if (!log || !log.event) return null;
  return {
    id: String(log.id || newId("aud")),
    event: String(log.event || ""),
    actorUserId: String(log.actorUserId || ""),
    actorEmail: String(log.actorEmail || ""),
    businessId: String(log.businessId || ""),
    invoiceId: String(log.invoiceId || ""),
    message: String(log.message || ""),
    metadata: log.metadata && typeof log.metadata === "object" ? log.metadata : {},
    createdAt: log.createdAt || new Date().toISOString()
  };
}

function sanitizeReminderRun(run) {
  if (!run || !run.startedAt) return null;
  return {
    id: String(run.id || newId("rrun")),
    reason: String(run.reason || ""),
    dryRun: Boolean(run.dryRun),
    checked: Number(run.checked || 0),
    queued: Number(run.queued || 0),
    sent: Number(run.sent || 0),
    failed: Number(run.failed || 0),
    skipped: Number(run.skipped || 0),
    failures: (Array.isArray(run.failures) ? run.failures : []).slice(0, 20).map(failure => ({
      invoiceId: String(failure.invoiceId || ""),
      channel: String(failure.channel || ""),
      message: String(failure.message || "")
    })),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || ""
  };
}

function publicPaystackStatus(business) {
  const paystack = sanitizePaystack(business.paystack || {});
  return {
    configured: Boolean(paystack.secretKeyEncrypted),
    keyLast4: paystack.keyLast4,
    mode: paystack.mode,
    updatedAt: paystack.updatedAt
  };
}

function subscriptionStatus(business, db = null) {
  const subscription = sanitizeSubscription(business?.subscription || {});
  const plan = getBillingPlan(subscription.plan);
  const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
  const active = subscription.status === "active" && expiresAt && expiresAt > new Date();
  const usage = db ? notificationUsageForBusiness(db, business, subscription) : { email: 0, whatsapp: 0 };
  const addOns = billingAddonsForBusiness(business, subscription);
  const limits = {
    email: plan.emailLimit + addOns.email,
    whatsapp: plan.whatsappLimit + addOns.whatsapp
  };
  return {
    active: Boolean(active),
    status: active ? "active" : "inactive",
    plan: plan.id,
    planName: plan.name,
    priceKobo: plan.priceKobo,
    priceNaira: plan.priceKobo / 100,
    baseLimits: {
      email: plan.emailLimit,
      whatsapp: plan.whatsappLimit
    },
    addOns,
    limits,
    usage,
    expiresAt: subscription.expiresAt || "",
    daysLeft: active ? Math.ceil((expiresAt - new Date()) / 86400000) : 0
  };
}

function billingAddonsForBusiness(business, subscription = null) {
  const period = billingPeriodForBusiness(business, subscription);
  const addOns = { email: 0, whatsapp: 0 };
  if (!period.start || !period.end) return addOns;
  for (const event of Array.isArray(business?.billingHistory) ? business.billingHistory : []) {
    if (event.type !== "addon_payment" || event.status !== "paid") continue;
    const paidAt = new Date(event.createdAt || "");
    if (!Number.isFinite(paidAt.getTime()) || paidAt < period.start || paidAt > period.end) continue;
    addOns.email += Number(event.emailCredits || 0);
    addOns.whatsapp += Number(event.whatsappCredits || 0);
  }
  return addOns;
}

function notificationUsageForBusiness(db, business, subscription = null) {
  const period = billingPeriodForBusiness(business, subscription);
  const usage = { email: 0, whatsapp: 0 };
  if (!period.start || !period.end) return usage;
  const invoices = (db?.invoices || []).filter(invoice => invoice.businessId === business?.id);
  for (const invoice of invoices) {
    for (const reminder of Array.isArray(invoice.reminders) ? invoice.reminders : []) {
      const sentAt = new Date(reminder.at || reminder.date || "");
      if (!Number.isFinite(sentAt.getTime()) || sentAt < period.start || sentAt > period.end) continue;
      if (reminder.channel === "Auto Email") usage.email += 1;
    }
  }
  return usage;
}

function billingPeriodForBusiness(business, subscription = null) {
  const cleanSubscription = subscription || sanitizeSubscription(business?.subscription || {});
  const paidPeriods = [...(business?.billingHistory || [])]
    .reverse()
    .filter(event => ["subscription_payment", "admin_activate"].includes(event.type) && event.periodStart && event.periodEnd);
  const now = new Date();
  const currentPeriod = paidPeriods.find(event => {
    const start = new Date(event.periodStart);
    const end = new Date(event.periodEnd);
    return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= now && end >= now;
  });
  const latestPaid = currentPeriod || paidPeriods[0];
  const start = latestPaid?.periodStart ? new Date(latestPaid.periodStart) : cleanSubscription.updatedAt ? new Date(cleanSubscription.updatedAt) : null;
  const end = latestPaid?.periodEnd ? new Date(latestPaid.periodEnd) : cleanSubscription.expiresAt ? new Date(cleanSubscription.expiresAt) : null;
  return {
    start: start && Number.isFinite(start.getTime()) ? start : null,
    end: end && Number.isFinite(end.getTime()) ? end : null
  };
}

function sanitizeInvoice(invoice) {
  return {
    id: String(invoice.id || ""),
    publicId: String(invoice.publicId || newId("inv")),
    businessId: invoice.businessId ? String(invoice.businessId) : undefined,
    customer: String(invoice.customer || ""),
    email: String(invoice.email || ""),
    phone: String(invoice.phone || ""),
    issueDate: String(invoice.issueDate || new Date().toISOString().slice(0, 10)),
    dueDate: String(invoice.dueDate || new Date().toISOString().slice(0, 10)),
    status: ["draft", "pending", "paid", "overdue"].includes(invoice.status) ? invoice.status : "pending",
    notes: String(invoice.notes || ""),
    paidAt: invoice.paidAt,
    reminders: Array.isArray(invoice.reminders) ? invoice.reminders : [],
    items: Array.isArray(invoice.items)
      ? invoice.items.map(item => ({
          description: String(item.description || ""),
          quantity: Number(item.quantity || 0),
          price: Number(item.price || 0)
        }))
      : []
  };
}

function publicInvoicePayload(invoice) {
  const { businessId, reminders, ...safeInvoice } = invoice;
  return safeInvoice;
}

async function createInvoiceForRequest(req, body) {
  if (MONGODB_URI && !DATABASE_URL) {
    return createInvoiceInMongo(req, body);
  }
  const db = await readDb();
  const user = authenticatedUserFromDb(req, db);
  const business = getBusinessForUser(db, user);
  ensureCanCreateInvoice(business);
  const businessInvoices = db.invoices.filter(invoice => invoice.businessId === business.id);
  const invoice = invoiceFromRequestBody(body, business, nextInvoiceId(businessInvoices));
  db.invoices.unshift(invoice);
  logAudit(db, invoiceCreatedAudit(user, business, invoice));
  await writeDb(db);
  return invoice;
}

async function createInvoiceInMongo(req, body) {
  const collection = await getMongoCollection();
  const document = await collection.findOne(
    { _id: "app" },
    { projection: { "data.users": 1, "data.businesses": 1, "data.sessions": 1 } }
  );
  const db = sanitizeDb({ ...emptyDb(), ...(document?.data || {}), invoices: [] });
  const user = authenticatedUserFromDb(req, db);
  const business = getBusinessForUser(db, user);
  ensureCanCreateInvoice(business);

  const invoiceIds = await collection.aggregate([
    { $match: { _id: "app" } },
    { $unwind: "$data.invoices" },
    { $match: { "data.invoices.businessId": business.id } },
    { $project: { _id: 0, id: "$data.invoices.id" } }
  ]).toArray();
  const invoice = invoiceFromRequestBody(body, business, nextInvoiceId(invoiceIds));
  const auditLog = sanitizeAuditLog(invoiceCreatedAudit(user, business, invoice));
  const update = {
    $push: {
      "data.invoices": { $each: [invoice], $position: 0 },
      "data.auditLogs": { $each: [auditLog], $slice: -800 }
    },
    $set: { updatedAt: new Date() }
  };
  await collection.updateOne({ _id: "app" }, update);
  return invoice;
}

function authenticatedUserFromDb(req, db) {
  const sessionId = getCookie(req, SESSION_COOKIE);
  const session = db.sessions.find(item => item.id === sessionId && new Date(item.expiresAt) > new Date());
  const user = session ? db.users.find(item => item.id === session.userId) : null;
  if (!user) throw httpError("Sign in required.", 401);
  return user;
}

function ensureCanCreateInvoice(business) {
  if (!subscriptionStatus(business).active) {
    throw httpError("Renew the LedgerLink plan before creating invoices.", 402);
  }
}

function invoiceFromRequestBody(body, business, invoiceId) {
  const invoice = sanitizeInvoice({
    ...body,
    id: invoiceId,
    publicId: body.publicId || newId("inv"),
    reminders: [],
    paidAt: body.status === "paid" ? new Date().toISOString().slice(0, 10) : ""
  });
  if (!invoice.customer || !invoice.email || !invoice.items.length) {
    throw httpError("Customer name, email, and at least one line item are required.", 400);
  }
  invoice.businessId = business.id;
  return invoice;
}

function invoiceCreatedAudit(user, business, invoice) {
  return {
    event: "invoice.created",
    actorUserId: user.id,
    actorEmail: user.email,
    businessId: business.id,
    invoiceId: invoice.id,
    message: `Invoice ${invoice.id} created`
  };
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serveStatic(urlPath, res) {
  const requestPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(ROOT_DIR, requestPath));
  if (!filePath.startsWith(ROOT_DIR)) {
    writeJson(res, 403, { error: "Forbidden." });
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    writeJson(res, 404, { error: "Not found." });
    return;
  }
  res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function paystackFetch(pathname, secretKey, options = {}) {
  return fetch(`https://api.paystack.co/${pathname.replace(/^\/+/, "")}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function verifyPaystack(reference, secretKey) {
  const paystackResponse = await paystackFetch(`transaction/verify/${encodeURIComponent(reference)}`, secretKey);
  return paystackResponse.json();
}

function findInvoiceByReference(db, reference) {
  const match = String(reference || "").match(/^(.+)-\d{10,}$/);
  const invoiceId = match ? match[1] : "";
  return db.invoices.find(item => item.publicId === invoiceId);
}

async function markInvoicePaidFromTransaction(transaction) {
  const invoiceId = transaction?.metadata?.invoiceId;
  const publicId = transaction?.metadata?.publicId;
  const db = await readDb();
  const invoice = db.invoices.find(item => (publicId && item.publicId === publicId) || (item.id === invoiceId && item.businessId === transaction?.metadata?.businessId));
  if (!invoice) return { ok: false, error: "Invoice not found for transaction." };
  const business = db.businesses.find(item => item.id === invoice.businessId);
  const expectedAmount = Math.round(invoiceTotal(invoice, business.settings) * 100);
  if (transaction.status !== "success") return { ok: false, error: "Transaction was not successful." };
  if (transaction.currency !== "NGN") return { ok: false, error: "Unexpected transaction currency." };
  if (Number(transaction.amount) !== expectedAmount) return { ok: false, error: "Transaction amount does not match invoice total." };
  if (transaction.metadata?.businessId && transaction.metadata.businessId !== invoice.businessId) {
    return { ok: false, error: "Transaction business does not match invoice owner." };
  }
  invoice.status = "paid";
  invoice.paidAt = String(transaction.paid_at || new Date().toISOString()).slice(0, 10);
  invoice.paystackReference = transaction.reference;
  logAudit(db, {
    event: "invoice.paid",
    businessId: invoice.businessId,
    invoiceId: invoice.id,
    message: `Invoice ${invoice.id} marked paid from Paystack`,
    metadata: { reference: transaction.reference }
  });
  await writeDb(db);
  return { ok: true };
}

async function markSubscriptionPaidFromTransaction(transaction, expectedUserId = "") {
  const metadata = transaction?.metadata || {};
  const db = await readDb();
  const business = db.businesses.find(item => item.id === metadata.businessId);
  if (!business) return { ok: false, error: "Business not found for subscription payment." };
  if (expectedUserId && business.ownerUserId !== expectedUserId) {
    return { ok: false, error: "Subscription payment does not belong to this account." };
  }
  if (metadata.project !== "ledgerlink-saas") return { ok: false, error: "Unexpected billing project metadata." };
  if (transaction.status !== "success") return { ok: false, error: "Subscription transaction was not successful." };
  if (transaction.currency !== "NGN") return { ok: false, error: "Unexpected subscription currency." };
  const plan = getBillingPlan(metadata.plan);
  const expectedAmount = Number(metadata.expectedAmount || plan.priceKobo);
  if (Number(transaction.amount) !== expectedAmount || expectedAmount !== plan.priceKobo) {
    return { ok: false, error: "Subscription amount does not match the LedgerLink plan." };
  }
  const existingPaidEvent = (business.billingHistory || []).find(event =>
    event.reference === transaction.reference && event.type === "subscription_payment" && event.status === "paid"
  );
  if (existingPaidEvent) {
    return { ok: true, expiresAt: business.subscription?.expiresAt || existingPaidEvent.periodEnd || "", duplicate: true };
  }

  const currentExpiry = business.subscription?.expiresAt ? new Date(business.subscription.expiresAt) : null;
  const start = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
  const expiresAt = new Date(start.getTime() + BILLING_DURATION_DAYS * 86400000).toISOString();
  const periodStart = start.toISOString();
  business.subscription = {
    status: "active",
    expiresAt,
    paystackReference: transaction.reference,
    plan: plan.id,
    updatedAt: new Date().toISOString()
  };
  addBillingEvent(business, {
    type: "subscription_payment",
    status: "paid",
    amountKobo: Number(transaction.amount || plan.priceKobo),
    currency: String(transaction.currency || "NGN"),
    reference: transaction.reference,
    source: "paystack",
    plan: plan.id,
    periodStart,
    periodEnd: expiresAt
  });
  logAudit(db, {
    event: "billing.paid",
    actorUserId: business.ownerUserId,
    businessId: business.id,
    message: `${plan.name} payment verified`,
    metadata: { reference: transaction.reference, expiresAt, plan: plan.id }
  });
  await writeDb(db);
  return { ok: true, expiresAt };
}

async function markAddonPaidFromTransaction(transaction, expectedUserId = "") {
  const metadata = transaction?.metadata || {};
  const db = await readDb();
  const business = db.businesses.find(item => item.id === metadata.businessId);
  if (!business) return { ok: false, error: "Business not found for add-on payment." };
  if (expectedUserId && business.ownerUserId !== expectedUserId) {
    return { ok: false, error: "Add-on payment does not belong to this account." };
  }
  if (metadata.project !== "ledgerlink-saas" || metadata.billingType !== "addon") {
    return { ok: false, error: "Unexpected add-on payment metadata." };
  }
  if (!subscriptionStatus(business, db).active) return { ok: false, error: "Subscription must be active before applying add-on credits." };
  if (transaction.status !== "success") return { ok: false, error: "Add-on transaction was not successful." };
  if (transaction.currency !== "NGN") return { ok: false, error: "Unexpected add-on currency." };
  const addon = getBillingAddon(metadata.addon);
  if (!addon) return { ok: false, error: "Unknown add-on bundle." };
  const expectedAmount = Number(metadata.expectedAmount || addon.priceKobo);
  if (Number(transaction.amount) !== expectedAmount || expectedAmount !== addon.priceKobo) {
    return { ok: false, error: "Add-on amount does not match the selected bundle." };
  }
  const existingPaidEvent = (business.billingHistory || []).find(event =>
    event.reference === transaction.reference && event.type === "addon_payment" && event.status === "paid"
  );
  if (existingPaidEvent) return { ok: true, duplicate: true };

  const period = billingPeriodForBusiness(business);
  addBillingEvent(business, {
    type: "addon_payment",
    status: "paid",
    amountKobo: Number(transaction.amount || addon.priceKobo),
    currency: String(transaction.currency || "NGN"),
    reference: transaction.reference,
    source: "paystack",
    addon: addon.id,
    emailCredits: addon.emailLimit,
    whatsappCredits: addon.whatsappLimit,
    periodStart: period.start ? period.start.toISOString() : "",
    periodEnd: period.end ? period.end.toISOString() : ""
  });
  logAudit(db, {
    event: "billing.addon_paid",
    actorUserId: business.ownerUserId,
    businessId: business.id,
    message: `${addon.name} payment verified`,
    metadata: { reference: transaction.reference, addon: addon.id, emailCredits: addon.emailLimit, whatsappCredits: addon.whatsappLimit }
  });
  await writeDb(db);
  return { ok: true };
}

async function setSubscriptionByAdmin(body) {
  const email = normalizeEmail(body.email);
  const action = String(body.action || "activate").toLowerCase();
  const days = Number(body.days || BILLING_DURATION_DAYS);
  const plan = getBillingPlan(body.planId || body.plan);
  if (!email) {
    const error = new Error("Admin subscription update requires an email.");
    error.statusCode = 400;
    throw error;
  }
  if (!["activate", "deactivate"].includes(action)) {
    const error = new Error("Admin subscription action must be activate or deactivate.");
    error.statusCode = 400;
    throw error;
  }
  const db = await readDb();
  const user = db.users.find(item => item.email === email);
  if (!user) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }
  const business = getBusinessForUser(db, user);
  if (action === "deactivate") {
    business.subscription = {
      status: "inactive",
      expiresAt: "",
      paystackReference: "manual-admin-deactivate",
      plan: business.subscription?.plan || plan.id,
      updatedAt: new Date().toISOString()
    };
    addBillingEvent(business, {
      type: "admin_deactivate",
      status: "inactive",
      reference: "manual-admin-deactivate",
      source: "admin",
      plan: business.subscription?.plan || plan.id
    });
  } else {
    const periodStart = new Date().toISOString();
    const periodEnd = new Date(Date.now() + Math.max(1, days) * 86400000).toISOString();
    business.subscription = {
      status: "active",
      expiresAt: periodEnd,
      paystackReference: "manual-admin-activate",
      plan: plan.id,
      updatedAt: new Date().toISOString()
    };
    addBillingEvent(business, {
      type: "admin_activate",
      status: "active",
      reference: "manual-admin-activate",
      source: "admin",
      plan: plan.id,
      periodStart,
      periodEnd
    });
  }
  logAudit(db, {
    event: `admin.subscription_${action}`,
    actorEmail: "admin",
    businessId: business.id,
    message: `Subscription ${action}d by admin`,
    metadata: { email, plan: plan.id, days: action === "activate" ? Math.max(1, days) : 0 }
  });
  await writeDb(db);
  return { ok: true, email, billing: subscriptionStatus(business, db) };
}

async function runAutomatedReminders({ dryRun = false, reason = "manual" } = {}) {
  const startedAt = new Date().toISOString();
  const db = await readDb();
  const run = {
    id: newId("rrun"),
    reason,
    dryRun: Boolean(dryRun || !reminderProviderReady()),
    checked: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    startedAt,
    finishedAt: ""
  };
  const businessesById = new Map(db.businesses.map(business => [business.id, business]));
  const usersById = new Map(db.users.map(user => [user.id, user]));
  const todayKey = new Date().toISOString().slice(0, 10);

  for (const invoice of db.invoices) {
    run.checked += 1;
    const business = businessesById.get(invoice.businessId);
    if (!business || !subscriptionStatus(business).active) {
      run.skipped += 1;
      continue;
    }
    if (!business.settings?.automatedRemindersEnabled) {
      run.skipped += 1;
      continue;
    }
    const billing = subscriptionStatus(business, db);
    const channels = allowedReminderChannels(business, billing)
      .filter(channel => recipientForChannel(invoice, channel))
      .filter(channel => run.dryRun || reminderChannelReady(channel));
    if (!channels.length || !["pending", "overdue"].includes(effectiveStatus(invoice))) {
      run.skipped += 1;
      continue;
    }
    const dueIn = daysUntil(invoice.dueDate);
    const before = Number(business.settings?.reminderBeforeDays || 0);
    const after = Number(business.settings?.reminderAfterDays || 0);
    const shouldSend = dueIn >= 0 ? dueIn <= before : Math.abs(dueIn) >= after;
    if (!shouldSend) {
      run.skipped += 1;
      continue;
    }

    const queuedChannels = channels.filter(channel =>
      !reminderAlreadySentToday(invoice, todayKey, channel) &&
      !reminderLimitReached(billing, channel)
    );
    if (!queuedChannels.length) {
      run.skipped += 1;
      continue;
    }

    run.queued += queuedChannels.length;
    const owner = usersById.get(business.ownerUserId);
    const message = reminderMessageForInvoice(invoice, business);
    if (run.dryRun) continue;

    for (const channel of queuedChannels) {
      try {
        await sendReminderDelivery({
          channel,
          invoice,
          business,
          owner,
          message
        });
        invoice.reminders = Array.isArray(invoice.reminders) ? invoice.reminders : [];
        invoice.reminders.push({ date: todayKey, channel: autoReminderChannelName(channel), at: new Date().toISOString() });
        billing.usage[channel] += 1;
        logAudit(db, {
          event: "reminder.sent",
          businessId: business.id,
          invoiceId: invoice.id,
          message: `Automated ${channel} reminder sent for ${invoice.id}`,
          metadata: { channel }
        });
        run.sent += 1;
      } catch (error) {
        const failure = {
          invoiceId: invoice.id,
          channel,
          message: error.message
        };
        run.failures.push(failure);
        console.error("Reminder delivery failed:", failure);
        logAudit(db, {
          event: "reminder.failed",
          businessId: business.id,
          invoiceId: invoice.id,
          message: error.message,
          metadata: failure
        });
        run.failed += 1;
      }
    }
  }

  run.finishedAt = new Date().toISOString();
  db.reminderRuns = [...(db.reminderRuns || []), run].slice(-120);
  await writeDb(db);
  return { ...run, providerConfigured: reminderProviderReady() };
}

function reminderProviderReady() {
  return reminderChannelReady("email");
}

function reminderChannelReady(channel) {
  if (!TERMII_API_KEY || !TERMII_BASE_URL || !PUBLIC_BASE_URL) return false;
  if (channel === "email") return Boolean(TERMII_EMAIL_CONFIGURATION_ID && TERMII_EMAIL_TEMPLATE_ID);
  return false;
}

function allowedReminderChannels(business, billing = null) {
  const limits = billing?.limits || subscriptionStatus(business).limits || {};
  const channels = sanitizeReminderChannels(business?.settings?.automatedReminderChannels || {});
  return ["email"].filter(channel => channels[channel] === true && Number(limits[channel] || 0) > 0);
}

function recipientForChannel(invoice, channel) {
  if (channel === "email") return isDeliverableEmail(invoice.email);
  return false;
}

function isDeliverableEmail(email) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return false;
  const domain = normalized.split("@").pop();
  return !["example.com", "example.net", "example.org"].includes(domain) && !domain.endsWith(".test") && !domain.endsWith(".invalid");
}

function reminderLimitReached(billing, channel) {
  const limit = Number(billing?.limits?.[channel] || 0);
  if (limit <= 0) return true;
  return Number(billing?.usage?.[channel] || 0) >= limit;
}

function autoReminderChannelName(channel) {
  return "Auto Email";
}

async function sendReminderDelivery({ channel, invoice, business, owner, message }) {
  if (!reminderChannelReady(channel)) throw new Error(`Termii ${channel} provider is not configured.`);
  return sendTermiiEmailReminder({ invoice, business, owner, message });
}

async function sendTermiiEmailReminder({ invoice, business, owner, message }) {
  const variables = reminderVariables(invoice, business, message);
  const response = await fetch(`${TERMII_BASE_URL}/api/templates/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: TERMII_API_KEY,
      email: invoice.email,
      subject: `Payment reminder from ${variables.business_name} - ${invoice.id}`,
      email_configuration_id: TERMII_EMAIL_CONFIGURATION_ID,
      template_id: TERMII_EMAIL_TEMPLATE_ID,
      variables
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    const details = payload.details || payload.error || payload.message || text || response.statusText;
    throw new Error(`Termii email reminder failed with HTTP ${response.status} at ${TERMII_BASE_URL}/api/templates/send-email: ${details}`);
  }
  return response.json();
}

function reminderVariables(invoice, business, message) {
  const total = formatMoneyPlain(invoiceTotal(invoice, business.settings));
  const due = new Date(invoice.dueDate + "T00:00:00").toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
  return {
    customer_name: invoice.customer,
    invoice_id: invoice.id,
    amount: total,
    due_date: due,
    payment_link: `${PUBLIC_BASE_URL || ""}/#pay/${encodeURIComponent(invoice.publicId || invoice.id)}`,
    business_name: business.settings?.businessName || "LedgerLink",
    message
  };
}

function reminderMessageForInvoice(invoice, business) {
  const total = formatMoneyPlain(invoiceTotal(invoice, business.settings));
  const due = new Date(invoice.dueDate + "T00:00:00").toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
  const url = `${PUBLIC_BASE_URL || ""}/#pay/${encodeURIComponent(invoice.publicId || invoice.id)}`;
  if (effectiveStatus(invoice) === "overdue") {
    return `Hello ${invoice.customer}, this is a friendly reminder that invoice ${invoice.id} for ${total} was due on ${due}. You can review and pay here: ${url}`;
  }
  return `Hello ${invoice.customer}, invoice ${invoice.id} for ${total} is due on ${due}. You can review and pay here: ${url}`;
}

function reminderHtml({ invoice, business, message }) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#17201c">
      <h2 style="margin:0 0 12px">${escapeHtmlServer(business.settings?.businessName || "LedgerLink")}</h2>
      <p>${escapeHtmlServer(message)}</p>
      <p><a href="${PUBLIC_BASE_URL || ""}/#pay/${encodeURIComponent(invoice.publicId || invoice.id)}">View invoice</a></p>
    </div>
  `;
}

function reminderAlreadySentToday(invoice, todayKey, channel = "email") {
  const autoChannel = autoReminderChannelName(channel);
  return (Array.isArray(invoice.reminders) ? invoice.reminders : []).some(reminder =>
    reminder.channel === autoChannel && String(reminder.date || reminder.at || "").slice(0, 10) === todayKey
  );
}

function normalizePhoneForTermii(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("234") && digits.length >= 13) return digits;
  if (digits.startsWith("0") && digits.length >= 11) return `234${digits.slice(1)}`;
  return digits;
}

function daysUntil(dateValue) {
  const target = new Date(String(dateValue).slice(0, 10) + "T00:00:00");
  const start = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");
  return Math.round((target - start) / 86400000);
}

function addBillingEvent(business, event) {
  business.billingHistory = sanitizeBillingHistory([
    ...(business.billingHistory || []),
    {
      id: newId("bill"),
      createdAt: new Date().toISOString(),
      currency: "NGN",
      amountKobo: 0,
      ...event
    }
  ]);
}

function logAudit(db, event) {
  db.auditLogs = [
    ...(Array.isArray(db.auditLogs) ? db.auditLogs : []),
    {
      id: newId("aud"),
      createdAt: new Date().toISOString(),
      ...event
    }
  ].slice(-800);
}

function adminOverview(db) {
  const usersById = new Map(db.users.map(user => [user.id, user]));
  const businesses = db.businesses.map(business => {
    const user = usersById.get(business.ownerUserId);
    const invoices = db.invoices.filter(invoice => invoice.businessId === business.id);
    const billing = subscriptionStatus(business, db);
    return {
      id: business.id,
      businessName: business.settings?.businessName || "",
      ownerEmail: user?.email || "",
      ownerName: user?.name || "",
      billing,
      paystack: publicPaystackStatus(business),
      invoiceCount: invoices.length,
      outstandingCount: invoices.filter(invoice => ["pending", "overdue"].includes(effectiveStatus(invoice))).length,
      billingHistory: (business.billingHistory || []).slice(-8).map(publicBillingEvent)
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      users: db.users.length,
      businesses: db.businesses.length,
      activeSubscriptions: businesses.filter(item => item.billing.active).length,
      invoices: db.invoices.length
    },
    businesses,
    auditLogs: (db.auditLogs || []).slice(-80).reverse(),
    reminderRuns: (db.reminderRuns || []).slice(-20).reverse()
  };
}

function businessPaystackSecret(business) {
  const encrypted = business?.paystack?.secretKeyEncrypted;
  return encrypted ? decryptSecret(encrypted) : "";
}

function requireAppSecret() {
  if (!APP_SECRET || APP_SECRET.length < 24) {
    const error = new Error("APP_SECRET is required before storing Paystack keys. Set a long random APP_SECRET in Render.");
    error.statusCode = 500;
    throw error;
  }
}

function encryptionKey() {
  requireAppSecret();
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

function decryptSecret(value) {
  const [ivRaw, tagRaw, encryptedRaw] = String(value || "").split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

async function matchPaystackWebhookSecret(rawBody, signature) {
  if (!signature) return null;
  if (PLATFORM_PAYSTACK_SECRET_KEY && paystackSignature(rawBody, PLATFORM_PAYSTACK_SECRET_KEY) === signature) {
    return { type: "platform" };
  }
  const db = await readDb();
  for (const business of db.businesses) {
    const secret = businessPaystackSecret(business);
    if (secret && paystackSignature(rawBody, secret) === signature) {
      return { type: "merchant", businessId: business.id };
    }
  }
  return null;
}

function paystackSignature(rawBody, secretKey) {
  return crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
}

function nextInvoiceId(invoices) {
  const max = invoices.reduce((num, invoice) => {
    const match = String(invoice.id || "").match(/^INV-(\d{1,3})$/i);
    return Math.max(num, match ? Number(match[1]) : 0);
  }, 0);
  return `INV-${String(max + 1).padStart(3, "0")}`;
}

function invoiceTotal(invoice, settings) {
  const subtotal = invoice.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
  return subtotal + subtotal * (Number(settings.vatRate || 0) / 100);
}

function effectiveStatus(invoice) {
  if (invoice.status === "paid" || invoice.status === "draft") return invoice.status;
  return new Date(invoice.dueDate + "T23:59:59") < new Date() ? "overdue" : "pending";
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function validLogoDataUrl(value) {
  return typeof value === "string" && (value === "" || /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(value));
}

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function runReminderScheduleIfDue() {
  const now = new Date();
  const schedule = reminderScheduleParts(now);
  if (schedule.hour !== REMINDER_DAILY_HOUR) return;
  const scheduleKey = schedule.dateKey;
  if (lastReminderScheduleKey === scheduleKey) return;
  lastReminderScheduleKey = scheduleKey;
  const result = await runAutomatedReminders({ dryRun: !reminderProviderReady(), reason: "schedule" });
  console.log(`Reminder run: checked=${result.checked} queued=${result.queued} sent=${result.sent} failed=${result.failed} dryRun=${result.dryRun}`);
}

function reminderScheduleParts(date) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: REMINDER_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const value = name => parts.find(part => part.type === name)?.value || "";
    return {
      hour: Number(value("hour")),
      dateKey: `${value("year")}-${value("month")}-${value("day")}`
    };
  } catch {
    return {
      hour: date.getUTCHours(),
      dateKey: date.toISOString().slice(0, 10)
    };
  }
}

function formatMoneyPlain(value) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function escapeHtmlServer(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setSecurityHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-paystack-signature,x-admin-token");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://js.paystack.co; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://checkout.paystack.com https://*.paystack.co; base-uri 'self'; form-action 'self'"
  );
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

function allowSameOriginMutation(req, url) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return true;
  if (url.pathname === "/paystack/webhook") return true;
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const expected = PUBLIC_BASE_URL || `http://${req.headers.host}`;
  if (origin) return normalizeOrigin(origin) === normalizeOrigin(expected);
  if (referer) return normalizeOrigin(referer) === normalizeOrigin(expected);
  return true;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function checkRateLimit(req, res, scope, limit, windowMs) {
  const key = `${scope}:${clientIp(req)}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  if (bucket.count <= limit) return true;
  const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
  res.setHeader("Retry-After", String(retryAfter));
  writeJson(res, 429, { error: "Too many requests. Try again shortly." });
  return false;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function setSessionCookie(res, sessionId) {
  const secure = IS_PRODUCTION ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

function clearSessionCookie(res) {
  const secure = IS_PRODUCTION ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map(part => part.trim());
  const match = cookies.find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

function requirePlatformSecret() {
  if (!PLATFORM_PAYSTACK_SECRET_KEY) {
    const error = new Error("PLATFORM_PAYSTACK_SECRET_KEY is not configured.");
    error.statusCode = 500;
    throw error;
  }
}

function requireAdmin(req) {
  if (!ADMIN_API_TOKEN || ADMIN_API_TOKEN.length < 24) {
    const error = new Error("ADMIN_API_TOKEN is not configured.");
    error.statusCode = 500;
    throw error;
  }
  const token = String(req.headers["x-admin-token"] || "");
  const expected = Buffer.from(ADMIN_API_TOKEN);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    const error = new Error("Admin access denied.");
    error.statusCode = 403;
    throw error;
  }
}

function loadEnvFiles(filenames) {
  const loaded = [];
  for (const filename of filenames) {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) return;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) return;
      process.env[key] = unquoteEnvValue(rawValue.trim());
    });
    loaded.push(filename);
  }
  return loaded;
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 5_000_000) req.destroy();
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
