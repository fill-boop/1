// Minimal Gradio client that runs in the visitor's browser.
// Every request goes from the visitor's browser straight to the Space, so the
// Space sees the visitor's own IP and uses the visitor's own ZeroGPU quota.

const HF_API = "https://huggingface.co/api/spaces";

export class GenError extends Error {
  // kind: "quota" | "busy" | "down" | "input" | "lost" | "cancelled" | "unknown"
  constructor(kind, message, detail = "") {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

export function classifyError(text) {
  const t = String(text || "");
  if (/quota|exceeded your .*gpu|gpu .*limit|try again in \d/i.test(t)) return "quota";
  if (/no gpu was available|queue is full|queue_full|too many requests|429|busy|timed? ?out/i.test(t)) return "busy";
  if (/upload_failed|failed to fetch|networkerror|50[0-9]|404|not running|sleeping|paused|runtime_error|building/i.test(t)) return "down";
  return "unknown";
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const outer = opts.signal;
  if (outer) outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Ask the Hugging Face API whether a Space is running, and get its real subdomain.
export async function spaceStatus(spaceId) {
  try {
    const r = await fetchWithTimeout(`${HF_API}/${spaceId}`, {}, 15000);
    if (!r.ok) return { stage: `HTTP_${r.status}`, url: null };
    const d = await r.json();
    return {
      stage: d.runtime?.stage || "UNKNOWN",
      hardware: d.runtime?.hardware?.current || null,
      url: d.subdomain ? `https://${d.subdomain}.hf.space` : null,
    };
  } catch (e) {
    return { stage: "UNREACHABLE", url: null };
  }
}

// Load a Space's Gradio config (components + endpoints).
export async function loadSpace(spaceId) {
  const status = await spaceStatus(spaceId);
  if (status.stage !== "RUNNING" || !status.url) {
    throw new GenError("down", `${spaceId} is not running (${status.stage}).`);
  }
  const r = await fetchWithTimeout(`${status.url}/config`, {}, 25000);
  if (!r.ok) throw new GenError("down", `${spaceId} config failed (HTTP ${r.status}).`);
  const config = await r.json();
  const prefix = Number(String(config.version || "4").split(".")[0]) >= 5 ? "/gradio_api" : "";
  return { spaceId, url: status.url, config, prefix, hardware: status.hardware };
}

// Find an endpoint by api_name and return its function index and input components.
export function getEndpoint(space, apiName) {
  const deps = space.config.dependencies || [];
  const idx = deps.findIndex((d) => d.api_name === apiName);
  if (idx < 0) throw new GenError("down", `${space.spaceId} has no endpoint "${apiName}".`);
  const dep = deps[idx];
  const byId = new Map((space.config.components || []).map((c) => [c.id, c]));
  const inputs = (dep.inputs || []).map((id) => {
    const c = byId.get(id) || { id, type: "unknown", props: {} };
    return { id, type: c.type, props: c.props || {} };
  });
  return { fnIndex: dep.id ?? idx, triggerId: dep.targets?.[0]?.[0] ?? null, inputs };
}

export async function uploadFile(space, file, signal) {
  const form = new FormData();
  form.append("files", file);
  let r;
  try {
    r = await fetchWithTimeout(`${space.url}${space.prefix}/upload`, { method: "POST", body: form, signal }, 120000);
  } catch (e) {
    if (signal?.aborted) throw new GenError("cancelled", "Cancelled.");
    throw new GenError("down", "Upload failed: could not reach the Space.");
  }
  if (!r.ok) throw new GenError(r.status === 429 ? "busy" : "down", `Upload failed (HTTP ${r.status}).`);
  const payload = await r.json();
  const path = Array.isArray(payload) ? payload[0] : payload?.files?.[0];
  if (!path) throw new GenError("down", "Upload returned no file path.");
  return {
    path,
    url: `${space.url}${space.prefix}/file=${path}`,
    orig_name: file.name,
    size: file.size,
    mime_type: file.type,
    meta: { _type: "gradio.FileData" },
  };
}

export function newSessionHash() {
  return Math.random().toString(36).slice(2, 13);
}

export async function joinQueue(space, ep, data, sessionHash, signal) {
  let r;
  try {
    r = await fetchWithTimeout(
      `${space.url}${space.prefix}/queue/join`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data,
          event_data: null,
          fn_index: ep.fnIndex,
          trigger_id: ep.triggerId,
          session_hash: sessionHash,
        }),
        signal,
      },
      60000
    );
  } catch (e) {
    if (signal?.aborted) throw new GenError("cancelled", "Cancelled.");
    throw new GenError("down", "Could not reach the Space to start the job.");
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const kind = r.status === 429 ? "busy" : classifyError(body) === "quota" ? "quota" : "down";
    throw new GenError(kind, `Space refused the job (HTTP ${r.status}).`, body.slice(0, 300));
  }
  const j = await r.json();
  if (!j.event_id) throw new GenError("down", "Space did not return a job id.");
  return j.event_id;
}

// Read the server-sent event stream until the job completes.
// onMessage receives every queue message (estimation, progress, ...).
// Resolves with the output data array.
export async function readStream(space, sessionHash, eventId, signal, onMessage) {
  let r;
  try {
    r = await fetch(`${space.url}${space.prefix}/queue/data?session_hash=${encodeURIComponent(sessionHash)}`, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new GenError("cancelled", "Cancelled.");
    throw new GenError("lost", "Lost connection to the Space.");
  }
  if (r.status === 404) throw new GenError("lost", "The Space no longer knows this job.");
  if (!r.ok || !r.body) throw new GenError("lost", `Stream failed (HTTP ${r.status}).`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event_id && eventId && msg.event_id !== eventId) continue;
        onMessage?.(msg);
        if (msg.msg === "process_completed") {
          if (msg.success === false || msg.output?.error) {
            const errText = msg.output?.error || msg.title || "The model failed.";
            const kind = classifyError(errText);
            throw new GenError(kind === "unknown" ? "busy" : kind, errText);
          }
          return msg.output?.data || [];
        }
        if (msg.msg === "queue_full") throw new GenError("busy", "The Space queue is full.");
        if (msg.msg === "unexpected_error") throw new GenError(classifyError(msg.message) || "down", msg.message || "Unexpected error.");
        if (msg.msg === "close_stream") throw new GenError("lost", "The Space closed the stream before finishing.");
      }
    }
  } catch (e) {
    if (e instanceof GenError) throw e;
    if (signal?.aborted) throw new GenError("cancelled", "Cancelled.");
    throw new GenError("lost", "Lost connection while waiting for the video.");
  }
  throw new GenError("lost", "The stream ended without a result.");
}

// Pull the first playable video URL out of a Gradio output array.
export function findVideoUrl(space, outputs) {
  const toUrl = (v) => {
    if (!v) return null;
    if (typeof v === "string") {
      if (/^https?:/.test(v)) return v;
      return `${space.url}${space.prefix}/file=${v}`;
    }
    if (v.video) return toUrl(v.video);
    if (v.url) return v.url;
    if (v.path) return `${space.url}${space.prefix}/file=${v.path}`;
    if (v.value) return toUrl(v.value);
    return null;
  };
  for (const o of outputs) {
    const u = toUrl(o);
    if (u && !/\.(png|jpe?g|webp)(\?|$)/i.test(u)) return u;
  }
  return null;
}
