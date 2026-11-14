/**
 * 灰烬笔记 · 边缘函数
 * 部署在阿里云 ESA Pages，负责密文存取与自毁
 * 服务端只接触密文，明文与密钥永不离开浏览器
 */

const NS = "ashnote";            // Edge KV 存储空间名称，需与控制台一致
const MAX_CT_LEN = 200 * 1024;   // 密文最大长度（base64 字符）
const TTL_MIN = 3600;            // 最短有效期 1 小时
const TTL_MAX = 7 * 24 * 3600;   // 最长有效期 7 天
const PASS_GRACE = 600 * 1000;   // 口令模式下，取回密文后的解密宽限期（10 分钟）

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* ---------------- 基础工具 ---------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        "x-robots-tag": "noindex, nofollow",
        "x-content-type-options": "nosniff",
      },
      extraHeaders
    ),
  });
}

function randomString(len) {
  const bytes = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < len; i++) out += B64URL[bytes[i] & 63];
  return out;
}

function store() {
  return new EdgeKV({ namespace: NS });
}

// EdgeKV 偶发瞬时错误（get/put 随机失败），重试即可恢复
async function withRetry(fn, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 80 * (i + 1)));
    }
  }
  throw lastErr;
}

async function readRecord(id) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
  const raw = await withRetry(() => store().get("n:" + id, { type: "text" }));
  if (raw === undefined || raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function writeRecord(id, rec) {
  await withRetry(() => store().put("n:" + id, JSON.stringify(rec)));
}

async function readBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/* ---------------- 业务处理 ---------------- */

async function handleCreate(request) {
  const body = await readBody(request);
  if (!body) return json({ error: "bad_json" }, 400);

  const { ct, iv, mode } = body;
  let ttl = Number(body.ttl) || 86400;

  if (typeof ct !== "string" || typeof iv !== "string" || !ct || !iv) {
    return json({ error: "missing_payload" }, 400);
  }
  if (ct.length > MAX_CT_LEN) {
    return json({ error: "too_large", limit: MAX_CT_LEN }, 413);
  }
  if (mode !== "link" && mode !== "pass") {
    return json({ error: "bad_mode" }, 400);
  }
  ttl = Math.min(Math.max(ttl, TTL_MIN), TTL_MAX);

  const id = randomString(12);
  const mgmt = randomString(24);
  const now = Date.now();

  const rec = {
    v: 1,
    mode,
    ct,
    iv,
    mgmt,
    state: "unread",
    createdAt: now,
    expiresAt: now + ttl * 1000,
    readAt: null,
  };

  await writeRecord(id, rec);
  await bumpStats(1);

  return json({
    id,
    mgmt,
    expiresAt: rec.expiresAt,
    ttl,
  });
}

// 边缘节点本地熔断标记：EdgeKV 读命中节点缓存，焚毁后短时间内可能读到旧副本。
// 用 Cache API 在同节点记一份状态，读取时先查它，堵住二次读取窗口。
function burnKey(id) {
  return "http://ashnote.local/burned/" + id;
}

async function localState(id) {
  if (typeof cache === "undefined" || !cache) return null;
  try {
    const r = await cache.get(burnKey(id));
    if (!r) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function markLocalState(id, state) {
  if (typeof cache === "undefined" || !cache) return;
  try {
    await cache.put(
      burnKey(id),
      new Response(JSON.stringify({ state, at: Date.now() }), {
        headers: [["cache-control", "max-age=86400"]],
      })
    );
  } catch {
    // 标记失败不影响主流程
  }
}

async function handleRead(request) {
  const body = await readBody(request);
  if (!body || !body.id) return json({ error: "missing_id" }, 400);

  const local = await localState(body.id);
  if (local) {
    let l = null;
    try {
      l = JSON.parse(local);
    } catch {
      l = null;
    }
    if (l && (l.state === "read" || l.state === "burned")) {
      return json({ state: "read", readAt: l.at || null }, 410);
    }
  }

  const rec = await readRecord(body.id);
  if (!rec) return json({ state: "not_found" }, 404);

  // 已焚毁 / 已过期
  if (rec.state === "read" || rec.state === "burned") {
    return json({ state: "read", readAt: rec.readAt || null }, 410);
  }
  if (Date.now() > rec.expiresAt) {
    rec.state = "burned";
    rec.ct = "";
    rec.iv = "";
    await writeRecord(body.id, rec);
    return json({ state: "expired" }, 410);
  }

  const payload = { state: "ok", ct: rec.ct, iv: rec.iv, mode: rec.mode };

  if (rec.mode === "link") {
    // 链接模式：交付即焚，密文立即从存储中抹掉
    rec.state = "read";
    rec.readAt = Date.now();
    rec.ct = "";
    rec.iv = "";
    await writeRecord(body.id, rec);
    await markLocalState(body.id, "read");
    await bumpStats(-1);
  } else {
    // 口令模式：先交付密文，等浏览器解密成功后再调 /api/burn 确认焚毁
    rec.state = "reading";
    rec.graceUntil = Date.now() + PASS_GRACE;
    await writeRecord(body.id, rec);
  }

  return json(payload);
}

async function handleBurn(request) {
  const body = await readBody(request);
  if (!body || !body.id) return json({ error: "missing_id" }, 400);

  const rec = await readRecord(body.id);
  if (!rec) return json({ ok: false, reason: "not_found" }, 404);

  rec.state = "read";
  rec.readAt = Date.now();
  rec.ct = "";
  rec.iv = "";
  await writeRecord(body.id, rec);
  await markLocalState(body.id, "read");
  await bumpStats(-1);

  return json({ ok: true });
}

async function handleStatus(request) {
  const body = await readBody(request);
  if (!body || !body.id || !body.mgmt) return json({ error: "missing_params" }, 400);

  const rec = await readRecord(body.id);
  if (!rec) return json({ state: "not_found" }, 404);
  if (rec.mgmt !== body.mgmt) return json({ error: "forbidden" }, 403);

  // KV 读取可能命中节点缓存，用本地标记校正「已读」状态
  const local = await localState(body.id);
  if (local && rec.state !== "read") {
    let l = null;
    try {
      l = JSON.parse(local);
    } catch {
      l = null;
    }
    if (l && (l.state === "read" || l.state === "burned")) {
      rec.state = "read";
      rec.readAt = rec.readAt || l.at;
    }
  }

  let state = rec.state;
  if (state === "reading") state = "unread";
  if (state !== "read" && Date.now() > rec.expiresAt) state = "expired";

  return json({
    state,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    readAt: rec.readAt,
    mode: rec.mode,
  });
}

async function handleDestroy(request) {
  const body = await readBody(request);
  if (!body || !body.id || !body.mgmt) return json({ error: "missing_params" }, 400);

  const rec = await readRecord(body.id);
  if (!rec) return json({ ok: false, reason: "not_found" }, 404);
  if (rec.mgmt !== body.mgmt) return json({ error: "forbidden" }, 403);

  const wasUnread = rec.state === "unread" || rec.state === "reading";
  rec.state = "read";
  rec.readAt = Date.now();
  rec.ct = "";
  rec.iv = "";
  await writeRecord(body.id, rec);
  await markLocalState(body.id, "read");
  if (wasUnread) await bumpStats(-1);

  return json({ ok: true });
}

/* ---------------- 计数器（用于首页展示） ---------------- */

async function bumpStats(delta) {
  try {
    const kv = store();
    const raw = await withRetry(() => kv.get("stats:total", { type: "text" }));
    const cur = Number(raw) || 0;
    const next = Math.max(0, cur + delta);
    await withRetry(() => kv.put("stats:total", String(next)));
  } catch (e) {
    // 计数失败不影响主流程
  }
}

async function handleStats() {
  let total = 0;
  try {
    const raw = await withRetry(() => store().get("stats:total", { type: "text" }));
    total = Number(raw) || 0;
  } catch (e) {
    total = 0;
  }
  // 允许边缘缓存 30 秒，减少 KV 读取压力
  return json({ total }, 200, { "cache-control": "public, max-age=30" });
}

/* ---------------- 入口 ---------------- */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    try {
      if (path === "/api/create" && request.method === "POST") return await handleCreate(request);
      if (path === "/api/read" && request.method === "POST") return await handleRead(request);
      if (path === "/api/burn" && request.method === "POST") return await handleBurn(request);
      if (path === "/api/status" && request.method === "POST") return await handleStatus(request);
      if (path === "/api/destroy" && request.method === "POST") return await handleDestroy(request);
      if (path === "/api/stats") return await handleStats();
    } catch (e) {
      return json({ error: "server_error", message: String(e) }, 500);
    }

    return json({ error: "not_found" }, 404);
  },
};
