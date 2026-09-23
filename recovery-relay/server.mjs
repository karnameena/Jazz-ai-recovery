import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.env.PORT || 8788);
const deviceToken = process.env.JAZZ_RECOVERY_DEVICE_TOKEN || "";
const ownerToken = process.env.JAZZ_RECOVERY_OWNER_TOKEN || "";
const expectedDeviceId = process.env.JAZZ_RECOVERY_DEVICE_ID || "";
const maxClockSkewMs = Number(process.env.JAZZ_RECOVERY_MAX_CLOCK_SKEW_MS || 5 * 60 * 1000);
const onlineWindowMs = Number(process.env.JAZZ_RECOVERY_ONLINE_WINDOW_MS || 90 * 1000);

if (!deviceToken || !ownerToken) {
  console.warn("[Jazz Recovery Relay] JAZZ_RECOVERY_DEVICE_TOKEN and JAZZ_RECOVERY_OWNER_TOKEN must be configured before exposing this service publicly.");
}

const commands = new Map();
const replayNonces = new Map();
let state = {
  deviceId: expectedDeviceId || null,
  deviceName: "Mama Android",
  mode: "NORMAL_MODE",
  lastSeen: null,
  status: null,
  location: null,
  photo: null
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function parseBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve({ raw, json: raw ? JSON.parse(raw) : {} }); }
      catch { reject(new Error("Invalid JSON body")); }
    });
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function cleanupReplayCache(now = Date.now()) {
  for (const [nonce, timestamp] of replayNonces.entries()) {
    if (now - timestamp > maxClockSkewMs * 2) replayNonces.delete(nonce);
  }
}

function verifyDeviceRequest(req, pathname, bodyRaw) {
  if (!deviceToken) return { ok: false, status: 503, error: "Recovery relay device authentication is not configured" };
  const auth = req.headers.authorization || "";
  const deviceId = String(req.headers["x-jazz-device-id"] || "");
  const timestamp = String(req.headers["x-jazz-timestamp"] || "");
  const nonce = String(req.headers["x-jazz-nonce"] || "");
  const signature = String(req.headers["x-jazz-signature"] || "");

  if (!safeEqual(auth, `Bearer ${deviceToken}`)) return { ok: false, status: 401, error: "Unauthorized device" };
  if (!deviceId || !timestamp || !nonce || !signature) return { ok: false, status: 401, error: "Missing signed device headers" };
  if (expectedDeviceId && deviceId !== expectedDeviceId) return { ok: false, status: 403, error: "Unexpected device identity" };

  const ts = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxClockSkewMs) return { ok: false, status: 401, error: "Stale recovery request" };
  cleanupReplayCache(now);
  if (replayNonces.has(nonce)) return { ok: false, status: 409, error: "Replay detected" };

  const canonical = [timestamp, nonce, String(req.method || "GET").toUpperCase(), pathname, sha256(bodyRaw)].join("\n");
  const expected = hmac(deviceToken, canonical);
  if (!safeEqual(signature, expected)) return { ok: false, status: 401, error: "Invalid recovery request signature" };
  replayNonces.set(nonce, now);
  return { ok: true, deviceId };
}

function verifyOwner(req) {
  if (!ownerToken) return false;
  return safeEqual(req.headers.authorization || "", `Bearer ${ownerToken}`);
}

function queueCommand(type, args = {}) {
  const id = crypto.randomUUID();
  const item = {
    id,
    type,
    args,
    status: "pending",
    createdAt: Date.now(),
    leasedUntil: 0,
    result: null,
    completedAt: null
  };
  commands.set(id, item);
  return item;
}

function nextCommand() {
  const now = Date.now();
  const item = [...commands.values()]
    .filter(command => command.status === "pending" && (!command.leasedUntil || command.leasedUntil < now))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!item) return null;
  item.leasedUntil = now + 30_000;
  return { id: item.id, type: item.type, args: item.args, createdAt: item.createdAt };
}

function updateStateFromResult(command, result) {
  if (!result || typeof result !== "object") return;
  if (command.type === "device_status" && result.status && typeof result.status === "object") {
    state.status = result.status;
    if (result.lastKnownLocation?.ok) state.location = result.lastKnownLocation;
    if (result.mode) state.mode = result.mode;
  }
  if (command.type === "device_location" && result.ok) {
    state.location = result;
    if (result.statusSnapshot) state.status = result.statusSnapshot;
  }
  if (command.type === "set_recovery_mode" && result.mode) state.mode = result.mode;
  if (command.type === "recovery_photo" && result.ok && result.imageBase64) {
    state.photo = {
      ok: true,
      event: result.event || "RECOVERY_PHOTO_CAPTURED",
      deviceId: result.deviceId || state.deviceId,
      deviceName: result.deviceName || state.deviceName,
      camera: result.camera || "front",
      timestamp: result.timestamp || Date.now(),
      mimeType: result.mimeType || "image/jpeg",
      dataUrl: `data:${result.mimeType || "image/jpeg"};base64,${result.imageBase64}`
    };
  }
}

async function waitForResult(id, timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const item = commands.get(id);
    if (item?.status === "done") return item.result;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return null;
}

function publicStatus() {
  const lastSeenMs = state.lastSeen ? new Date(state.lastSeen).getTime() : 0;
  return {
    ok: true,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    online: Boolean(lastSeenMs && Date.now() - lastSeenMs <= onlineWindowMs),
    mode: state.mode,
    lastSeen: state.lastSeen,
    status: state.status,
    locationAvailable: Boolean(state.location?.ok),
    photoAvailable: Boolean(state.photo?.ok),
    lastKnownLocation: state.location ? {
      status: state.location.status,
      latitude: state.location.latitude,
      longitude: state.location.longitude,
      accuracyMeters: state.location.accuracyMeters,
      provider: state.location.provider,
      timestamp: state.location.timestamp
    } : null
  };
}

async function queueAndWait(type, args = {}, timeoutMs = 25_000) {
  const command = queueCommand(type, args);
  const result = await waitForResult(command.id, timeoutMs);
  return result
    ? { ok: result.ok !== false, commandId: command.id, completed: true, result }
    : { ok: true, commandId: command.id, completed: false, status: "QUEUED", message: "Command queued. The phone will execute it when the paired Companion reconnects." };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true, service: "jazz-recovery-relay", version: "0.1.0" });
  }

  try {
    if (pathname === "/android/device/heartbeat" && req.method === "POST") {
      const body = await parseBody(req);
      const auth = verifyDeviceRequest(req, pathname, body.raw);
      if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
      const input = body.json;
      if (input.deviceId && input.deviceId !== auth.deviceId) return json(res, 403, { ok: false, error: "Device identity mismatch" });
      state.deviceId = auth.deviceId;
      state.deviceName = input.deviceName || state.deviceName;
      state.mode = input.mode || state.mode;
      state.status = input.status || state.status;
      if (input.lastKnownLocation?.ok) state.location = input.lastKnownLocation;
      state.lastSeen = new Date().toISOString();
      return json(res, 200, { ok: true, serverTime: Date.now() });
    }

    if (pathname === "/android/device/commands/next" && req.method === "GET") {
      const auth = verifyDeviceRequest(req, pathname, "");
      if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
      const requested = url.searchParams.get("deviceId") || "";
      if (requested && requested !== auth.deviceId) return json(res, 403, { ok: false, error: "Device identity mismatch" });
      state.deviceId = auth.deviceId;
      state.lastSeen = new Date().toISOString();
      return json(res, 200, { ok: true, command: nextCommand() });
    }

    const resultMatch = pathname.match(/^\/android\/device\/commands\/([a-f0-9-]+)\/result$/i);
    if (resultMatch && req.method === "POST") {
      const body = await parseBody(req);
      const auth = verifyDeviceRequest(req, pathname, body.raw);
      if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
      const input = body.json;
      if (input.deviceId && input.deviceId !== auth.deviceId) return json(res, 403, { ok: false, error: "Device identity mismatch" });
      const command = commands.get(resultMatch[1]);
      if (!command) return json(res, 404, { ok: false, error: "Unknown recovery command" });
      command.status = "done";
      command.result = input.result || {};
      command.completedAt = Date.now();
      updateStateFromResult(command, command.result);
      state.lastSeen = new Date().toISOString();
      return json(res, 200, { ok: true });
    }

    if (!verifyOwner(req)) {
      return json(res, 401, { ok: false, error: "Owner authorization required" });
    }

    if (req.method === "GET" && pathname === "/android/device/status") {
      return json(res, 200, publicStatus());
    }

    if (req.method === "POST" && pathname === "/android/device/refresh") {
      return json(res, 200, await queueAndWait("device_status", {}));
    }

    if (req.method === "GET" && pathname === "/android/device/location") {
      const response = await queueAndWait("device_location", {});
      if (response.completed && response.result?.ok) state.location = response.result;
      return json(res, 200, response.completed ? response : { ...response, lastKnownLocation: state.location });
    }

    if (req.method === "POST" && pathname === "/android/device/ring") {
      const body = await parseBody(req);
      return json(res, 200, await queueAndWait("ring_device", { durationMs: Number(body.json.durationMs || 30_000) }));
    }

    if (req.method === "POST" && pathname === "/android/device/recovery-mode") {
      const body = await parseBody(req);
      return json(res, 200, await queueAndWait("set_recovery_mode", { enabled: body.json.enabled !== false }));
    }

    if (req.method === "POST" && pathname === "/android/device/camera") {
      const body = await parseBody(req);
      const camera = body.json.camera === "rear" ? "rear" : "front";
      const response = await queueAndWait("recovery_photo", { camera }, 30_000);
      return json(res, 200, response);
    }

    if (req.method === "GET" && pathname === "/android/device/recovery-photo") {
      return json(res, 200, state.photo || { ok: false, status: "NO_RECOVERY_PHOTO" });
    }

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[Jazz Recovery Relay] listening on :${port}`);
  console.log(`[Jazz Recovery Relay] device auth=${deviceToken ? "configured" : "MISSING"}, owner auth=${ownerToken ? "configured" : "MISSING"}`);
});
