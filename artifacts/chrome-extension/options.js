let domainMappings = [];
let availableTopics = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function boot() {
  const settings = await loadSettings();
  document.getElementById("api-url").value = settings.apiUrl || "";
  domainMappings = settings.domainMappings || [];

  renderMappings();

  if (settings.apiUrl) await loadTopics(settings.apiUrl);

  document.getElementById("save-btn").addEventListener("click", save);
  document.getElementById("test-btn").addEventListener("click", testConnection);
  document.getElementById("add-mapping-btn").addEventListener("click", addMapping);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiUrl", "domainMappings"], (r) => {
      resolve({ apiUrl: r.apiUrl || "", domainMappings: r.domainMappings || [] });
    });
  });
}

function save() {
  const apiUrl = document.getElementById("api-url").value.trim().replace(/\/$/, "");
  chrome.storage.sync.set({ apiUrl, domainMappings }, () => {
    const s = document.getElementById("save-status");
    s.textContent = "✓ Saved";
    s.className = "save-status ok";
    setTimeout(() => { s.textContent = ""; s.className = "save-status"; }, 2000);
  });
}

// ─── Connection test ──────────────────────────────────────────────────────────

async function testConnection() {
  const apiUrl = document.getElementById("api-url").value.trim().replace(/\/$/, "");
  const result = document.getElementById("test-result");
  result.style.display = "block";
  result.className = "test-result";
  result.textContent = "Testing…";

  try {
    const res = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      result.className = "test-result test-ok";
      result.textContent = "✓ Connected — API is reachable.";
      await loadTopics(apiUrl);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    result.className = "test-result test-fail";
    result.textContent = `✗ Could not reach API (${e.message}). Check the URL.`;
  }
}

// ─── Topics ───────────────────────────────────────────────────────────────────

async function loadTopics(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/api/topics`);
    if (!res.ok) throw new Error();
    availableTopics = await res.json();
    populateTopicSelect();
    document.getElementById("topics-error").style.display = "none";
  } catch {
    document.getElementById("topics-error").style.display = "block";
  }
}

function populateTopicSelect() {
  const sel = document.getElementById("new-topic-id");
  sel.innerHTML = `<option value="">Select topic…</option>`;
  availableTopics.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} — ${t.subject}`;
    sel.appendChild(opt);
  });
}

// ─── Mapping management ───────────────────────────────────────────────────────

function renderMappings() {
  const list = document.getElementById("mappings-list");
  if (domainMappings.length === 0) {
    list.innerHTML = `<div class="no-mappings">No mappings yet. Add a domain below to start auto-tracking.</div>`;
    return;
  }
  list.innerHTML = domainMappings.map((m, i) => `
    <div class="mapping-row">
      <span class="mapping-domain">${esc(m.domain)}</span>
      <span class="mapping-topic">→ ${esc(m.topicName)}</span>
      <button class="mapping-remove" data-idx="${i}" title="Remove">✕</button>
    </div>
  `).join("");
  list.querySelectorAll(".mapping-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx);
      domainMappings.splice(idx, 1);
      renderMappings();
    });
  });
}

function addMapping() {
  const domain = document.getElementById("new-domain").value.trim().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const topicId = parseInt(document.getElementById("new-topic-id").value);
  const topic = availableTopics.find((t) => t.id === topicId);

  if (!domain || !topic) {
    alert("Enter a domain and select a topic.");
    return;
  }

  if (domainMappings.some((m) => m.domain === domain)) {
    alert("This domain is already mapped.");
    return;
  }

  domainMappings.push({ domain, topicId: topic.id, topicName: topic.name });
  renderMappings();
  document.getElementById("new-domain").value = "";
  document.getElementById("new-topic-id").value = "";
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

boot();
