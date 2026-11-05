import { MODELS, MODEL_FALLBACK_ORDER, TASKS } from "./models.js";
import {
  GenError, loadSpace, getEndpoint, uploadFile, newSessionHash,
  joinQueue, readStream, findVideoUrl, spaceStatus, setAuthToken,
} from "./gradio.js";
import { authEnabled, login, logout, handleRedirect, currentUser } from "./auth.js";

const $ = (s) => document.querySelector(s);
const els = {
  taskTabs: $("#taskTabs"),
  model: $("#model"),
  modelInfo: $("#modelInfo"),
  mainFields: $("#mainFields"),
  advFields: $("#advFields"),
  advanced: $("#advanced"),
  allowSwitch: $("#allowSwitch"),
  generate: $("#generate"),
  cancel: $("#cancel"),
  status: $("#status"),
  statusTitle: $("#statusTitle"),
  statusText: $("#statusText"),
  bar: $("#bar"),
  elapsed: $("#elapsed"),
  result: $("#result"),
  video: $("#video"),
  download: $("#download"),
  resultMeta: $("#resultMeta"),
  error: $("#error"),
  log: $("#log"),
};

const JOB_KEY = "vgen.job";
const state = {
  task: "t2v",
  model: null,
  space: null,      // loaded Space for the form
  endpoint: null,
  fields: [],       // [{input, role, read(), control}]
  spaceCache: new Map(),
  health: new Map(),
  ctrl: null,
  startedAt: 0,
  timer: null,
};

// ---------- helpers ----------
function store(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
// IndexedDB keeps the current job's inputs (including image/video files) so a
// page reload can restart it automatically.
function idb(mode, fn) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("vgen", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const tx = req.result.transaction("kv", mode);
        const r = fn(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(r?.result ?? null);
        tx.onerror = () => resolve(null);
      };
    } catch { resolve(null); }
  });
}
const saveJob = (job) => idb("readwrite", (s) => s.put(job, "job"));
const loadJob = () => idb("readonly", (s) => s.get("job"));
const clearJob = () => idb("readwrite", (s) => s.delete("job"));

function plainText(s) {
  const d = document.createElement("div");
  d.innerHTML = String(s || "");
  return d.textContent.trim();
}

function log(text) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  els.log.prepend(li);
}
function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
function endpointName(model, task) {
  return typeof model.endpoint === "string" ? model.endpoint : model.endpoint[task];
}
async function getSpace(spaceId) {
  if (state.spaceCache.has(spaceId)) return state.spaceCache.get(spaceId);
  const s = await loadSpace(spaceId);
  state.spaceCache.set(spaceId, s);
  return s;
}

// What an input "means", so values can move between Spaces with different layouts.
const FILE_TYPES = ["image", "imageeditor", "gallery", "video", "audio", "file"];

function rolesFor(inputs, model) {
  let images = 0;
  return inputs.map((inp) => {
    if (model?.roles?.[inp.id]) return model.roles[inp.id];
    const label = String(inp.props.label || "");
    const fileTypes = (inp.props.file_types || []).join(",");
    if (inp.type === "image" || inp.type === "imageeditor") return ++images === 1 ? "image1" : "image2";
    if (inp.type === "gallery") return "gallery";
    if (inp.type === "video") return "video";
    if (inp.type === "audio" || (inp.type === "file" && /audio/.test(fileTypes))) return "audio";
    if (inp.type === "textbox" && /negative/i.test(label)) return "negative";
    if (inp.type === "textbox" && /prompt/i.test(label)) return "prompt";
    if (/duration/i.test(label)) return "duration";
    if (/^seed$/i.test(label)) return "seed";
    if (/randomi[sz]e/i.test(label)) return "randomize";
    if (/^height/i.test(label)) return "height";
    if (/^width/i.test(label)) return "width";
    return `label:${label || inp.id}`;
  });
}

function overridesFor(model, task) {
  const fixed = { ...(model.fixed || {}), ...((model.fixedByTask || {})[task] || {}) };
  return { hide: new Set([...(model.hide || []), ...Object.keys(fixed)]), fixed };
}

// ---------- negative prompt ----------
// Wan's default negative prompt is in Chinese. Instead of showing it raw, show
// what it means as English checkboxes (all on), and send the Chinese terms.
// Terms marked `extra` aren't in Wan's default; they're added improvements.
const NEG_GROUPS = [
  { label: "Bad color and low quality", terms: ["色调艳丽", "过曝", "整体发灰", "细节模糊不清", "最差质量", "低质量", "JPEG压缩残留"] },
  { label: "Frozen or static video", terms: ["静态", "静止", "静止不动的画面"] },
  { label: "Flicker and jitter", terms: ["画面闪烁", "抖动"], extra: true },
  { label: "Body errors (extra fingers, deformed face or limbs)", terms: ["丑陋的", "残缺的", "多余的手指", "画得不好的手部", "画得不好的脸部", "畸形的", "毁容的", "形态畸形的肢体", "手指融合", "三条腿"] },
  { label: "Subtitles, text and watermarks", terms: ["字幕", "水印", "文字"], extraTerms: ["水印", "文字"] },
  { label: "Painted or stylized look", hint: "Turn off for anime, cartoon or painting styles", terms: ["风格", "作品", "画作", "画面"] },
  { label: "Cluttered background", terms: ["杂乱的背景"] },
  { label: "Crowds in the background", hint: "Turn off if you want a crowd", terms: ["背景人很多"] },
  { label: "Walking backwards", terms: ["倒着走"] },
];

function negativeControl(defaultText, wrap) {
  const base = String(defaultText).split(/[,，]\s*/).map((t) => t.trim()).filter(Boolean);
  const grouped = new Set(NEG_GROUPS.flatMap((g) => g.terms));
  const always = base.filter((t) => !grouped.has(t)); // unknown terms: always keep
  const boxes = [];
  const list = document.createElement("div");
  list.className = "neg-groups";
  for (const g of NEG_GROUPS) {
    const terms = g.terms.filter((t) => base.includes(t) || g.extra || g.extraTerms?.includes(t));
    if (!terms.length) continue;
    const row = document.createElement("label");
    row.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    const text = document.createElement("span");
    text.textContent = g.label;
    row.append(cb, text);
    if (g.hint) {
      const h = document.createElement("small");
      h.className = "note";
      h.textContent = ` · ${g.hint}`;
      row.append(h);
    }
    list.append(row);
    boxes.push({ cb, terms });
  }
  const extra = document.createElement("input");
  extra.type = "text";
  extra.placeholder = "Anything else to avoid, in English (e.g. logo, sunglasses)";
  wrap.append(list, extra);
  return () =>
    [...always, ...boxes.filter((b) => b.cb.checked).flatMap((b) => b.terms), extra.value.trim()]
      .filter(Boolean)
      .join(", ");
}

// ---------- form ----------
function control(inp, role, model) {
  const p = inp.props;
  const override = model.stateFields?.[inp.id];
  const type = override ? override.type : inp.type;
  const props = override ? override : p;
  const label = model.rename?.[inp.id] || model.rename?.[p.label] || props.label || p.label || role;
  const wrap = document.createElement(role === "negative" ? "div" : "label"); // no nested labels
  wrap.className = "field";
  const title = document.createElement("span");
  title.className = "field-label";
  title.textContent = label;
  wrap.append(title);
  let read;

  if (FILE_TYPES.includes(type)) {
    const kind = ["image", "imageeditor", "gallery"].includes(type) ? "image" : type === "video" ? "video" : "audio";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${kind}/*`;
    input.multiple = type === "gallery";
    const preview = document.createElement("div");
    preview.className = "preview";
    input.addEventListener("change", () => {
      preview.replaceChildren();
      for (const f of input.files) {
        const el = document.createElement(kind === "image" ? "img" : kind);
        el.src = URL.createObjectURL(f);
        if (kind !== "image") el.controls = true;
        preview.append(el);
      }
    });
    wrap.classList.add("file");
    if (kind === "audio") {
      const hint = document.createElement("small");
      hint.className = "note";
      hint.textContent = "Upload an audio file (mp3, wav, m4a…). No microphone needed.";
      wrap.append(hint);
    }
    wrap.append(input, preview);
    read = type === "gallery" ? () => (input.files.length ? [...input.files] : null) : () => input.files[0] || null;
  } else if (type === "textbox" && role === "negative" && /[一-鿿]/.test(p.value || "")) {
    title.textContent = "Avoid in the video";
    wrap.classList.add("neg");
    read = negativeControl(p.value, wrap);
  } else if (type === "textbox") {
    const ta = document.createElement("textarea");
    ta.rows = role === "prompt" ? 5 : 2;
    ta.value = role === "prompt" ? "" : p.value ?? "";
    ta.placeholder = role === "prompt" ? (p.value || "Describe the video") : "";
    wrap.append(ta);
    read = () => (role === "prompt" && !ta.value.trim() ? p.value || "" : ta.value);
  } else if (type === "slider" || type === "number") {
    const row = document.createElement("div");
    row.className = "slider";
    const num = document.createElement("input");
    num.type = "number";
    if (props.minimum != null) num.min = props.minimum;
    if (props.maximum != null) num.max = props.maximum;
    num.step = props.step ?? "any";
    num.value = props.value ?? props.minimum ?? 0;
    if (type === "slider" && props.minimum != null && props.maximum != null && props.maximum - props.minimum < 1e6) {
      const range = document.createElement("input");
      range.type = "range";
      range.min = props.minimum; range.max = props.maximum; range.step = props.step ?? "any";
      range.value = num.value;
      range.addEventListener("input", () => (num.value = range.value));
      num.addEventListener("input", () => (range.value = num.value));
      row.append(range);
    }
    row.append(num);
    wrap.append(row);
    read = () => Number(num.value);
  } else if (type === "checkbox") {
    wrap.classList.add("check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!p.value;
    wrap.prepend(cb);
    read = () => cb.checked;
  } else {
    const choices = model.choices?.[inp.id] || model.choices?.[p.label] || p.choices;
    if (!choices) return null; // nothing we can show; default gets sent
    const sel = document.createElement("select");
    const values = choices.map((c) => (Array.isArray(c) ? c[1] : c));
    choices.forEach((c, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = Array.isArray(c) ? c[0] : c;
      if (values[i] === p.value) o.selected = true;
      sel.append(o);
    });
    wrap.append(sel);
    read = () => values[Number(sel.value)];
  }
  return { el: wrap, read };
}

function shouldShow(inp, role, task, hide) {
  if (hide.has(inp.props.label)) return false;
  if (/^(image|video)_[a-z]$/.test(inp.props.label || "")) return false;
  if (task === "t2v" && (role.startsWith("image") || role === "video" || role === "gallery")) return false;
  if ((task === "i2v" || task === "avatar") && role === "video") return false;
  return true;
}

async function buildForm() {
  const model = state.model;
  els.mainFields.replaceChildren(spinnerNote("Loading options from the Space…"));
  els.advFields.replaceChildren();
  els.generate.disabled = true;
  try {
    const space = await getSpace(model.id);
    if (state.model !== model) return;
    const ep = getEndpoint(space, endpointName(model, state.task));
    state.space = space;
    state.endpoint = ep;
    const roles = rolesFor(ep.inputs, model);
    const { hide } = overridesFor(model, state.task);
    els.mainFields.replaceChildren();
    state.fields = [];
    ep.inputs.forEach((inp, i) => {
      const role = roles[i];
      if (inp.type === "state" && !model.stateFields?.[inp.id]) return;
      if (!shouldShow(inp, role, state.task, hide)) return;
      const c = control(inp, role, model);
      if (!c) return;
      state.fields.push({ input: inp, role, read: c.read });
      const main = ["image1", "image2", "gallery", "video", "audio", "prompt"].includes(role);
      (main ? els.mainFields : els.advFields).append(c.el);
    });
    els.advanced.hidden = !els.advFields.children.length;
    els.generate.disabled = !!state.ctrl;
    showHealth(model);
  } catch (e) {
    els.mainFields.replaceChildren(spinnerNote(`Could not load this model: ${e.message}`, true));
    log(`Form load failed for ${model.id}: ${e.message}`);
  }
}

function spinnerNote(text, isError) {
  const p = document.createElement("p");
  p.className = isError ? "note error-text" : "note";
  p.textContent = text;
  return p;
}

// ---------- daily quota per visitor ----------
// The quota is one pool for all ZeroGPU Spaces, but each model reserves a
// different amount of GPU time per video. Spaces refuse a job when its
// reservation is bigger than what's left, e.g. "(112s requested vs. 83s left).
// Try again in 23:46:06". We remember that, so models that can't fit are
// disabled until the quota resets.
const QUOTA_KEY = "vgen.quota";
const quotaOwner = () => currentUser()?.name || "anonymous";

function getQuota() {
  const q = load(QUOTA_KEY);
  if (!q || q.who !== quotaOwner() || Date.now() > q.resetAt) return null;
  return q;
}

function recordQuota(spaceId, message) {
  const q = getQuota() || { who: quotaOwner(), left: null, resetAt: Date.now() + 24 * 3600e3, needs: {}, runsLimitUntil: 0 };
  const m = /\((\d+)s requested vs\.? (\d+)s left\)/.exec(message);
  const t = /try again in (\d+):(\d+):(\d+)/i.exec(message);
  if (m) { q.needs[spaceId] = Number(m[1]); q.left = Number(m[2]); }
  if (t) q.resetAt = Date.now() + (Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) * 1000;
  if (/runs limit/i.test(message)) q.runsLimitUntil = Date.now() + 3600e3; // no reset time given: look again in an hour
  else if (!m) q.left = 0;
  store(QUOTA_KEY, q);
}

function fmtUntil(ts) {
  const min = Math.max(1, Math.round((ts - Date.now()) / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

// Why this model can't run today, or null.
function blockedReason(model) {
  const q = getQuota();
  if (!q) return null;
  if (q.runsLimitUntil > Date.now()) return `run limit reached, try again in ${fmtUntil(q.runsLimitUntil)}`;
  if (q.left !== null && q.left < 20) return `no free time left, resets in ${fmtUntil(q.resetAt)}`;
  const needs = [model.id, ...(model.backups || [])].map((id) => q.needs[id]).filter(Boolean);
  if (needs.length && q.left !== null && Math.min(...needs) > q.left)
    return `needs ${Math.min(...needs)}s, ${q.left}s left today, resets in ${fmtUntil(q.resetAt)}`;
  return null;
}

function optionLabel(m) {
  const h = state.health.get(m.id);
  const b = blockedReason(m);
  return `${m.name}${h && h !== "RUNNING" ? ` (${h.toLowerCase()})` : ""}${b ? ` (${b})` : ""}`;
}

function showHealth(model) {
  const h = state.health.get(model.id);
  const hw = model.gpuSize === "xlarge" ? " · Big GPU: uses your daily free time 2× faster" : "";
  const status = h ? (h === "RUNNING" ? "Online" : h) : "Checking…";
  const b = blockedReason(model);
  els.modelInfo.textContent = `${model.id} · ${status}${hw}${b ? ` · Not available today: ${b}` : ""}`;
}

function renderModels() {
  const prev = state.model?.key;
  els.model.replaceChildren();
  for (const m of MODELS) {
    if (!m.tasks.includes(state.task)) continue;
    const o = document.createElement("option");
    o.value = m.key;
    o.textContent = optionLabel(m);
    o.disabled = !!blockedReason(m);
    els.model.append(o);
  }
  const opts = [...els.model.options];
  const pick = opts.find((o) => o.value === prev && !o.disabled) || opts.find((o) => !o.disabled) || opts[0];
  els.model.value = pick?.value;
  selectModel(els.model.value);
}

// Update labels and disabled state in place (keeps the form and anything typed),
// and move off the selected model if it can no longer run today.
function refreshModelOptions() {
  for (const o of els.model.options) {
    const m = MODELS.find((x) => x.key === o.value);
    o.textContent = optionLabel(m);
    o.disabled = !!blockedReason(m);
  }
  const cur = els.model.selectedOptions[0];
  if (cur?.disabled && !state.ctrl) {
    const next = [...els.model.options].find((o) => !o.disabled);
    if (next) {
      log(`${state.model.name} doesn't fit in today's free GPU time – switched to ${MODELS.find((x) => x.key === next.value).name}.`);
      els.model.value = next.value;
      selectModel(next.value);
      return;
    }
  }
  if (state.model) showHealth(state.model);
}

function selectModel(key) {
  state.model = MODELS.find((m) => m.key === key);
  buildForm();
}

// ---------- collect values ----------
function collectValues() {
  const values = {};
  for (const f of state.fields) values[f.role] = f.read();
  return values;
}

function validate(values) {
  const has = (r) => state.fields.some((f) => f.role === r);
  const t = state.task;
  if (t === "i2v" && has("gallery") && !values.gallery) return "Please add at least one reference image.";
  if ((t === "i2v" || t === "avatar" || t === "animate") && has("image1") && !values.image1) return "Please add an input image.";
  if ((t === "v2v" || t === "animate" || t === "sound") && has("video") && !values.video) return "Please add an input video.";
  if (t === "avatar" && has("audio") && !values.audio) return "Please add an audio file.";
  if (!values.prompt && state.fields.some((f) => f.role === "prompt")) return "Please write a prompt.";
  return null;
}

function clamp(v, p) {
  if (typeof v !== "number" || Number.isNaN(v)) return v;
  if (p.minimum != null) v = Math.max(p.minimum, v);
  if (p.maximum != null) v = Math.min(p.maximum, v);
  return v;
}

// Build the data array for a given Space, mapping values by role.
async function buildData(model, space, ep, values, signal) {
  const roles = rolesFor(ep.inputs, model);
  const { fixed } = overridesFor(model, state.task);
  const uploads = [];
  const data = ep.inputs.map((inp, i) => {
    const role = roles[i];
    const label = inp.props.label;
    if (label in fixed) return fixed[label];
    const sf = model.stateFields?.[inp.id];
    let v = values[role];
    if (sf) return v ?? sf.value;
    if (v === undefined || v === null) {
      if (inp.type === "gallery") return [];
      if (FILE_TYPES.includes(inp.type)) return null;
      return inp.props.value ?? null;
    }
    if (v instanceof File || (Array.isArray(v) && v[0] instanceof File)) {
      uploads.push([i, v]);
      return null;
    }
    if (inp.type === "slider" || inp.type === "number") v = clamp(v, inp.props);
    if ((role === "height" || role === "width") && inp.props.step > 1) v = Math.round(v / inp.props.step) * inp.props.step;
    return v;
  });
  for (const [i, value] of uploads) {
    const type = ep.inputs[i].type;
    const files = Array.isArray(value) ? value : [value];
    const fds = [];
    for (const file of files) {
      setStatus("Uploading", `Sending ${file.name} to ${space.spaceId}…`, 5);
      fds.push(await uploadFile(space, file, signal));
    }
    const fd = fds[0];
    if (type === "gallery") data[i] = fds.map((f) => ({ image: f, caption: null }));
    else if (type === "imageeditor") data[i] = { background: fd, layers: [], composite: fd, id: null };
    else if (type === "video") data[i] = { video: fd, subtitles: null };
    else data[i] = fd;
  }
  return data;
}

// ---------- status UI ----------
function setStatus(title, text, pct) {
  els.status.hidden = false;
  els.statusTitle.textContent = title;
  els.statusText.textContent = text || "";
  if (pct == null) els.bar.classList.add("indeterminate");
  else { els.bar.classList.remove("indeterminate"); els.bar.style.width = `${pct}%`; }
}
function startTimer(from = Date.now()) {
  state.startedAt = from;
  clearInterval(state.timer);
  const tick = () => (els.elapsed.textContent = `Elapsed ${fmt((Date.now() - state.startedAt) / 1000)}`);
  tick();
  state.timer = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(state.timer); }

function onQueueMessage(msg) {
  if (msg.msg === "estimation") {
    const ahead = msg.rank ?? 0;
    const eta = msg.rank_eta ? ` · about ${fmt(msg.rank_eta)} wait` : "";
    setStatus("Waiting in queue", `${ahead} ahead of you${eta}`, 15);
  } else if (msg.msg === "process_starts") {
    setStatus("Starting", msg.eta ? `Waiting for a free GPU · about ${fmt(msg.eta)}` : "Waiting for a free GPU…", 25);
  } else if (msg.msg === "progress" && msg.progress_data?.length) {
    const p = msg.progress_data[0];
    if (p.length) setStatus("Generating", `${p.desc || "Step"} ${p.index}/${p.length}`, 30 + (65 * p.index) / p.length);
    else if (p.progress != null) setStatus("Generating", p.desc || "", 30 + 65 * p.progress);
  }
}

function setBusy(busy) {
  els.generate.disabled = busy;
  els.cancel.hidden = !busy;
  els.model.disabled = busy;
  els.taskTabs.querySelectorAll("button").forEach((b) => (b.disabled = busy));
}

function showError(title, detail) {
  els.error.hidden = false;
  els.error.replaceChildren();
  const h = document.createElement("strong");
  h.textContent = title;
  els.error.append(h);
  if (detail) {
    const p = document.createElement("p");
    p.textContent = detail;
    els.error.append(p);
  }
}

async function showResult(url, model, spaceId, seconds) {
  els.status.hidden = true;
  els.result.hidden = false;
  els.video.src = url;
  els.resultMeta.textContent = `${model?.name || spaceId} · ${spaceId} · took ${fmt(seconds)}`;
  els.download.onclick = async (e) => {
    e.preventDefault();
    els.download.textContent = "Preparing…";
    try {
      const blob = await (await fetch(url)).blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `video-${Date.now()}.mp4`;
      a.click();
    } catch {
      window.open(url, "_blank");
    }
    els.download.textContent = "Download video";
  };
  store("vgen.last", { url, spaceId, modelName: model?.name, at: Date.now() });
}

// ---------- running ----------
function attemptPlan(model, allowSwitch) {
  const plan = [model.id, ...(model.backups || [])].map((id) => ({ model, spaceId: id }));
  if (allowSwitch) {
    for (const key of MODEL_FALLBACK_ORDER[state.task] || []) {
      if (key === model.key) continue;
      const m = MODELS.find((x) => x.key === key);
      if (m) plan.push({ model: m, spaceId: m.id });
    }
  }
  return plan;
}

async function runOnce(model, spaceId, values, signal) {
  const space = await getSpace(spaceId);
  const ep = getEndpoint(space, endpointName(model, state.task));
  const data = await buildData(model, space, ep, values, signal);
  const session = newSessionHash();
  setStatus("Joining queue", spaceId, 10);
  const eventId = await joinQueue(space, ep, data, session, signal);
  return await streamWithReconnect(space, session, eventId, signal);
}

// If the connection drops, reconnect to the same job instead of starting over.
async function streamWithReconnect(space, session, eventId, signal) {
  for (let tries = 0; ; tries++) {
    try {
      return await readStream(space, session, eventId, signal, onQueueMessage);
    } catch (e) {
      if (e.kind !== "lost" || tries >= 2) throw e;
      log(`Connection dropped, reconnecting (${tries + 1}/2)…`);
      setStatus("Reconnecting", "Connection dropped, rejoining your job…", null);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function generate(restored = null) {
  els.error.hidden = true;
  els.result.hidden = true;
  const values = restored ? restored.values : collectValues();
  if (!restored) {
    const problem = validate(values);
    if (problem) return showError(problem);
  }

  const ctrl = new AbortController();
  state.ctrl = ctrl;
  setBusy(true);
  startTimer(restored ? restored.startedAt : Date.now());
  await saveJob({ task: state.task, modelKey: state.model.key, values, startedAt: state.startedAt, allowSwitch: els.allowSwitch.checked });
  state.quotaLeft = 0;
  const plan = attemptPlan(state.model, els.allowSwitch.checked);
  let lastErr = null;
  let skippedForQuota = null;

  try {
    for (const step of plan) {
      if (step.model !== state.model) {
        log(`Switching model to ${step.model.name}`);
      }
      const h = state.health.get(step.spaceId);
      if (h && h !== "RUNNING") { log(`Skipping ${step.spaceId}: ${h}`); continue; }
      const blocked = blockedReason(step.model);
      if (blocked) { skippedForQuota = blocked; log(`Skipping ${step.model.name}: ${blocked}`); continue; }
      for (let retry = 0; retry < 2; retry++) {
        try {
          log(`Trying ${step.spaceId}${retry ? " (retry)" : ""}`);
          const out = await runOnce(step.model, step.spaceId, values, ctrl.signal);
          const space = await getSpace(step.spaceId);
          const url = findVideoUrl(space, out);
          if (!url) throw new GenError("unknown", "The Space finished but returned no video.");
          log(`Done on ${step.spaceId}`);
          await showResult(url, step.model, step.spaceId, (Date.now() - state.startedAt) / 1000);
          return;
        } catch (e) {
          e.message = plainText(e.message);
          lastErr = e;
          log(`${step.spaceId}: ${e.kind || "error"} – ${e.message}`);
          if (!(e instanceof GenError) || e.kind === "cancelled" || e.kind === "nogpu") throw e; // bugs shouldn't trigger model switching
          if (e.kind === "quota") {
            recordQuota(step.spaceId, e.message);
            // Quota is shared by every ZeroGPU Space. But the check is "reserved vs left",
            // so a lighter model may still fit in what's left.
            const m = /\((\d+)s requested vs\.? (\d+)s left\)/.exec(e.message);
            const left = m ? Number(m[2]) : 0;
            if (left < 20) throw e;
            state.quotaLeft = left;
            log(`Only ${left}s of free GPU time left today – trying a lighter model.`);
            break;
          }
          // "No GPU was available after 60s" still uses up the visitor's quota, and the
          // GPU pool is shared by every ZeroGPU Space, so retrying or switching only burns
          // more free time. Stop and let the visitor decide.
          if (e.kind === "busy" && /no gpu was available/i.test(e.message)) throw new GenError("nogpu", e.message);
          if ((e.kind === "busy" || e.kind === "lost") && retry === 0) {
            setStatus("Retrying", e.kind === "busy" ? "The Space is busy, retrying in a few seconds…" : "Connection dropped, starting the job again…", null);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          break; // move to next Space
        }
      }
    }
    if (state.quotaLeft) {
      const left = state.quotaLeft;
      state.quotaLeft = 0;
      throw new GenError("quota", `Only ${left}s of free GPU time is left today, which isn't enough for any available model. Try a shorter video or smaller size.`);
    }
    if (!lastErr && skippedForQuota) throw new GenError("quota", `No model fits in what's left today (${skippedForQuota}).`);
    throw lastErr || new GenError("down", "No model was available.");
  } catch (e) {
    els.status.hidden = true;
    if (e.kind === "cancelled") showError("Cancelled.");
    else if (e.kind === "quota")
      showError(
        "You've used today's free GPU time.",
        `Hugging Face gives each visitor a small free daily GPU allowance, shared across all these models, so switching models won't help. ` +
        `It resets 24 hours after your first use today. Details from the Space: ${e.message}` +
        (authEnabled() && !currentUser() ? SIGN_IN_HINT : "")
      );
    else if (e.kind === "nogpu")
      showError(
        "Hugging Face had no free GPU for you within 60 seconds.",
        "Visitors who aren't signed in to Hugging Face get the lowest priority. This wait still counted against today's free GPU time, " +
        "so the page didn't retry automatically. Try again in a few minutes, or use a shorter video." +
        (authEnabled() && !currentUser() ? SIGN_IN_HINT : "")
      );
    else showError("Couldn't generate the video.", `${e.message}${e.detail ? " – " + e.detail : ""}`);
  } finally {
    await clearJob();
    stopTimer();
    setBusy(false);
    state.ctrl = null;
    refreshModelOptions();
  }
}

// Gradio drops a job as soon as the browser that started it goes away, so a
// reloaded page can't rejoin it. Instead, restart it with the saved inputs.
async function resumeJob() {
  const job = await loadJob();
  if (!job || Date.now() - job.startedAt > 20 * 60 * 1000) { await clearJob(); return showLast(); }
  const model = MODELS.find((m) => m.key === job.modelKey);
  if (!model) { await clearJob(); return; }
  log("The page was reloaded during a job – restarting it automatically.");
  state.task = job.task;
  els.taskTabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.task === job.task)));
  els.allowSwitch.checked = job.allowSwitch !== false;
  state.model = model;
  renderModels();
  setStatus("Restarting", "The page reloaded, so your video is being started again…", null);
  await generate({ values: job.values, startedAt: Date.now() });
}

function showLast() {
  const last = load("vgen.last");
  if (last && Date.now() - last.at < 60 * 60 * 1000) {
    els.result.hidden = false;
    els.video.src = last.url;
    els.resultMeta.textContent = `Your last video · ${last.modelName || last.spaceId} (link expires soon, download it)`;
    els.download.onclick = () => window.open(last.url, "_blank");
  }
}

async function checkHealth() {
  const ids = new Set(MODELS.flatMap((m) => [m.id, ...(m.backups || [])]));
  await Promise.all([...ids].map(async (id) => {
    const s = await spaceStatus(id);
    state.health.set(id, s.stage);
  }));
  const down = [...state.health].filter(([, s]) => s !== "RUNNING").map(([id, s]) => `${id} (${s})`);
  if (down.length) log(`Unavailable right now: ${down.join(", ")}`);
  refreshModelOptions();
}

// ---------- wire up ----------
els.taskTabs.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-task]");
  if (!b || state.ctrl) return;
  state.task = b.dataset.task;
  els.taskTabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  renderModels();
});
els.model.addEventListener("change", () => selectModel(els.model.value));
els.generate.addEventListener("click", () => generate());
els.cancel.addEventListener("click", () => state.ctrl?.abort());

// ---------- account ----------
const SIGN_IN_HINT = " Signing in with a free Hugging Face account gives you 5 minutes a day (instead of 2) and a better place in the queue.";

function renderAccount() {
  const user = authEnabled() ? currentUser() : null;
  setAuthToken(user?.token);
  $("#account").hidden = !authEnabled();
  $("#signIn").hidden = !!user;
  $("#user").hidden = !user;
  const note = $("#tierNote");
  if (user) {
    $("#userName").textContent = user.name;
    if (user.avatar) $("#userAvatar").src = user.avatar; else $("#userAvatar").removeAttribute("src");
    note.textContent = user.isPro
      ? "Signed in with PRO: about 40 minutes of GPU time a day, top queue priority."
      : "Signed in: about 5 minutes of GPU time a day and a better queue position. Uses your own Hugging Face quota.";
  } else {
    note.textContent = "Not signed in: about 2 minutes of GPU time a day and the lowest queue priority." + (authEnabled() ? " Sign in for more." : "");
  }
  note.hidden = false;
}

$("#signIn").addEventListener("click", () => login());
$("#signOut").addEventListener("click", () => { logout(); renderAccount(); refreshModelOptions(); });

function renderTabs() {
  els.taskTabs.replaceChildren(...TASKS.map((t) => {
    const b = document.createElement("button");
    b.dataset.task = t.key;
    b.textContent = t.label;
    b.setAttribute("aria-selected", String(t.key === state.task));
    return b;
  }));
}

async function start() {
  renderTabs();
  const authError = authEnabled() ? await handleRedirect() : null;
  renderAccount();
  if (authError) showError(authError);
  renderModels();
  checkHealth();
  resumeJob();
}
start();
