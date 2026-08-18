import { buildPushPayload } from "@block65/webcrypto-web-push";

const SYNC_STALE_DAYS = 14;
const SYNC_EXPIRE_DAYS = 60;
const MAX_HANDOVERS_PER_SYNC = 90;
const MAX_NOTE_LENGTH = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (origin === env.CLIENT_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isValidSubscription(subscription) {
  return (
    subscription &&
    typeof subscription.endpoint === "string" &&
    subscription.endpoint.startsWith("https://") &&
    subscription.keys &&
    typeof subscription.keys.p256dh === "string" &&
    typeof subscription.keys.auth === "string"
  );
}

function sanitizeHandovers(handovers) {
  if (!Array.isArray(handovers)) return [];
  return handovers
    .filter(
      (h) =>
        h &&
        typeof h.date === "string" &&
        DATE_RE.test(h.date) &&
        typeof h.toOwnerName === "string" &&
        h.toOwnerName.trim().length > 0
    )
    .slice(0, MAX_HANDOVERS_PER_SYNC)
    .map((h) => ({
      date: h.date,
      toOwnerName: h.toOwnerName,
      ...(typeof h.note === "string" && h.note.trim() ? { note: h.note.trim().slice(0, MAX_NOTE_LENGTH) } : {}),
    }));
}

async function handleSubscribe(request, env, corsResponseHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, corsResponseHeaders);
  }
  if (!isValidSubscription(body.subscription)) {
    return json({ error: "invalid_subscription" }, 400, corsResponseHeaders);
  }
  const id = (await sha256Hex(body.subscription.endpoint)).slice(0, 32);
  const key = `sub:${id}`;
  const existingRaw = await env.PUSH_SUBS.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;
  const record = {
    subscription: body.subscription,
    handovers: existing?.handovers ?? [],
    syncedAt: existing?.syncedAt ?? null,
    lastNotifiedSlot: existing?.lastNotifiedSlot ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await env.PUSH_SUBS.put(key, JSON.stringify(record));
  return json({ id }, 200, corsResponseHeaders);
}

async function handleSync(request, env, corsResponseHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, corsResponseHeaders);
  }
  if (typeof body.id !== "string" || !body.id) {
    return json({ error: "invalid_id" }, 400, corsResponseHeaders);
  }
  const key = `sub:${body.id}`;
  const existingRaw = await env.PUSH_SUBS.get(key);
  if (!existingRaw) {
    return json({ error: "unknown_subscription" }, 404, corsResponseHeaders);
  }
  const record = JSON.parse(existingRaw);
  record.handovers = sanitizeHandovers(body.handovers);
  record.syncedAt = new Date().toISOString();
  await env.PUSH_SUBS.put(key, JSON.stringify(record));
  return json({ ok: true }, 200, corsResponseHeaders);
}

export default {
  async fetch(request, env) {
    const corsResponseHeaders = corsHeaders(env, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsResponseHeaders });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/subscribe") {
      return handleSubscribe(request, env, corsResponseHeaders);
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(request, env, corsResponseHeaders);
    }
    return json({ error: "not_found" }, 404, corsResponseHeaders);
  },

  async scheduled(event, env) {
    // Fixed UTC times rather than a Berlin-local check, to stay within the
    // Workers Free plan's 5-cron-per-account cap (see wrangler.toml) — one
    // cron per target instead of two (winter/summer) per target. This lands
    // exactly on 00:00/12:00 Berlin during CET (winter) and drifts an hour
    // to 01:00/13:00 during CEST (summer); acceptable slop for a countdown
    // badge, unlike the old precise-time handover reminder it replaced.
    const now = Date.now();
    const today = todayBerlinDateKey();
    // `event.cron` distinguishes the two daily crons so each gets its own
    // notification slot instead of the second one being skipped as
    // "already notified for that date".
    const slot = `${today}:${event.cron}`;
    let cursor;
    do {
      const page = await env.PUSH_SUBS.list({ prefix: "sub:", cursor });
      for (const { name: key } of page.keys) {
        await processCountdown(key, env, now, today, slot);
      }
      cursor = page.cursor;
    } while (cursor);
  },
};

function berlinTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(byType.year), month: Number(byType.month), day: Number(byType.day) };
}

function todayBerlinDateKey() {
  const { year, month, day } = berlinTodayParts();
  const t = new Date(Date.UTC(year, month - 1, day));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// Both sides are plain "YYYY-MM-DD" date keys (no time component), so this
// diffs the underlying UTC-anchored calendar dates rather than two instants
// — a DST transition between `from` and `to` must not shift the day count.
function daysBetweenDateKeys(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// Shared by every notification kind: loads the subscription, expires/skips
// stale ones, and skips a slot that's already been notified — callers only
// ever differ in what they check on `record.handovers` and what they show.
async function loadEligibleSubscription(key, env, now, slot) {
  const raw = await env.PUSH_SUBS.get(key);
  if (!raw) return null;
  const record = JSON.parse(raw);
  const referenceTime = new Date(record.syncedAt ?? record.createdAt).getTime();
  const ageDays = (now - referenceTime) / 86400000;

  if (ageDays > SYNC_EXPIRE_DAYS) {
    await env.PUSH_SUBS.delete(key);
    return null;
  }
  if (ageDays > SYNC_STALE_DAYS) return null;
  if (record.lastNotifiedSlot === slot) return null;
  return record;
}

async function sendPush(key, env, record, slot, notification) {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const message = {
    data: JSON.stringify(notification),
    options: { ttl: 60 * 60 * 24 },
  };

  try {
    const payload = await buildPushPayload(message, record.subscription, vapid);
    const res = await fetch(record.subscription.endpoint, payload);
    if (res.status === 404 || res.status === 410) {
      await env.PUSH_SUBS.delete(key);
      return;
    }
    if (res.ok) {
      record.lastNotifiedSlot = slot;
      await env.PUSH_SUBS.put(key, JSON.stringify(record));
    }
  } catch (err) {
    console.error("push send failed", key, err);
  }
}

async function processCountdown(key, env, now, today, slot) {
  const record = await loadEligibleSubscription(key, env, now, slot);
  if (!record) return;

  const next = record.handovers.find((h) => h.date >= today);
  if (!next) {
    // Nothing synced within the horizon — clear rather than leave a stale
    // number sitting on the icon from a handover that already happened.
    await sendPush(key, env, record, slot, {
      title: "Kinder Kalender",
      body: "Kein Wechsel in Sicht",
      badge: null,
    });
    return;
  }

  const daysLeft = daysBetweenDateKeys(today, next.date);
  const body =
    daysLeft <= 0
      ? `Heute übernimmt ${next.toOwnerName}`
      : daysLeft === 1
        ? next.note
          ? `Morgen übernimmt ${next.toOwnerName} — "${next.note}"`
          : `Morgen übernimmt ${next.toOwnerName}`
        : `Noch ${daysLeft} Tage, dann übernimmt ${next.toOwnerName}`;
  await sendPush(key, env, record, slot, {
    title: daysLeft <= 1 ? "Übergabe" : "Wechsel-Countdown",
    body,
    badge: daysLeft > 0 ? daysLeft : null,
  });
}
