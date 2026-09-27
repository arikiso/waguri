// Waguri — standalone chat app (vanilla JS)
// Storage: IndexedDB (primary) + localStorage mirror (fallback / legacy migration)
// Sync: BroadcastChannel for instant cross-tab/window updates

const API_URL = (() => {
  const override = window.WAGURI_API_URL || window.HACKMYSENPAI_API_URL;
  return override || "https://hack-your-senpai.lovable.app/api/public/senpai-chat";
})();

const STORAGE_KEY = "waguri.threads.v1";
const ACTIVE_KEY = "waguri.active.v1";
const THEME_KEY = "waguri.theme.v1";
const LEGACY_STORAGE = "hackmysenpai.threads.v1";
const LEGACY_ACTIVE = "hackmysenpai.active.v1";

const TAB_ID = "tab_" + Math.random().toString(36).slice(2, 10);

// ---------- IndexedDB ----------
const DB_NAME = "waguri-db";
const DB_STORE = "kv";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// localStorage mirror (fallback + resilience on mobile)
function lsGetThreads() {
  try {
    const cur = localStorage.getItem(STORAGE_KEY);
    if (cur) return JSON.parse(cur);
    const legacy = localStorage.getItem(LEGACY_STORAGE);
    if (legacy) return JSON.parse(legacy);
  } catch {}
  return [];
}
function lsSet(threadsVal, activeVal) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threadsVal));
    if (activeVal) localStorage.setItem(ACTIVE_KEY, activeVal);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

// ---------- state ----------
let threads = [];
let activeId = null;
let sending = false;
let saveTimer = null;

function currentThread() { return threads.find((t) => t.id === activeId) || null; }
function stamp(list) { return list.reduce((n, t) => Math.max(n, t.updatedAt || 0), 0); }

async function loadAll() {
  let idbThreads = null, idbActive = null;
  try {
    idbThreads = await idbGet("threads");
    idbActive = await idbGet("active");
  } catch {}
  const lsThreads = lsGetThreads();
  // Prefer whichever store holds the newer data (mobile browsers can evict either).
  if (Array.isArray(idbThreads) && (!lsThreads.length || stamp(idbThreads) >= stamp(lsThreads))) {
    threads = idbThreads;
  } else {
    threads = lsThreads;
  }
  activeId = idbActive || (() => { try { return localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(LEGACY_ACTIVE); } catch { return null; } })();
  if (activeId && !threads.find((t) => t.id === activeId)) activeId = null;
  // Write back so both stores converge.
  await persist({ broadcast: false });
}

async function persist({ broadcast = true } = {}) {
  lsSet(threads, activeId);
  try {
    await idbSet("threads", threads);
    await idbSet("active", activeId);
  } catch {}
  if (broadcast) postSync();
}

// Debounced persist for hot paths (streaming)
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 600);
}

// ---------- BroadcastChannel sync ----------
const channel = ("BroadcastChannel" in window) ? new BroadcastChannel("waguri-sync") : null;

function postSync() {
  if (!channel) return;
  try {
    channel.postMessage({ type: "threads", from: TAB_ID, threads, activeId, at: Date.now() });
  } catch {}
}

if (channel) {
  channel.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.from === TAB_ID) return;
    if (msg.type === "theme") { applyTheme(msg.theme); return; }
    if (msg.type !== "threads" || !Array.isArray(msg.threads)) return;
    if (sending) {
      // Don't clobber a live stream — merge everything except the active thread.
      const mine = currentThread();
      threads = msg.threads.map((t) => (mine && t.id === mine.id ? mine : t));
      if (mine && !threads.find((t) => t.id === mine.id)) threads.unshift(mine);
      renderThreads();
      return;
    }
    threads = msg.threads;
    if (msg.activeId && threads.find((t) => t.id === msg.activeId)) activeId = msg.activeId;
    if (activeId && !threads.find((t) => t.id === activeId)) activeId = threads[0]?.id || null;
    renderThreads();
    renderMessages();
  };
}

async function reloadFromStore() {
  if (sending) return;
  await loadAll();
  renderThreads();
  renderMessages();
}

// ---------- DOM ----------
const sidebar = document.getElementById("sidebar");
const backdrop = document.getElementById("backdrop");
const threadsList = document.getElementById("threadsList");
const messagesEl = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const form = document.getElementById("composer");
const newBtn = document.getElementById("newThreadBtn");
const menuBtn = document.getElementById("menuBtn");
const modelPicker = document.querySelector(".model-picker");
const modelSelect = document.getElementById("modelSelect");
const modelLabel = document.getElementById("modelLabel");
const toastEl = document.getElementById("toast");

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

function openSidebarMobile() { sidebar.classList.add("open"); backdrop.classList.add("show"); menuBtn.setAttribute("aria-expanded", "true"); }
function closeSidebarMobile() { sidebar.classList.remove("open"); backdrop.classList.remove("show"); menuBtn.setAttribute("aria-expanded", "false"); }

newBtn.addEventListener("click", () => newThread());
menuBtn.addEventListener("click", () => {
  sidebar.classList.contains("open") ? closeSidebarMobile() : openSidebarMobile();
});
backdrop.addEventListener("click", closeSidebarMobile);

// Close the mobile drawer when the layout becomes desktop, so its backdrop can
// never stay stuck over the app after a rotation or resize.
const desktopQuery = window.matchMedia("(min-width: 821px)");
function syncLayout() { if (desktopQuery.matches) closeSidebarMobile(); }
if (desktopQuery.addEventListener) desktopQuery.addEventListener("change", syncLayout);
else if (desktopQuery.addListener) desktopQuery.addListener(syncLayout);
window.addEventListener("orientationchange", () => setTimeout(syncLayout, 120));
syncLayout();

// Touch keyboards send Enter as a newline key; only send on Enter with a real keyboard.
const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !isTouch) { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (sending) { stopGenerating(); return; }
  send();
});

document.addEventListener("click", (e) => {
  const chip = e.target.closest?.(".chip");
  if (chip) { input.value = chip.textContent.trim(); autosize(); input.focus(); }
});

// ---------- threads ----------
function newThread() {
  const t = { id: "t_" + Math.random().toString(36).slice(2, 10), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  threads.unshift(t);
  activeId = t.id;
  persist();
  renderThreads(); renderMessages();
  closeSidebarMobile();
  input.focus();
  return t;
}
function deleteThread(id) {
  threads = threads.filter((t) => t.id !== id);
  if (activeId === id) activeId = threads[0]?.id || null;
  persist();
  renderThreads(); renderMessages();
}
function selectThread(id) {
  activeId = id;
  persist();
  renderThreads(); renderMessages();
  closeSidebarMobile();
}

// ---------- rendering ----------
function renderThreads() {
  threadsList.innerHTML = "";
  if (!threads.length) {
    threadsList.innerHTML = `<div style="color:var(--text-mute);font-size:12px;padding:8px 12px;">No conversations yet.</div>`;
    return;
  }
  for (const t of threads) {
    const el = document.createElement("div");
    el.className = "thread-item" + (t.id === activeId ? " active" : "");
    el.setAttribute("role", "listitem");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `Open chat: ${t.title}`);
    if (t.id === activeId) el.setAttribute("aria-current", "true");
    el.innerHTML = `<span class="thread-title">${escapeHtml(t.title)}</span><button class="thread-del" title="Delete chat" aria-label="Delete chat: ${escapeHtml(t.title)}">✕</button>`;
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("thread-del")) { e.stopPropagation(); deleteThread(t.id); }
      else selectThread(t.id);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectThread(t.id); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteThread(t.id); }
    });
    threadsList.appendChild(el);
  }
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <div class="hero-mark" aria-hidden="true">W</div>
      <h1 class="hero-title">How can I help?</h1>
      <p class="hero-sub">Ask anything — Waguri stays available around the clock.</p>
      <div class="chips" role="list">
        <button class="chip" role="listitem">Draft a professional email</button>
        <button class="chip" role="listitem">Debug my Python code</button>
        <button class="chip" role="listitem">Explain a hard concept simply</button>
        <button class="chip" role="listitem">Summarize a long article</button>
      </div>
    </div>`;
}

function renderMessages() {
  const t = currentThread();
  messagesEl.innerHTML = "";
  if (!t || !t.messages.length) { messagesEl.innerHTML = emptyStateHtml(); return; }
  for (const m of t.messages) {
    const node = renderMessage(m.role, m.content, { error: m.error, images: m.images, search: m.search });
    messagesEl.appendChild(node);
    if (m.role === "assistant" && m.error) attachRetryButton(node);
  }
  scrollToBottom();
}

function renderMessage(role, content, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role + (opts.error ? " error" : "");
  wrap.setAttribute("role", "article");
  wrap.setAttribute("aria-label", role === "user" ? "You said" : "Waguri said");
  wrap.innerHTML = `<div class="avatar" aria-hidden="true">${role === "user" ? "You" : "W"}</div><div class="bubble"></div>`;
  const bubble = wrap.querySelector(".bubble");
  bubble.innerHTML = renderMarkdown(content);
  enhanceBubble(bubble, content);
  if (opts.images && opts.images.length) {
    const g = document.createElement("div");
    g.className = "msg-images";
    for (const src of opts.images) { const im = document.createElement("img"); im.src = src; im.alt = "Attached image"; g.appendChild(im); }
    bubble.prepend(g);
  }
  if (opts.search) {
    const b = document.createElement("div");
    b.className = "search-badge"; b.textContent = "🌐 Web search";
    bubble.prepend(b);
  }
  return wrap;
}

// ---------- copy ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function flashCopied(btn, label) {
  const original = btn.innerHTML;
  btn.classList.add("done");
  btn.innerHTML = "✓ Copied";
  setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = original; }, 1400);
  if (label) toast(label);
}

// Adds copy buttons to code blocks + a copy button for the whole message.
function enhanceBubble(bubble, rawText) {
  bubble.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = COPY_ICON + " Copy";
    btn.addEventListener("click", async () => {
      const ok = await copyText(pre.innerText);
      if (ok) flashCopied(btn); else toast("Copy failed");
    });
    wrap.appendChild(btn);
  });

  if (rawText && rawText.trim() && !bubble.querySelector(".msg-actions")) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-copy";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = COPY_ICON + " Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(rawText);
      if (ok) flashCopied(copyBtn); else toast("Copy failed");
    });
    actions.appendChild(copyBtn);
    bubble.appendChild(actions);
  }
}

function attachRetryButton(msgNode) {
  const bubble = msgNode.querySelector(".bubble");
  if (bubble.querySelector(".retry-row")) return;
  const row = document.createElement("div");
  row.className = "retry-row";
  row.innerHTML = `<span class="error-label">Reply failed.</span><button type="button" class="retry-btn" aria-label="Retry last message"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Retry</button>`;
  row.querySelector(".retry-btn").addEventListener("click", retryLast);
  bubble.appendChild(row);
}

function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
}
// Only auto-follow the stream while the reader is parked at the bottom.
let autoFollow = true;
messagesEl.addEventListener("scroll", () => { autoFollow = nearBottom(); }, { passive: true });

// ---------- sending ----------
// ---------- attachments + web search ----------
const fileInput = document.getElementById("fileInput");
const attachBtn = document.getElementById("attachBtn");
const searchBtn = document.getElementById("searchBtn");
const attachRow = document.getElementById("attachRow");
let pending = []; // { kind: "image"|"text", name, data }
let searchOn = false;

searchBtn.addEventListener("click", () => {
  searchOn = !searchOn;
  searchBtn.setAttribute("aria-pressed", String(searchOn));
  toast(searchOn ? "Web search on for next messages" : "Web search off");
});
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const f of [...fileInput.files]) {
    if (pending.length >= 4) { toast("Up to 4 files per message."); break; }
    try {
      if (f.type.startsWith("image/")) pending.push({ kind: "image", name: f.name, data: await compressImage(f) });
      else if (f.size > 200000) toast(`${f.name} is too large (max 200 KB).`);
      else pending.push({ kind: "text", name: f.name, data: await f.text() });
    } catch { toast(`Couldn't read ${f.name}.`); }
  }
  fileInput.value = "";
  renderAttachments();
});
function renderAttachments() {
  attachRow.innerHTML = "";
  pending.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = (p.kind === "image" ? `<img alt="" src="${p.data}">` : "📄") + `<span></span><button type="button" aria-label="Remove ${escapeAttr(p.name)}">×</button>`;
    chip.querySelector("span").textContent = p.name;
    chip.querySelector("button").onclick = () => { pending.splice(i, 1); renderAttachments(); };
    attachRow.appendChild(chip);
  });
}
function escapeAttr(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1280;
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

async function send() {
  let text = input.value.trim();
  if ((!text && !pending.length) || sending) return;

  if (!currentThread()) newThread();
  const t = currentThread();

  const images = pending.filter((p) => p.kind === "image").map((p) => p.data);
  const texts = pending.filter((p) => p.kind === "text");
  for (const f of texts) text += `\n\n**Attached file: ${f.name}**\n\`\`\`\n${f.data}\n\`\`\``;
  if (!text && images.length) text = "Describe this image.";
  const msg = { role: "user", content: text };
  if (images.length) msg.images = images;
  if (searchOn) msg.search = true;
  t.messages.push(msg);
  pending = []; renderAttachments();
  if (t.title === "New chat") t.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
  t.updatedAt = Date.now();
  await persist();
  renderThreads(); renderMessages();

  input.value = ""; input.style.height = "auto";
  await streamReply();
}

async function retryLast() {
  if (sending) return;
  const t = currentThread();
  if (!t) return;
  while (t.messages.length && t.messages[t.messages.length - 1].role === "assistant") t.messages.pop();
  if (!t.messages.length || t.messages[t.messages.length - 1].role !== "user") return;
  await persist();
  renderMessages();
  await streamReply();
}

function setModelStatus(online, label) {
  modelPicker.classList.toggle("offline", !online);
  if (label) modelLabel.textContent = label;
}

// ---------- settings (model choice + retry behaviour) ----------
const SETTINGS_KEY = "waguri.settings.v1";
const MODELS = {
  "google/gemini-3.1-pro-preview": "Gemini Pro",
  "openai/gpt-5.6-luna": "GPT Quick",
};
const DEFAULT_SETTINGS = {
  model: "google/gemini-3.1-pro-preview",
  attempts: 3,
  backoffMs: 700,
  backoffMode: "linear",
};
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const legacyModel = Array.isArray(raw.chain) ? raw.chain.find((c) => c.on && MODELS[c.id])?.id : null;
    return {
      model: MODELS[raw.model] ? raw.model : legacyModel || DEFAULT_SETTINGS.model,
      attempts: Math.min(6, Math.max(1, Number(raw.attempts) || 3)),
      backoffMs: Math.min(4000, Math.max(100, Number(raw.backoffMs) || 700)),
      backoffMode: ["linear", "exponential", "fixed"].includes(raw.backoffMode) ? raw.backoffMode : "linear",
    };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
function backoffDelay(attempt) {
  if (settings.backoffMode === "fixed") return settings.backoffMs;
  if (settings.backoffMode === "exponential") return settings.backoffMs * Math.pow(2, attempt - 1);
  return settings.backoffMs * attempt;
}

const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
const STOP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

let controller = null;

function stopGenerating() { try { controller?.abort(); } catch {} }

function setSendingUI(active) {
  sendBtn.classList.toggle("stop", active);
  sendBtn.innerHTML = active ? STOP_ICON : SEND_ICON;
  sendBtn.setAttribute("aria-label", active ? "Stop generating" : "Send");
  sendBtn.title = active ? "Stop generating" : "Send";
  if (active) sendBtn.setAttribute("aria-busy", "true");
  else sendBtn.removeAttribute("aria-busy");
}

// Keeps a partially streamed code fence from rendering as raw backticks.
function renderStreaming(text) {
  const fences = (text.match(/```/g) || []).length;
  return renderMarkdown(fences % 2 ? text + "\n```" : text);
}

const THINKING_HTML = (label) =>
  `<div class="typing" role="status"><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="typing-label">${label}</span></div>`;

async function streamReply() {
  const t = currentThread();
  if (!t) return;
  sending = true;
  setSendingUI(true);

  const assistantMsg = { role: "assistant", content: "" };
  t.messages.push(assistantMsg);
  const node = renderMessage("assistant", "");
  const bubbleContent = node.querySelector(".bubble");
  bubbleContent.innerHTML = THINKING_HTML("Waguri is thinking…");
  const empty = messagesEl.querySelector(".empty-state"); if (empty) empty.remove();
  messagesEl.appendChild(node);
  scrollToBottom();

  const clean = t.messages
    .slice(0, -1)
    .filter((m) => !m.error && ((m.content || "").trim().length > 0 || (m.images && m.images.length)));
  // Only the 3 most recent image-bearing messages resend their images (keeps requests small).
  let imgBudget = 3;
  const history = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    const m = clean[i];
    const out = { role: m.role, content: m.content || "" };
    if (m.images && m.images.length && imgBudget > 0) { out.images = m.images; imgBudget--; }
    history.unshift(out);
  }
  const lastUser = clean[clean.length - 1];
  const useSearch = !!(lastUser && lastUser.search);

  let lastError = null;
  let stopped = false;
  const maxAttempts = settings.attempts;

  // Client-side retries with backoff keep replies flowing through transient failures.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    controller = new AbortController();
    try {
      if (useSearch) bubbleContent.innerHTML = THINKING_HTML("Searching the web…");
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model: settings.model, search: useSearch }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const message = (await res.text()).trim() || `HTTP ${res.status}`;
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }

      const usedModel = res.headers.get("X-Waguri-Model");
      setModelStatus(true, usedModel ? (MODELS[usedModel] || "Model") + " active" : "Ready");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      bubbleContent.innerHTML = "";
      let acc = "";
      autoFollow = true;
      while (true) {
        const { value, done } = await reader.read();
        acc += decoder.decode(value, { stream: !done });
        if (acc) {
          assistantMsg.content = acc;
          bubbleContent.innerHTML = renderStreaming(acc);
          if (autoFollow) scrollToBottom();
          t.updatedAt = Date.now();
          persistSoon();
        }
        if (done) break;
      }

      if (!acc.trim()) {
        const error = new Error("The model returned an empty reply.");
        error.status = 502;
        throw error;
      }

      assistantMsg.content = acc;
      assistantMsg.error = false;
      bubbleContent.innerHTML = renderMarkdown(acc);
      enhanceBubble(bubbleContent, acc);
      t.updatedAt = Date.now();
      await persist();
      renderThreads();
      lastError = null;
      break;
    } catch (err) {
      if (err && (err.name === "AbortError" || controller?.signal.aborted)) {
        stopped = true;
        lastError = null;
        break;
      }
      lastError = err;
      const retryable = err.status === 429 || err.status >= 500 || !err.status;
      if (attempt < maxAttempts && retryable) {
        bubbleContent.innerHTML = THINKING_HTML(`Reconnecting… (attempt ${attempt + 1}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
      } else break;
    }
  }

  controller = null;

  if (stopped) {
    const text = (assistantMsg.content || "").trim();
    if (text) {
      assistantMsg.error = false;
      bubbleContent.innerHTML = renderMarkdown(text);
      enhanceBubble(bubbleContent, text);
    } else {
      t.messages = t.messages.filter((m) => m !== assistantMsg);
      node.remove();
      if (!t.messages.length) renderMessages();
    }
    setModelStatus(true, "Stopped");
    t.updatedAt = Date.now();
    await persist();
    renderThreads();
  } else if (lastError) {
    assistantMsg.content = lastError.message || "The reply could not be completed.";
    assistantMsg.error = true;
    node.classList.add("error");
    bubbleContent.innerHTML = renderMarkdown(assistantMsg.content);
    attachRetryButton(node);
    setModelStatus(false, "reconnecting");
    t.updatedAt = Date.now();
    await persist();
  }

  sending = false;
  sendBtn.disabled = false;
  setSendingUI(false);
  if (!isTouch) input.focus();
}

// ---------- markdown ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function renderMarkdown(src) {
  if (!src) return "";
  let s = escapeHtml(src);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(?:^|\n)((?:- .+\n?)+)/g, (m) => {
    const items = m.trim().split("\n").map((l) => `<li>${l.replace(/^- /, "")}</li>`).join("");
    return `\n<ul>${items}</ul>`;
  });
  s = s.split(/\n{2,}/).map((block) => {
    if (/^<(h\d|ul|ol|pre)/.test(block.trim())) return block;
    return `<p>${block.replace(/\n/g, "<br/>")}</p>`;
  }).join("");
  return s;
}

// ---------- theme ----------
const themeBtn = document.getElementById("themeBtn");
const themeIcon = document.getElementById("themeIcon");
const SUN_SVG = '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="19.5" y2="4.5"/>';
const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.innerHTML = theme === "light" ? MOON_SVG : SUN_SVG;
  themeBtn.title = theme === "light" ? "Switch to dark grey" : "Switch to light grey";
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || "dark"; } catch { return "dark"; } })());
themeBtn.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme(next);
  if (channel) { try { channel.postMessage({ type: "theme", from: TAB_ID, theme: next }); } catch {} }
});

// ---------- export ----------
const exportBtn = document.getElementById("exportBtn");
const exportMenu = document.getElementById("exportMenu");
function setExportExpanded(open) {
  exportBtn.setAttribute("aria-expanded", open ? "true" : "false");
  exportMenu.classList.toggle("show", open);
}
exportBtn.addEventListener("click", (e) => { e.stopPropagation(); setExportExpanded(!exportMenu.classList.contains("show")); });
document.addEventListener("click", (e) => {
  if (!exportMenu.contains(e.target) && e.target !== exportBtn) setExportExpanded(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (exportMenu.classList.contains("show")) setExportExpanded(false);
    if (sidebar.classList.contains("open")) closeSidebarMobile();
  }
});
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function safeSlug(s) { return (s || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat"; }
function threadToTxt(t) {
  const header = `# ${t.title}\nCreated: ${new Date(t.createdAt).toISOString()}\n\n`;
  const body = t.messages.map((m) => `## ${m.role === "user" ? "You" : "Waguri"}\n${m.content}\n`).join("\n");
  return header + body;
}
exportMenu.addEventListener("click", async (e) => {
  const kind = e.target?.dataset?.export;
  if (!kind) return;
  setExportExpanded(false);
  const stampStr = new Date().toISOString().slice(0, 10);
  if (kind === "copy-current") {
    const t = currentThread();
    if (!t || !t.messages.length) { toast("This chat is empty."); return; }
    const ok = await copyText(threadToTxt(t));
    toast(ok ? "Chat copied to clipboard" : "Copy failed");
    return;
  }
  if (kind.startsWith("current")) {
    const t = currentThread();
    if (!t || !t.messages.length) { toast("This chat is empty."); return; }
    const slug = safeSlug(t.title);
    if (kind.endsWith("json")) download(`waguri-${slug}-${stampStr}.json`, JSON.stringify(t, null, 2), "application/json");
    else download(`waguri-${slug}-${stampStr}.txt`, threadToTxt(t), "text/plain");
  } else {
    if (!threads.length) { toast("No chats to export."); return; }
    if (kind.endsWith("json")) download(`waguri-all-${stampStr}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), threads }, null, 2), "application/json");
    else download(`waguri-all-${stampStr}.txt`, threads.map(threadToTxt).join("\n\n---\n\n"), "text/plain");
  }
});

// ---------- resume / lifecycle sync ----------
window.addEventListener("storage", (e) => {
  if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue);
  else if (e.key === STORAGE_KEY || e.key === ACTIVE_KEY) reloadFromStore();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadFromStore(); });
window.addEventListener("pageshow", () => reloadFromStore());
window.addEventListener("pagehide", () => { lsSet(threads, activeId); });
window.addEventListener("beforeunload", () => { lsSet(threads, activeId); });
window.addEventListener("online", () => setModelStatus(true));
window.addEventListener("offline", () => setModelStatus(false, "offline"));

// ---------- boot ----------
(async () => {
  await loadAll();
  renderThreads();
  renderMessages();
})();

// ---------- settings UI ----------
const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsClose = document.getElementById("settingsClose");
const settingsSave = document.getElementById("settingsSave");
const settingsReset = document.getElementById("settingsReset");
const settingsModelSelect = document.getElementById("settingsModelSelect");
const retriesRange = document.getElementById("retriesRange");
const retriesOut = document.getElementById("retriesOut");
const backoffRange = document.getElementById("backoffRange");
const backoffOut = document.getElementById("backoffOut");
const backoffMode = document.getElementById("backoffMode");

let draft = null;

function fillSettingsForm() {
  settingsModelSelect.value = draft.model;
  retriesRange.value = String(draft.attempts);
  retriesOut.textContent = String(draft.attempts);
  backoffRange.value = String(draft.backoffMs);
  backoffOut.textContent = draft.backoffMs + " ms";
  backoffMode.value = draft.backoffMode;
}

function openSettings() {
  draft = JSON.parse(JSON.stringify(settings));
  fillSettingsForm();
  settingsOverlay.classList.add("show");
  settingsClose.focus();
}
function closeSettings() {
  settingsOverlay.classList.remove("show");
  settingsBtn.focus();
}

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) closeSettings(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsOverlay.classList.contains("show")) closeSettings();
});
retriesRange.addEventListener("input", () => {
  draft.attempts = Number(retriesRange.value);
  retriesOut.textContent = retriesRange.value;
});
backoffRange.addEventListener("input", () => {
  draft.backoffMs = Number(backoffRange.value);
  backoffOut.textContent = backoffRange.value + " ms";
});
backoffMode.addEventListener("change", () => { draft.backoffMode = backoffMode.value; });
settingsModelSelect.addEventListener("change", () => { draft.model = settingsModelSelect.value; });
settingsReset.addEventListener("click", () => {
  draft = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  fillSettingsForm();
});
settingsSave.addEventListener("click", () => {
  settings = draft;
  saveSettings();
  modelSelect.value = settings.model;
  setModelStatus(true, "Ready");
  toast("Settings saved");
  closeSettings();
});

modelSelect.value = settings.model;
modelSelect.addEventListener("change", () => {
  settings.model = modelSelect.value;
  saveSettings();
  setModelStatus(true, "Ready");
});
setModelStatus(true, "Ready");
