const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const PAYSTACK_SECRET_KEY = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "ledgerlink-db.json");
const SESSION_COOKIE = "ledgerlink_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

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

ensureDatabase();

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
      const user = getUserFromRequest(req);
      writeJson(res, 200, user ? sessionPayload(user) : { authenticated: false });
      return;
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const body = await readJson(req);
      const db = readDb();
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
      writeDb(db);
      setSessionCookie(res, session.id);
      writeJson(res, 201, sessionPayload(user, db));
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJson(req);
      const db = readDb();
      const user = db.users.find(item => item.email === normalizeEmail(body.email));
      if (!user || !verifyPassword(String(body.password || ""), user.password)) {
        writeJson(res, 401, { error: "Invalid email or password." });
        return;
      }
      const session = createSession(user.id);
      db.sessions.push(session);
      writeDb(db);
      setSessionCookie(res, session.id);
      writeJson(res, 200, sessionPayload(user, db));
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const db = readDb();
      const sessionId = getCookie(req, SESSION_COOKIE);
      db.sessions = db.sessions.filter(session => session.id !== sessionId);
      writeDb(db);
      clearSessionCookie(res);
      writeJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      const { user, db } = requireUser(req, res);
      if (!user) return;
      writeJson(res, 200, getStateForUser(db, user));
      return;
    }

    if (url.pathname === "/api/state" && req.method === "PUT") {
      const { user, db } = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const business = getBusinessForUser(db, user);
      business.settings = sanitizeSettings(body.settings || {});
      db.invoices = db.invoices.filter(invoice => invoice.businessId !== business.id);
      db.invoices.push(...(Array.isArray(body.invoices) ? body.invoices : []).map(invoice => ({
        ...sanitizeInvoice(invoice),
        businessId: business.id
      })));
      writeDb(db);
      writeJson(res, 200, getStateForUser(db, user));
      return;
    }

    const publicInvoice = url.pathname.match(/^\/api\/public\/invoices\/([^/]+)$/);
    if (publicInvoice && req.method === "GET") {
      const db = readDb();
      const invoice = db.invoices.find(item => item.id === decodeURIComponent(publicInvoice[1]));
      if (!invoice) {
        writeJson(res, 404, { error: "Invoice not found." });
        return;
      }
      const business = db.businesses.find(item => item.id === invoice.businessId);
      writeJson(res, 200, { settings: business.settings, invoice: publicInvoicePayload(invoice) });
      return;
    }

    const invoicePatch = url.pathname.match(/^\/api\/invoices\/([^/]+)$/);
    if (invoicePatch && req.method === "PATCH") {
      const { user, db } = requireUser(req, res);
      if (!user) return;
      const business = getBusinessForUser(db, user);
      const invoice = db.invoices.find(item => item.id === decodeURIComponent(invoicePatch[1]) && item.businessId === business.id);
      if (!invoice) {
        writeJson(res, 404, { error: "Invoice not found." });
        return;
      }
      Object.assign(invoice, sanitizeInvoice({ ...invoice, ...(await readJson(req)) }), { businessId: business.id });
      writeDb(db);
      writeJson(res, 200, invoice);
      return;
    }

    if (url.pathname === "/paystack/initialize" && req.method === "POST") {
      requireSecret();
      const body = await readJson(req);
      const db = readDb();
      const invoice = db.invoices.find(item => item.id === body.invoiceId);
      if (!invoice || !["pending", "overdue"].includes(effectiveStatus(invoice))) {
        writeJson(res, 404, { error: "Payable invoice not found." });
        return;
      }

      const business = db.businesses.find(item => item.id === invoice.businessId);
      const amount = Math.round(invoiceTotal(invoice, business.settings) * 100);
      const reference = `${invoice.id}-${Date.now()}`;
      const payload = {
        email: invoice.email,
        amount,
        currency: "NGN",
        reference,
        metadata: {
          invoiceId: invoice.id,
          businessId: business.id,
          expectedAmount: amount,
          expectedCurrency: "NGN"
        }
      };

      const callbackBase = PUBLIC_BASE_URL || `${url.protocol}//${req.headers.host}`;
      payload.callback_url = `${callbackBase}/#pay/${encodeURIComponent(invoice.id)}`;

      const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      writeJson(res, paystackResponse.status, await paystackResponse.json());
      return;
    }

    if (url.pathname === "/paystack/verify" && req.method === "GET") {
      requireSecret();
      const reference = url.searchParams.get("reference");
      if (!reference) {
        writeJson(res, 400, { error: "Missing transaction reference." });
        return;
      }
      const data = await verifyPaystack(reference);
      if (data.status && data.data?.status === "success") {
        const result = markInvoicePaidFromTransaction(data.data);
        if (!result.ok) {
          writeJson(res, 422, { error: result.error, paystack: data });
          return;
        }
      }
      writeJson(res, 200, data);
      return;
    }

    if (url.pathname === "/paystack/webhook" && req.method === "POST") {
      requireSecret();
      const rawBody = await readRaw(req);
      const signature = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
      if (signature !== req.headers["x-paystack-signature"]) {
        writeJson(res, 401, { error: "Invalid webhook signature." });
        return;
      }
      const event = JSON.parse(rawBody);
      if (event.event === "charge.success") {
        const result = markInvoicePaidFromTransaction(event.data);
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

server.listen(PORT, () => {
  console.log(`LedgerLink running at http://localhost:${PORT}`);
  if (!PAYSTACK_SECRET_KEY) console.log("Paystack is in demo mode until PAYSTACK_SECRET_KEY is set.");
  if (PUBLIC_BASE_URL) console.log(`Public webhook/callback base URL: ${PUBLIC_BASE_URL}`);
});

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    writeDb(emptyDb({ settings: seedSettings, invoices: seedInvoices }));
    return;
  }
  writeDb(readDb());
}

function readDb() {
  return migrateDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(sanitizeDb(data), null, 2));
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
    settings: sanitizeSettings(business.settings || {})
  }));
  db.invoices = db.invoices.map(invoice => sanitizeInvoice(invoice));
  return db;
}

function claimInitialState(db) {
  if (db.orphanState) return db.orphanState;
  return { settings: seedSettings, invoices: seedInvoices };
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

function sessionPayload(user, db = readDb()) {
  return {
    authenticated: true,
    user: { id: user.id, name: user.name, email: user.email },
    state: getStateForUser(db, user)
  };
}

function getUserFromRequest(req) {
  const db = readDb();
  const sessionId = getCookie(req, SESSION_COOKIE);
  const session = db.sessions.find(item => item.id === sessionId && new Date(item.expiresAt) > new Date());
  return session ? db.users.find(user => user.id === session.userId) : null;
}

function requireUser(req, res) {
  const db = readDb();
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
    business = { id: newId("biz"), ownerUserId: user.id, settings: sanitizeSettings({ ...seedSettings, ownerEmail: user.email }) };
    db.businesses.push(business);
  }
  return business;
}

function getStateForUser(db, user) {
  const business = getBusinessForUser(db, user);
  return {
    settings: business.settings,
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

function sanitizeInvoice(invoice) {
  return {
    id: String(invoice.id || ""),
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

async function verifyPaystack(reference) {
  const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
  });
  return paystackResponse.json();
}

function markInvoicePaidFromTransaction(transaction) {
  const invoiceId = transaction?.metadata?.invoiceId;
  const db = readDb();
  const invoice = db.invoices.find(item => item.id === invoiceId);
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
  writeDb(db);
  return { ok: true };
}

function nextInvoiceId(invoices) {
  const max = invoices.reduce((num, invoice) => Math.max(num, Number(String(invoice.id).replace(/\D/g, "")) || 1000), 1000);
  return `INV-${max + 1}`;
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

function requireSecret() {
  if (!PAYSTACK_SECRET_KEY) {
    const error = new Error("PAYSTACK_SECRET_KEY is not configured.");
    error.statusCode = 500;
    throw error;
  }
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
