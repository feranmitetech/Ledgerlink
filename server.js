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
const BILLING_PRICE_KOBO = Number(process.env.LEDGERLINK_MONTHLY_PRICE_KOBO || 1200000);
const BILLING_DURATION_DAYS = Number(process.env.LEDGERLINK_BILLING_DAYS || 30);
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

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

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
      db.businesses.push({ id: businessId, ownerUserId: user.id, settings });
      db.invoices.push(...invoices);
      db.orphanState = null;

      const session = createSession(user.id);
      db.sessions.push(session);
      await writeDb(db);
      setSessionCookie(res, session.id);
      writeJson(res, 201, sessionPayload(user, db));
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
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
      await writeDb(db);
      writeJson(res, 200, { paystack: publicPaystackStatus(business) });
      return;
    }

    if (url.pathname === "/api/billing/status" && req.method === "GET") {
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      writeJson(res, 200, { billing: subscriptionStatus(getBusinessForUser(db, user)) });
      return;
    }

    if (url.pathname === "/api/billing/initialize" && req.method === "POST") {
      requirePlatformSecret();
      const { user, db } = await requireUser(req, res);
      if (!user) return;
      const business = getBusinessForUser(db, user);
      const callbackBase = PUBLIC_BASE_URL || `${url.protocol}//${req.headers.host}`;
      const reference = `LL-SUB-${business.id}-${Date.now()}`;
      const payload = {
        email: user.email,
        amount: BILLING_PRICE_KOBO,
        currency: "NGN",
        reference,
        callback_url: `${callbackBase}/?billing=return`,
        metadata: {
          project: "ledgerlink-saas",
          plan: "monthly",
          businessId: business.id,
          userId: user.id,
          expectedAmount: BILLING_PRICE_KOBO,
          expectedCurrency: "NGN"
        }
      };
      const paystackResponse = await paystackFetch("transaction/initialize", PLATFORM_PAYSTACK_SECRET_KEY, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      writeJson(res, paystackResponse.status, await paystackResponse.json());
      return;
    }

    if (url.pathname === "/api/billing/verify" && req.method === "GET") {
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
      writeJson(res, 200, { ...data, billing: subscriptionStatus(getBusinessForUser(await readDb(), user)) });
      return;
    }

    const publicInvoice = url.pathname.match(/^\/api\/public\/invoices\/([^/]+)$/);
    if (publicInvoice && req.method === "GET") {
      const db = await readDb();
      const token = decodeURIComponent(publicInvoice[1]);
      const invoice = db.invoices.find(item => item.publicId === token || item.id === token);
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
      const body = await readJson(req);
      const db = await readDb();
      const invoice = db.invoices.find(item =>
        item.publicId === body.publicId ||
        item.publicId === body.invoiceId ||
        item.id === body.invoiceId
      );
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

    if (url.pathname === "/paystack/webhook" && req.method === "POST") {
      const rawBody = await readRaw(req);
      const signature = String(req.headers["x-paystack-signature"] || "");
      const webhookMatch = await matchPaystackWebhookSecret(rawBody, signature);
      if (!webhookMatch) {
        writeJson(res, 401, { error: "Invalid webhook signature." });
        return;
      }
      const event = JSON.parse(rawBody);
      if (event.event === "charge.success") {
        const result = event.data?.metadata?.project === "ledgerlink-saas"
          ? await markSubscriptionPaidFromTransaction(event.data)
          : await markInvoicePaidFromTransaction(event.data);
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
    if (PUBLIC_BASE_URL) console.log(`Public webhook/callback base URL: ${PUBLIC_BASE_URL}`);
  });
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
  return { schemaVersion: 2, users: [], businesses: [], invoices: [], sessions: [], orphanState };
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
    orphanState: data.orphanState || null
  };
  db.businesses = db.businesses.map(business => ({
    id: String(business.id || newId("biz")),
    ownerUserId: String(business.ownerUserId || ""),
    settings: sanitizeSettings(business.settings || {}),
    paystack: sanitizePaystack(business.paystack || {}),
    subscription: sanitizeSubscription(business.subscription || {})
  }));
  db.invoices = db.invoices.map(invoice => sanitizeInvoice(invoice));
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
      subscription: {}
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
    billing: subscriptionStatus(business),
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
    vatRate: Number(settings.vatRate ?? seedSettings.vatRate),
    reminderBeforeDays: Number(settings.reminderBeforeDays ?? seedSettings.reminderBeforeDays),
    reminderAfterDays: Number(settings.reminderAfterDays ?? seedSettings.reminderAfterDays)
  };
  delete clean.paystackInitUrl;
  return clean;
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
    updatedAt: subscription.updatedAt || ""
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

function subscriptionStatus(business) {
  const subscription = sanitizeSubscription(business?.subscription || {});
  const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
  const active = subscription.status === "active" && expiresAt && expiresAt > new Date();
  return {
    active: Boolean(active),
    status: active ? "active" : "inactive",
    priceKobo: BILLING_PRICE_KOBO,
    priceNaira: BILLING_PRICE_KOBO / 100,
    expiresAt: subscription.expiresAt || "",
    daysLeft: active ? Math.ceil((expiresAt - new Date()) / 86400000) : 0
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
  return db.invoices.find(item => item.publicId === invoiceId || item.id === invoiceId);
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
  if (Number(transaction.amount) !== BILLING_PRICE_KOBO) return { ok: false, error: "Subscription amount does not match the LedgerLink plan." };

  const currentExpiry = business.subscription?.expiresAt ? new Date(business.subscription.expiresAt) : null;
  const start = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
  const expiresAt = new Date(start.getTime() + BILLING_DURATION_DAYS * 86400000).toISOString();
  business.subscription = {
    status: "active",
    expiresAt,
    paystackReference: transaction.reference,
    updatedAt: new Date().toISOString()
  };
  await writeDb(db);
  return { ok: true, expiresAt };
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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-paystack-signature");
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
