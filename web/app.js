/* KONA WebView Helper - front end */
(() => {
"use strict";

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  boot: null,
  target: null,
  version: null,
  feature: null,
  featureMeta: null,
  body: {},
  sessions: {},   /* keyed "TARGET|VERSION" - a userId from BK V1 never leaks into BK V2 */
  view: "form",
  busy: false,
};

const SESSION_STORE = "konaSessions";

function sessionKey() {
  return state.target + "|" + state.version;
}

function currentSession() {
  const key = sessionKey();
  if (!state.sessions[key]) state.sessions[key] = {};
  return state.sessions[key];
}

function loadSessions() {
  try {
    state.sessions = JSON.parse(localStorage.getItem(SESSION_STORE) || "{}");
  } catch (error) {
    state.sessions = {};
  }
}

function persistSessions() {
  try {
    localStorage.setItem(SESSION_STORE, JSON.stringify(state.sessions));
  } catch (error) { /* storage full or disabled - not fatal */ }
}

/* ------------------------------------------------------------------ api */
/* The page may be served by this project's Python server OR by VS Code Live Server
   (or opened as a file://). The Python server is what actually proxies the WebView
   API, so find it: ?api=... wins, then same origin, then the usual local ports.   */
const API_PORTS = [8770, 8771, 8772, 8080];
let API_BASE = "";

async function api(path, payload) {
  const options = payload === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  const response = await fetch(API_BASE + path, options);
  const data = await response.json().catch(() => ({ error: "server returned non-JSON" }));
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

async function probeApi(base) {
  try {
    const response = await fetch(base + "/api/bootstrap", { method: "GET" });
    return response.ok ? await response.json() : null;
  } catch (error) {
    return null;
  }
}

async function discoverApi() {
  const forced = new URLSearchParams(location.search).get("api");
  if (forced) localStorage.setItem("konaApiBase", forced.replace(/\/+$/, ""));
  const stored = localStorage.getItem("konaApiBase");

  const candidates = [];
  if (stored) candidates.push(stored);
  if (location.protocol !== "file:") candidates.push("");
  API_PORTS.forEach((port) => candidates.push("http://127.0.0.1:" + port));

  for (const base of [...new Set(candidates)]) {
    const boot = await probeApi(base);
    if (boot) {
      API_BASE = base;
      return boot;
    }
  }
  localStorage.removeItem("konaApiBase");
  return null;
}

function showApiBanner() {
  const hosted = location.protocol !== "file:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  $(".content").innerHTML =
    '<div class="banner"><b>API server not reachable.</b><br><br>'
    + "This page is served from <code>" + location.origin + "</code>, but every call to the WebView "
    + "API is proxied by this project's Python server, which does not appear to be running.<br><br>"
    + "Start it on a machine that can reach the API host, then reload this page:<br>"
    + "<code>python server.py --no-browser</code><br><br>"
    + (hosted
      ? "Because this copy of the UI is hosted, two things must also be true:<br>"
        + "&bull;&nbsp;the Python server runs on <b>this same computer</b> &mdash; the WebView API "
        + "sits on a private address, so only a machine on that network can reach it;<br>"
        + "&bull;&nbsp;<code>" + location.origin + "</code> is listed under "
        + "<code>server.allowedOrigins</code> in <code>config.json</code>, otherwise the browser "
        + "blocks the call.<br><br>"
      : "")
    + "If it listens on another port, open "
    + "<code>" + location.origin + location.pathname + "?api=http://127.0.0.1:PORT</code>."
    + "</div>";
}

let toastTimer = null;
function toast(message, ms = 3200) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), ms);
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------- utilities */
function setPath(obj, path, value) {
  const parts = path.split(".");
  let cursor = obj;
  parts.slice(0, -1).forEach((part) => {
    if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  });
  cursor[parts[parts.length - 1]] = value;
}

/* `scoped` lets the Run All page substitute against a version that is not the selected one */
function substituteSession(value, scoped) {
  const session = scoped || currentSession();
  if (typeof value === "string") {
    /* a field that is nothing but a placeholder keeps the captured type,
       so "userId": "{{userId}}" sends the number 50001168496, not a string */
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole && Object.prototype.hasOwnProperty.call(session, whole[1])) return session[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(session, key) ? String(session[key]) : match);
  }
  if (Array.isArray(value)) return value.map((item) => substituteSession(item, session));
  if (value && typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([key, item]) => { out[key] = substituteSession(item, session); });
    return out;
  }
  return value;
}

/* ------------------------------------------------------------- the form */
function flatten(obj, prefix, rows) {
  Object.entries(obj).forEach(([key, value]) => {
    const path = prefix ? prefix + "." + key : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) {
        rows.push({ path, type: "json", value });
      } else {
        rows.push({ group: path });
        flatten(value, path, rows);
      }
    } else if (Array.isArray(value)) {
      const scalars = value.every((item) => item === null || typeof item !== "object");
      rows.push({ path, type: scalars ? (value.every((i) => typeof i === "number") ? "numlist" : "list") : "json", value });
    } else {
      rows.push({ path, type: value === null ? "null" : typeof value, value });
    }
  });
  return rows;
}

function renderForm() {
  const host = $("#formFields");
  host.innerHTML = "";
  const auto = new Set((state.featureMeta && state.featureMeta.randomize) || []);
  const rows = flatten(state.body, "", []);

  if (!rows.length) {
    host.innerHTML = '<p class="note">This feature has no body configured yet. Add one under '
      + '<code>features.' + state.feature + '.body</code> in Settings, or paste it in the Raw JSON tab.</p>';
    return;
  }

  rows.forEach((row) => {
    if (row.group) {
      const group = document.createElement("div");
      group.className = "fgroup";
      group.textContent = row.group;
      host.appendChild(group);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "frow" + (auto.has(row.path) ? " frow--auto" : "");

    const label = document.createElement("label");
    label.textContent = row.path.includes(".") ? row.path.split(".").slice(1).join(".") : row.path;
    if (auto.has(row.path)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "AUTO";
      tag.title = "Regenerated on every send";
      label.appendChild(tag);
    }
    if (row.type === "list" || row.type === "numlist" || row.type === "json") {
      const tag = document.createElement("span");
      tag.className = "tag tag--type";
      tag.textContent = row.type === "json" ? "JSON" : "LIST";
      label.appendChild(tag);
    }
    /* show what a {{placeholder}} will actually resolve to for the selected target */
    const refs = typeof row.value === "string"
      ? Array.from(String(row.value).matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1]) : [];
    if (refs.length) {
      const session = currentSession();
      const resolved = refs.every((name) => Object.prototype.hasOwnProperty.call(session, name));
      const tag = document.createElement("span");
      tag.className = "tag " + (resolved ? "tag--ok" : "tag--warn");
      tag.textContent = resolved
        ? "→ " + refs.map((name) => session[name]).join(", ")
        : "no value yet — run step 1 for " + state.target + " " + state.version;
      label.appendChild(tag);
    }
    wrap.appendChild(label);

    /* config.json -> features.<x>.options.<path> turns a field into a picker */
    const choices = ((state.featureMeta && state.featureMeta.options) || {})[row.path];

    let input;
    if (row.type === "boolean") {
      /* a fixed two-value choice - config can relabel them (physical vs virtual card) */
      const values = choices
        ? choices.map((c) => ({ value: String(c.value), label: c.label || String(c.value) }))
        : [{ value: "true", label: "true" }, { value: "false", label: "false" }];
      input = document.createElement("select");
      values.forEach((option) => {
        const node = document.createElement("option");
        node.value = option.value;
        node.textContent = option.label;
        input.appendChild(node);
      });
      input.value = String(row.value);
    } else if (choices && row.type !== "json") {
      /* suggestions from config, but still free text so any new value can be typed */
      input = document.createElement("input");
      input.value = String(row.value);
      const listId = "dl-" + row.path.replace(/[^\w]/g, "-");
      input.setAttribute("list", listId);
      const datalist = document.createElement("datalist");
      datalist.id = listId;
      choices.forEach((choice) => {
        const node = document.createElement("option");
        node.value = String(choice.value);
        if (choice.label) node.label = choice.label;
        datalist.appendChild(node);
      });
      wrap.appendChild(datalist);
    } else if (row.type === "json") {
      input = document.createElement("textarea");
      input.value = JSON.stringify(row.value);
    } else {
      input = document.createElement("input");
      if (row.type === "list" || row.type === "numlist") input.value = row.value.join(", ");
      else if (row.type === "null") input.value = "";
      else input.value = String(row.value);
      input.placeholder = row.type === "list" || row.type === "numlist" ? "comma separated" : "";
    }
    input.className = "mono";
    input.dataset.path = row.path;
    input.dataset.type = row.type;
    input.spellcheck = false;
    wrap.appendChild(input);
    host.appendChild(wrap);
  });
}

function readForm() {
  const out = {};
  $$("#formFields [data-path]").forEach((el) => {
    const raw = el.value;
    let value = raw;
    switch (el.dataset.type) {
      case "number": value = raw.trim() === "" ? null : (isNaN(Number(raw)) ? raw : Number(raw)); break;
      case "boolean": value = raw === "true"; break;
      case "list": value = raw.split(",").map((s) => s.trim()).filter((s) => s !== ""); break;
      case "numlist": value = raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number); break;
      case "null": value = raw === "" ? null : raw; break;
      case "json":
        try { value = JSON.parse(raw); } catch (error) { value = raw; }
        break;
      default: value = raw;
    }
    setPath(out, el.dataset.path, value);
  });
  return out;
}

/** Pull the active editor's contents into state.body. Returns false if the JSON is broken. */
function commitView() {
  if (state.view === "form") {
    if ($$("#formFields [data-path]").length) state.body = readForm();
    return true;
  }
  if (state.view === "json") {
    const raw = $("#jsonBody").value.trim();
    if (!raw) { state.body = {}; return true; }
    try {
      state.body = JSON.parse(raw);
      return true;
    } catch (error) {
      toast("Raw JSON is invalid: " + error.message, 5000);
      return false;
    }
  }
  return true;
}

function paintBody() {
  renderForm();
  $("#jsonBody").value = JSON.stringify(state.body, null, 4);
}

/* ------------------------------------------------------------- target UI */
function currentConnection() {
  const target = state.boot.targets.find((t) => t.key === state.target);
  return target.versions.find((v) => v.key === state.version);
}

function renderTargets() {
  const affiliates = $("#affiliatePills");
  affiliates.innerHTML = "";
  state.boot.targets.forEach((target) => {
    const button = document.createElement("button");
    button.className = "pill" + (target.key === state.target ? " is-on" : "");
    button.textContent = target.label;
    button.onclick = () => selectTarget(target.key, null);
    affiliates.appendChild(button);
  });

  const versions = $("#versionPills");
  versions.innerHTML = "";
  const target = state.boot.targets.find((t) => t.key === state.target);
  target.versions.forEach((version) => {
    const button = document.createElement("button");
    button.className = "pill" + (version.key === state.version ? " is-on" : "");
    button.textContent = version.key;
    button.onclick = () => selectTarget(state.target, version.key);
    versions.appendChild(button);
  });
}

/* One line-icon per module. Stroke is currentColor, so they follow the nav item's
   colour: muted when idle, white on the active purple fill, dimmed when not configured. */
const MODULE_ICONS = {
  // a person with a plus - creating a user
  user_registration:
    '<circle cx="9.5" cy="8" r="3.3"/><path d="M3.8 19.2c0-3.2 2.6-5.2 5.7-5.2 1.1 0 2.1.2 3 .7"/>'
    + '<path d="M17.8 13.4v5.4M15.1 16.1h5.4"/>',
  // a bank with a plus - opening an account
  bank_account_registration:
    '<path d="M3.2 9.6 12 4.8l8.8 4.8"/><path d="M5.8 11.4v6.1M10 11.4v6.1M14.2 11.4v4"/>'
    + '<path d="M3.4 19.8h9.2"/><path d="M18 13.6v5.4M15.3 16.3h5.4"/>',
  // a bank under a magnifier - looking an account up
  bank_account_inquiry:
    '<path d="M3.2 9.6 12 4.8l8.8 4.8"/><path d="M5.8 11.4v6.1M9.6 11.4v6.1"/><path d="M3.4 19.8h8"/>'
    + '<circle cx="16.4" cy="15.2" r="3.4"/><path d="M18.9 17.7 21.4 20.2"/>',
  // an info disc - the PG configuration behind an account
  pg_info_inquiry:
    '<circle cx="12" cy="12" r="8.2"/><path d="M12 11.3v4.9"/><path d="M12 8.2h.01"/>',
  // a card with a plus - applying for one
  apply_card:
    '<rect x="2.6" y="6" width="14.2" height="10.4" rx="2.2"/><path d="M2.6 9.9h14.2"/>'
    + '<path d="M19 13.4v5.4M16.3 16.1h5.4"/>',
  // a card with a tick - the plastic registered against it
  card_registration:
    '<rect x="2.6" y="6" width="14.2" height="10.4" rx="2.2"/><path d="M2.6 9.9h14.2"/>'
    + '<path d="M15.3 17.1 17.8 19.6 22 15.4"/>',
};
const FALLBACK_ICON = '<circle cx="12" cy="12" r="3.4"/>';

function iconSvg(paths) {
  return '<svg class="nav__svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + paths + "</svg>";
}

/* the Modules group in the sidebar - one entry per feature, in config order */
function renderModuleNav() {
  const host = $("#moduleNav");
  host.innerHTML = "";
  const connection = currentConnection();
  state.boot.features.forEach((feature) => {
    const configured = !!(connection.endpoints || {})[feature.key];
    const button = document.createElement("button");
    button.className = "nav__item nav__item--sub"
      + (feature.key === state.feature && !$("#page-flow").classList.contains("is-hidden") ? " is-active" : "")
      + (configured ? "" : " is-todo");
    button.dataset.feature = feature.key;
    button.title = configured ? feature.label : feature.label + " - no endpoint configured yet";
    button.innerHTML = iconSvg(MODULE_ICONS[feature.key] || FALLBACK_ICON);
    button.appendChild(document.createTextNode(feature.label));
    button.onclick = async () => {
      await loadFeature(feature.key);
      showPage("flow");
    };
    host.appendChild(button);
  });
}

function paintConnection() {
  const connection = currentConnection();
  $("#baseUrl").value = connection.baseUrl || "";
  $("#aspId").value = connection.aspId || "";
  $("#accessKey").value = connection.accessKey || "";
  $("#timeZone").value = state.boot.defaults.timeZone || "KST";
  $("#timeout").value = state.boot.defaults.timeoutSeconds || 30;
  paintEnv();
}

function paintEnv() {
  let host = $("#baseUrl").value;
  try { host = new URL($("#baseUrl").value).host; } catch (error) { /* keep raw */ }
  $("#envHost").textContent = host || "—";
  $("#envAsp").textContent = $("#aspId").value || "—";
  $("#envPath").textContent = $("#path").value || "—";
  const target = state.boot.targets.find((t) => t.key === state.target);
  $("#envPill").textContent = (target ? target.label : "") + " · " + state.version;
  $("#urlPreview").textContent = ($("#baseUrl").value || "").replace(/\/+$/, "") + ($("#path").value || "");
}

async function selectTarget(targetKey, versionKey) {
  state.target = targetKey;
  const target = state.boot.targets.find((t) => t.key === targetKey);
  const versionKeys = target.versions.map((v) => v.key);
  state.version = versionKey && versionKeys.includes(versionKey)
    ? versionKey
    : (versionKeys.includes(state.version) ? state.version : versionKeys[0]);
  renderTargets();
  paintConnection();
  /* seed before the form paints, so {{userId}} resolves to THIS target's last user */
  await seedSessionFromHistory(false);
  await loadFeature(state.feature || state.boot.features[0].key);
  renderSession();
  pingHost();
}

async function loadFeature(featureKey) {
  state.feature = featureKey;
  state.featureMeta = state.boot.features.find((f) => f.key === featureKey);
  const data = await api("/api/body", { feature: featureKey, target: state.target, version: state.version });
  state.body = data.body;
  state.featureMeta.randomize = data.randomize;
  state.featureMeta.options = data.options || {};
  state.featureMeta.cardSource = !!data.cardSource;
  $("#path").value = data.path || "";
  $("#method").value = data.method || "POST";
  $("#requestHint").textContent = "Randomized every send: " + ((data.randomize || []).join(", ") || "nothing");
  $("#pageTitle").textContent = state.featureMeta.label.toUpperCase();
  paintBody();
  renderModuleNav();
  paintEnv();
  clearResponse();
  $("#btnFetchCard").classList.toggle("is-hidden", !data.cardSource);
  if (data.autoFetchCard) fetchPortalCard(true);
  $("#requestNote").textContent = data.path
    ? ""
    : "No endpoint path configured for this step yet — type one above, or set it in Settings under targets."
      + state.target + ".versions." + state.version + ".endpoints." + featureKey;
}

/* ------------------------------------------------------------- requests */
function requestPayload(extra) {
  return Object.assign({
    feature: state.feature,
    target: state.target,
    version: state.version,
    baseUrl: $("#baseUrl").value,
    path: $("#path").value,
    method: $("#method").value,
    aspId: $("#aspId").value,
    accessKey: $("#accessKey").value,
    timeZone: $("#timeZone").value,
    timeout: Number($("#timeout").value) || 30,
    extraHeaders: $("#extraHeaders").value,
    useProxy: $("#useProxy").checked,
    body: substituteSession(state.body),
  }, extra || {});
}

async function send() {
  if (state.busy || !commitView()) return;
  if (!$("#path").value.trim()) { toast("Set the endpoint path first"); return; }

  /* stop before sending a literal {{placeholder}} the session cannot fill */
  const resolvedBody = substituteSession(state.body);
  const missing = Array.from(new Set(
    (JSON.stringify(resolvedBody).match(/\{\{(\w+)\}\}/g) || []).map((m) => m.slice(2, -2))));
  if (missing.length) {
    toast(missing.join(", ") + " has no value yet for " + sessionKey().replace("|", " ")
      + " — run the earlier step that produces it on this target first", 6500);
    return;
  }

  state.busy = true;
  $("#btnSend").disabled = true;
  setChip("busy", "SENDING");
  $("#responseMeta").textContent = "Waiting for the server…";

  try {
    const result = await api("/api/send", requestPayload({
      body: resolvedBody,
      randomizeBeforeSend: $("#autoRandom").checked,
      saveHistory: $("#saveHistory").checked,
    }));
    if (Object.keys(result.generated || {}).length) {
      state.body = result.sentBody;
      paintBody();
    }
    renderResult(result);
    if (Object.keys(result.captured || {}).length) {
      Object.assign(currentSession(), result.captured);
      persistSessions();
      renderSession();
    }
    const retries = (result.cardAttempts || []).filter((a) => a.physicalCardNo);
    if (retries.length) {
      state.body = result.sentBody;
      paintBody();
      $("#requestNote").textContent = "Card swapped after " + retries.length
        + " already-mapped card(s): " + retries.map((a) => a.physicalCardNo).join(", ")
        + "  →  used " + ((result.sentBody || {}).physicalCardNo || "");
    }
    const captured = Object.keys(result.captured || {});
    toast(result.ok
      ? "HTTP " + result.status + " in " + result.elapsedMs + " ms"
        + (captured.length ? " · captured " + captured.join(", ") : " · nothing captured from the response")
      : "Failed: " + (result.status || "no response") + " " + (result.reason || ""));
  } catch (error) {
    setChip("bad", "ERROR");
    $("#out-body").textContent = String(error);
    toast(String(error), 5000);
  } finally {
    state.busy = false;
    $("#btnSend").disabled = false;
  }
}

function setChip(kind, text) {
  const chip = $("#statusChip");
  chip.className = "chip chip--" + kind;
  chip.textContent = text;
}

/* a response belongs to one module on one target - wipe it whenever either changes,
   so a Bank Account Registration tab never shows the User Registration result */
function clearResponse() {
  setChip("idle", "IDLE");
  $("#responseMeta").textContent = "No request sent yet";
  $("#statusUrl").textContent = "";
  ["body", "headers", "sent", "curl"].forEach((name) => { $("#out-" + name).textContent = "—"; });
  $$(".tabs .tab[data-rview]").forEach((node) => node.classList.toggle("is-active", node.dataset.rview === "body"));
  ["body", "headers", "sent", "curl"].forEach((name) => {
    $("#out-" + name).classList.toggle("is-hidden", name !== "body");
  });
}

function renderResult(result) {
  setChip(result.ok ? "ok" : "bad", (result.status || "NO RESPONSE") + " " + (result.reason || ""));
  $("#responseMeta").textContent = result.elapsedMs + " ms"
    + (result.historyFile ? " · saved as " + result.historyFile : "");
  $("#statusUrl").textContent = result.url || "";
  $("#out-body").textContent = result.isJson
    ? JSON.stringify(result.responseBody, null, 2)
    : (result.responseBody || "(empty body)");
  $("#out-headers").textContent = Object.entries(result.responseHeaders || {})
    .map(([k, v]) => k + ": " + v).join("\n") || "—";
  $("#out-sent").textContent = Object.entries(result.sentHeaders || {})
    .map(([k, v]) => k + ": " + v).join("\n");
  $("#out-curl").textContent = result.curl;
}

/* Pull the last run for the SELECTED affiliate + version out of history.
   On a plain switch we only fill an empty slot, so a live session in this tab is never
   clobbered; `force` (the Load latest button) always replaces it. */
async function seedSessionFromHistory(force) {
  const scope = sessionKey();
  if (!force && Object.keys(currentSession()).length) return false;
  try {
    const result = await api("/api/session-seed", { target: state.target, version: state.version });
    if (!result.found) {
      if (force) toast("No completed run in history for " + scope.replace("|", " "));
      return false;
    }
    state.sessions[scope] = result.session;
    persistSessions();
    renderSession();
    if (force) toast("Loaded last " + scope.replace("|", " ") + " run — userId " + result.session.userId);
    return true;
  } catch (error) {
    if (force) toast("Could not load history: " + error.message, 5000);
    return false;
  }
}

function renderSession() {
  const host = $("#sessionChips");
  const session = currentSession();
  const target = state.boot.targets.find((t) => t.key === state.target);
  $("#sessionScope").textContent = (target ? target.label : state.target) + " · " + state.version
    + "  —  kept per affiliate × webview version · reuse as {{name}}";

  const others = Object.entries(state.sessions)
    .filter(([key, values]) => key !== sessionKey() && Object.keys(values).length)
    .map(([key]) => key.replace("|", " "));
  $("#sessionOthers").textContent = others.length ? "Also held for: " + others.join(", ") : "";

  const entries = Object.entries(session);
  if (!entries.length) {
    host.innerHTML = '<span class="note">Empty for this target — run User Registration here '
      + "and the userId lands in this slot</span>";
    return;
  }
  host.innerHTML = "";
  entries.forEach(([key, value]) => {
    const text = String(value);
    const chip = document.createElement("span");
    chip.className = "schip";
    chip.title = "Click to copy {{" + key + "}}";
    chip.innerHTML = "<b>" + key + "</b>  " + (text.length > 34 ? text.slice(0, 34) + "…" : text);
    chip.onclick = () => { navigator.clipboard.writeText("{{" + key + "}}"); toast("Copied {{" + key + "}}"); };
    host.appendChild(chip);
  });
}

async function pingHost() {
  const dot = $("#dotHost");
  try {
    const result = await api("/api/ping", { baseUrl: $("#baseUrl").value });
    dot.className = "dot" + (result.ok ? "" : " dot--bad");
    $("#connNote").textContent = result.detail;
    return result;
  } catch (error) {
    dot.className = "dot dot--bad";
    $("#connNote").textContent = String(error);
  }
}

/* ------------------------------------------------------------- history */
let historyRows = [];
async function loadHistory() {
  const data = await api("/api/history");
  historyRows = data.rows;
  const tbody = $("#historyTable tbody");
  tbody.innerHTML = "";
  historyRows.forEach((row) => {
    const tr = document.createElement("tr");
    const ok = typeof row.status === "number" && row.status >= 200 && row.status < 300;
    tr.innerHTML = "<td>" + (row.timestamp || "").replace("T", " ") + "</td>"
      + "<td>" + row.feature + "</td><td>" + row.affiliate + "</td><td>" + row.version + "</td>"
      + '<td class="' + (ok ? "st-ok" : "st-bad") + '">' + (row.status === null ? "—" : row.status) + "</td>"
      + "<td>" + (row.elapsedMs === null ? "—" : row.elapsedMs) + "</td>";
    tr.onclick = async () => {
      $$("#historyTable tbody tr").forEach((node) => node.classList.remove("is-sel"));
      tr.classList.add("is-sel");
      const record = await api("/api/history/" + encodeURIComponent(row.file));
      $("#historyDetail").textContent = JSON.stringify(record, null, 2);
    };
    tbody.appendChild(tr);
  });
  $("#historyNote").textContent = historyRows.length + " record(s) in history\\";
}

/* ----------------------------------------------------------- run all */
/* Drives every module in order against one target, chaining the session as it goes.
   It reuses the same endpoints a manual run uses, so there is no second code path:
   the placeholder guard, the portal card fetch and the 003_027 retry all still apply. */
let runCancelled = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runStepRow(host, label) {
  const row = document.createElement("div");
  row.className = "runstep is-queued";
  row.innerHTML = '<span class="runstep__mark"></span><b class="runstep__name"></b>'
    + '<span class="runstep__msg">Queued…</span>';
  row.querySelector(".runstep__name").textContent = label;
  host.appendChild(row);
  return (state, message) => {
    row.className = "runstep is-" + state;
    row.querySelector(".runstep__msg").textContent = message;
  };
}

function runHeading(host, text) {
  const node = document.createElement("div");
  node.className = "runhead";
  node.textContent = text;
  host.appendChild(node);
}

async function runAllForTarget(target, version, options, host) {
  const targetMeta = state.boot.targets.find((t) => t.key === target);
  const conn = targetMeta.versions.find((v) => v.key === version);
  const scope = target + "|" + version;
  runHeading(host, targetMeta.label + "  ·  " + version);

  if (conn.accessKey === "CHANGE_ME" || !conn.accessKey) {
    const row = runStepRow(host, "Credentials");
    row("fail", "No access key configured for this target — set it in Settings");
    return { ok: false, done: 0, total: 0 };
  }

  /* a full run creates a new user, so start from a clean slate for this target -
     otherwise a stale cardApplyNo from an earlier run could be carried into step 6 */
  state.sessions[scope] = {};
  const session = state.sessions[scope];
  const started = Date.now();
  let done = 0, failed = false;

  for (const feature of state.boot.features) {
    if (runCancelled) break;
    const setRow = runStepRow(host, feature.label);
    try {
      const meta = await api("/api/body", { feature: feature.key, target, version });
      if (!meta.path) {
        setRow("skip", "No endpoint configured — skipped");
        continue;
      }

      const body = substituteSession(meta.body, session);
      if (feature.key === "apply_card") {
        body.isDeliveryRequired = !!options.physical;
      }
      if (meta.cardSource) {
        setRow("busy", "Fetching an ACTIVE card from the portal…");
        const card = await api("/api/card-source", { target, version });
        if (!card.ok) {
          setRow("fail", "Portal card fetch failed — " + card.error);
          failed = true;
          if (options.stopOnFail) break;
          continue;
        }
        Object.assign(body, card.fields);
      }

      setRow("busy", "Sending…");
      const result = await api("/api/send", {
        feature: feature.key, target, version,
        baseUrl: conn.baseUrl, path: meta.path, method: meta.method,
        aspId: conn.aspId, accessKey: conn.accessKey,
        timeZone: $("#timeZone").value || "KST",
        timeout: Number($("#timeout").value) || 60,
        extraHeaders: "", useProxy: $("#useProxy").checked,
        body, randomizeBeforeSend: true, saveHistory: true,
      });
      Object.assign(session, result.captured);
      persistSessions();

      if (!result.ok) {
        setRow("fail", result.status + " " + describeResult(result));
        failed = true;
        if (options.stopOnFail) break;
        continue;
      }

      done += 1;
      const retries = (result.cardAttempts || []).filter((a) => a.physicalCardNo).length;
      setRow("ok", result.status + " " + describeResult(result)
        + (retries ? "  ·  skipped " + retries + " already-mapped card(s)" : ""));

      /* the ARS registration is not visible to the inquiry immediately */
      if (feature.key === "bank_account_registration" && options.settle > 0) {
        setRow("ok", setRowText(result) + "  ·  settling " + options.settle + "s…");
        await sleep(options.settle * 1000);
        setRow("ok", setRowText(result));
      }
      /* ...and when it still is not, the inquiry answers 200 with every field null */
      if (feature.key === "bank_account_inquiry") {
        for (let attempt = 2; attempt <= 4 && !session.bankCode && !runCancelled; attempt += 1) {
          setRow("busy", "No bank account visible yet — retry " + attempt + " in "
            + Math.max(3, options.settle) + "s…");
          await sleep(Math.max(3, options.settle) * 1000);
          const retry = await api("/api/send", {
            feature: feature.key, target, version,
            baseUrl: conn.baseUrl, path: meta.path, method: meta.method,
            aspId: conn.aspId, accessKey: conn.accessKey,
            timeZone: $("#timeZone").value || "KST",
            timeout: Number($("#timeout").value) || 60,
            extraHeaders: "", useProxy: $("#useProxy").checked,
            body, randomizeBeforeSend: false, saveHistory: true,
          });
          Object.assign(session, retry.captured);
          persistSessions();
          setRow(session.bankCode ? "ok" : "warn",
            retry.status + " " + describeResult(retry)
            + (session.bankCode ? "  ·  found on retry " + attempt : "  ·  still empty"));
        }
      }
    } catch (error) {
      setRow("fail", String(error.message || error));
      failed = true;
      if (options.stopOnFail) break;
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const summary = document.createElement("div");
  summary.className = "runsummary " + (failed || runCancelled ? "is-bad" : "is-ok");
  summary.textContent = (runCancelled ? "Cancelled after " : failed ? "Finished with failures — " : "All modules passed — ")
    + done + "/" + state.boot.features.length + " modules in " + seconds + "s"
    + (session.userId ? "  ·  userId " + session.userId : "")
    + (session.cardApplyNo ? "  ·  cardApplyNo " + session.cardApplyNo : "");
  host.appendChild(summary);
  if (scope === sessionKey()) renderSession();
  return { ok: !failed, done: done, total: state.boot.features.length };
}

function describeResult(result) {
  const body = result.responseBody;
  if (body && typeof body === "object" && body.response && body.response.description) {
    return body.response.description;
  }
  return result.reason || "";
}

function setRowText(result) {
  return result.status + " " + describeResult(result);
}

async function runAll() {
  const host = $("#runProgress");
  host.innerHTML = "";
  runCancelled = false;
  $("#btnRunAll").disabled = true;
  $("#btnRunCancel").disabled = false;

  const options = {
    physical: $("#runPhysical").checked,
    stopOnFail: $("#runStopOnFail").checked,
    settle: Math.max(0, Number($("#runSettle").value) || 0),
  };
  const chosen = runTarget();
  const versions = $("#runBoth").checked
    ? state.boot.targets.find((t) => t.key === chosen.target).versions.map((v) => v.key)
    : [chosen.version];

  let allOk = true;
  for (const version of versions) {
    if (runCancelled) break;
    const outcome = await runAllForTarget(chosen.target, version, options, host);
    allOk = allOk && outcome.ok;
  }

  $("#btnRunAll").disabled = false;
  $("#btnRunCancel").disabled = true;
  $("#btnRunClear").disabled = false;
  $("#runAllNote").textContent = runCancelled ? "Cancelled."
    : allOk ? "Done — every module passed." : "Done — some modules failed, see above.";
  toast(runCancelled ? "Run cancelled" : allOk ? "Run All finished — everything passed"
    : "Run All finished with failures", 6000);
  loadRecords().catch(() => {});
}

/* The run has its own target, so you can fire a V2 run without disturbing the module
   page you were on. Every affiliate x version is offered, including ones that still
   need credentials - those are marked rather than hidden. */
function runTarget() {
  if (!state.runTarget) state.runTarget = { target: state.target, version: state.version };
  return state.runTarget;
}

function paintRunTarget() {
  const chosen = runTarget();
  const both = $("#runBoth").checked;
  const host = $("#runAllTarget");
  host.innerHTML = "";

  state.boot.targets.forEach((target) => {
    target.versions.forEach((version) => {
      const configured = version.accessKey && version.accessKey !== "CHANGE_ME";
      const active = target.key === chosen.target
        && (both ? true : version.key === chosen.version);
      const button = document.createElement("button");
      button.className = "pill" + (active ? " is-on" : "") + (configured ? "" : " pill--todo");
      button.textContent = target.label + " · " + version.key;
      button.title = configured
        ? "Run every module against " + target.label + " " + version.key
        : "No access key configured yet for " + target.label + " " + version.key
          + " — add it in Settings, then this becomes runnable";
      button.onclick = () => {
        state.runTarget = { target: target.key, version: version.key };
        state.runTargetPinned = true;     // stop following the module pages' selection
        paintRunTarget();
      };
      host.appendChild(button);
    });
  });

  const current = state.boot.targets.find((t) => t.key === chosen.target);
  $("#runAllNote").textContent = both
    ? "Will run every module for " + (current ? current.label : chosen.target) + " V1, then again for V2."
    : "Will run every module for " + (current ? current.label : chosen.target) + " " + chosen.version + ".";
}

/* --------------------------------------------------- portal card source */
/* Card Registration needs a real plastic card. Pull one straight from the QA portal's
   Test Data -> Card Data for the project that matches the selected webview version. */
async function fetchPortalCard(silent) {
  if (!state.featureMeta || !state.featureMeta.cardSource) return;
  if (!commitView()) return;
  $("#btnFetchCard").disabled = true;
  $("#requestNote").textContent = "Fetching an ACTIVE card from the portal…";
  try {
    const result = await api("/api/card-source", { target: state.target, version: state.version });
    if (!result.ok) {
      $("#requestNote").textContent = "Portal card fetch failed — " + result.error;
      if (!silent) toast("Portal: " + result.error, 7000);
      return;
    }
    Object.entries(result.fields).forEach(([path, value]) => {
      if (value !== "") setPath(state.body, path, value);
    });
    paintBody();
    const source = result.source || {};
    $("#requestNote").textContent = "Card from " + source.project + " — "
      + Object.entries(result.fields).map(([k, v]) => k + "=" + v).join("  ")
      + "   (" + source.usableCards + " unused of " + source.totalCards + ")";
    if (!silent) toast("Filled from portal: " + (result.fields.physicalCardNo || ""));
  } catch (error) {
    $("#requestNote").textContent = "Portal card fetch failed — " + error.message;
    if (!silent) toast(String(error), 6000);
  } finally {
    $("#btnFetchCard").disabled = false;
  }
}

/* ------------------------------------------------------------- records */
let recordRows = [];

const RECORD_COLUMNS = [
  ["registeredAt", "Registered"], ["affiliate", "Affiliate"], ["version", "WV"],
  ["userId", "User ID"], ["loginId", "Login ID"], ["cardApplyNo", "Card Apply No"],
  ["mobileCardNo", "Mobile Card No"], ["physicalCardNo", "Physical Card No"], ["cardType", "Card Type"],
];

/* What a ledger row still needs, and which module does it. */
function nextStepFor(row) {
  if (row.cardType === "No card") {
    return { feature: "apply_card", label: "Apply card" };
  }
  if (row.cardType === "Mobile / Virtual Card") {
    return { feature: "card_registration", label: "Register card" };
  }
  return null;
}

/* Jump to that module with THIS row's user loaded, not whatever was last used. */
async function continueFromRecord(row, feature) {
  const scope = row.target + "|" + row.version;
  const carried = {};
  ["userId", "loginId", "email", "mobileNumber", "cardApplyNo", "mobileCardNo"].forEach((key) => {
    if (row[key] !== null && row[key] !== undefined && row[key] !== "") carried[key] = row[key];
  });
  state.sessions[scope] = carried;        // deliberate: this row's user becomes the active one
  persistSessions();

  state.feature = feature;
  await selectTarget(row.target, row.version);
  showPage("flow");
  toast("Loaded user " + row.userId + " (" + row.affiliate + " " + row.version + ") — "
    + (feature === "apply_card" ? "apply a card for them" : "register the plastic card"), 6000);
}

function labelClass(cardType) {
  if (cardType === "Physical / Plastic Card") return "lbl lbl--physical";
  if (cardType === "Mobile / Virtual Card") return "lbl lbl--virtual";
  return "lbl lbl--none";
}

async function loadRecords() {
  const data = await api("/api/records");
  recordRows = data.rows;
  const s = data.summary;
  const stats = [
    ["", s.users, "Users Registered"],
    ["", s.applied, "Cards Applied"],
    ["stat--virtual", s.virtual, "Mobile / Virtual"],
    ["stat--physical", s.physical, "Physical / Plastic"],
  ];
  $("#recordStats").innerHTML = stats.map(([extra, count, label]) =>
    '<span class="stat ' + extra + '"><b>' + count + "</b>" + label + "</span>").join("");
  renderRecords();
}

function renderRecords() {
  const needle = $("#recordFilter").value.trim().toLowerCase();
  const rows = needle
    ? recordRows.filter((row) => RECORD_COLUMNS.some(([key]) =>
        String(row[key] === null || row[key] === undefined ? "" : row[key]).toLowerCase().includes(needle)))
    : recordRows;

  const tbody = $("#recordsTable tbody");
  tbody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    RECORD_COLUMNS.forEach(([key]) => {
      const td = document.createElement("td");
      const value = row[key] === null || row[key] === undefined ? "" : String(row[key]);
      if (key === "cardType") {
        const span = document.createElement("span");
        span.className = labelClass(value);
        span.textContent = value;
        td.appendChild(span);
      } else if (key === "registeredAt") {
        td.textContent = value.replace("T", " ") || "—";
      } else {
        td.textContent = value || "—";
      }
      tr.appendChild(td);
    });

    const action = document.createElement("td");
    const next = nextStepFor(row);
    if (!next) {
      action.innerHTML = '<span class="done">Complete</span>';
    } else if (!row.target || !row.version) {
      action.innerHTML = '<span class="note">Unknown target</span>';
      action.title = "This record predates affiliate/version tracking, so it cannot be resumed";
    } else {
      const button = document.createElement("button");
      button.className = "btn btn--mini";
      button.textContent = next.label;
      button.title = "Open " + next.label.toLowerCase() + " for user " + row.userId
        + " on " + row.affiliate + " " + row.version;
      button.onclick = (event) => {
        event.stopPropagation();
        continueFromRecord(row, next.feature);
      };
      action.appendChild(button);
    }
    tr.appendChild(action);

    tr.title = "Service ID: " + (row.serviceId || "—")
      + "  ·  Delivery: " + (row.isDeliveryRequired === null ? "—" : row.isDeliveryRequired)
      + "  ·  Basic Card: " + (row.basicCardNo || "—")
      + (row.cardRegisteredAt ? "  ·  Registered: " + row.cardRegisteredAt.replace("T", " ") : "");
    tbody.appendChild(tr);
  });
  const pending = rows.filter(nextStepFor).length;
  $("#recordsNote").textContent = rows.length + " of " + recordRows.length
    + " row(s) — one per card application; a user with no application still gets a row."
    + (pending ? "  " + pending + " row(s) have a next step — the button opens that module with "
        + "that user loaded, on their own affiliate and version." : "")
    + "  Hover a row for Service ID, Delivery flag and Basic Card number.";
}

function recordsCsv() {
  const escape = (value) => '"' + String(value === null || value === undefined ? "" : value).replace(/"/g, '""') + '"';
  const extra = [["serviceId", "Service ID"], ["isDeliveryRequired", "Delivery Required"],
                 ["basicCardNo", "Basic Card No"], ["email", "Email"], ["mobileNumber", "Mobile"],
                 ["cardRegisteredAt", "Card Registered At"]];
  const columns = RECORD_COLUMNS.concat(extra);
  const lines = [columns.map(([, title]) => escape(title)).join(",")];
  recordRows.forEach((row) => lines.push(columns.map(([key]) => escape(row[key])).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "kona-webview-records-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "") + ".csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ------------------------------------------------------------- settings */
async function loadConfig() {
  const data = await api("/api/config");
  $("#configRaw").value = data.raw;
  $("#configNote").textContent = "";
}

/* ------------------------------------------------------------- theme */
const THEME_STORE = "konaTheme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function savedTheme() {
  try {
    return localStorage.getItem(THEME_STORE);
  } catch (error) {
    return null;
  }
}

/* persist only on a deliberate choice, so an unset preference keeps following the OS */
function applyTheme(theme, persist) {
  document.documentElement.setAttribute("data-theme", theme);
  /* the button advertises what clicking it will DO, not the current state */
  $("#themeIcon").textContent = theme === "dark" ? "☀" : "☾";
  $("#themeLabel").textContent = theme === "dark" ? "Light" : "Dark";
  $("#themeToggle").title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  if (persist) {
    try {
      localStorage.setItem(THEME_STORE, theme);
    } catch (error) { /* storage blocked - theme just will not persist */ }
  }
}

/* ------------------------------------------------------------- wiring */
function showPage(page) {
  $$(".page").forEach((node) => node.classList.add("is-hidden"));
  $("#page-" + page).classList.remove("is-hidden");
  $$(".nav__item[data-page]").forEach((node) => node.classList.toggle("is-active", node.dataset.page === page));
  $$(".nav__item[data-feature]").forEach((node) =>
    node.classList.toggle("is-active", page === "flow" && node.dataset.feature === state.feature));
  const crumb = $(".crumb");
  if (page === "flow") {
    $("#pageTitle").textContent = state.featureMeta.label.toUpperCase();
    crumb.textContent = "Modules / " + state.featureMeta.label;
  } else if (page === "runall") {
    $("#pageTitle").textContent = "RUN ALL MODULES";
    crumb.textContent = "Every module in order, on one freshly created user";
    /* mirror whatever target the module pages are on, until you pick one here */
    if (!state.runTargetPinned) state.runTarget = { target: state.target, version: state.version };
    paintRunTarget();
  } else if (page === "records") {
    $("#pageTitle").textContent = "RECORDS";
    crumb.textContent = "Registered users, applied cards and card type";
    loadRecords();
  } else if (page === "history") {
    $("#pageTitle").textContent = "HISTORY";
    crumb.textContent = "Saved request + response records";
    loadHistory();
  } else {
    $("#pageTitle").textContent = "SETTINGS";
    crumb.textContent = "config.json — targets · bodies · overrides · random rules";
    loadConfig();
  }
}

function switchView(view) {
  if (!commitView()) return;
  state.view = view;
  $$(".tabs .tab[data-view]").forEach((node) => node.classList.toggle("is-active", node.dataset.view === view));
  ["form", "json", "headers"].forEach((name) => {
    $("#view-" + name).classList.toggle("is-hidden", name !== view);
  });
  if (view === "form") renderForm();
  if (view === "json") $("#jsonBody").value = JSON.stringify(state.body, null, 4);
}

function wire() {
  $$(".nav__item[data-page]").forEach((node) => { node.onclick = () => showPage(node.dataset.page); });
  $$(".tabs .tab[data-view]").forEach((node) => { node.onclick = () => switchView(node.dataset.view); });
  $$(".tabs .tab[data-rview]").forEach((node) => {
    node.onclick = () => {
      $$(".tabs .tab[data-rview]").forEach((t) => t.classList.toggle("is-active", t === node));
      ["body", "headers", "sent", "curl"].forEach((name) => {
        $("#out-" + name).classList.toggle("is-hidden", name !== node.dataset.rview);
      });
    };
  });

  ["baseUrl", "aspId", "path"].forEach((id) => { $("#" + id).oninput = paintEnv; });
  $("#formFields").addEventListener("input", () => { state.body = readForm(); });

  $("#btnSend").onclick = send;
  $("#btnPing").onclick = async () => {
    const result = await pingHost();
    if (result) toast(result.ok ? "Reachable — " + result.detail : "Not reachable — " + result.detail);
  };

  $("#btnRandom").onclick = async () => {
    if (!commitView()) return;
    const data = await api("/api/randomize", { feature: state.feature, body: state.body });
    state.body = data.body;
    paintBody();
    const generated = Object.entries(data.generated).map(([k, v]) => k + "=" + v).join("   ");
    toast(generated || "Nothing is marked for randomization on this module", 5000);
  };

  $("#btnReset").onclick = async () => { await loadFeature(state.feature); toast("Body reloaded from config.json"); };

  $("#btnCurl").onclick = async () => {
    if (!commitView()) return;
    const data = await api("/api/preview", requestPayload());
    await navigator.clipboard.writeText(data.curl);
    $("#out-curl").textContent = data.curl;
    toast("cURL copied to clipboard");
  };

  $("#btnSaveBody").onclick = async () => {
    if (!commitView()) return;
    const data = await api("/api/save-body", {
      feature: state.feature, target: state.target, version: state.version,
      scope: "override", body: state.body,
    });
    toast("Saved: " + data.saved);
  };

  $("#btnSaveDefault").onclick = async () => {
    if (!commitView()) return;
    const data = await api("/api/save-body", { feature: state.feature, scope: "default", body: state.body });
    toast("Saved: " + data.saved + " (applies to every affiliate and version)");
  };

  $("#btnSaveConn").onclick = async () => {
    const data = await api("/api/save-connection", {
      target: state.target, version: state.version, feature: state.feature,
      baseUrl: $("#baseUrl").value, aspId: $("#aspId").value,
      accessKey: $("#accessKey").value, path: $("#path").value,
    });
    state.boot = (await api("/api/bootstrap"));
    toast("Saved: " + data.saved);
  };

  $("#btnCopySession").onclick = () => {
    navigator.clipboard.writeText(JSON.stringify(currentSession(), null, 2));
    toast("Session copied for " + sessionKey().replace("|", " "));
  };
  $("#btnLoadSession").onclick = async () => {
    await seedSessionFromHistory(true);
    if (state.featureMeta) renderForm();        // refresh the resolved {{placeholder}} tags
  };
  $("#btnClearSession").onclick = () => {
    state.sessions[sessionKey()] = {};
    persistSessions();
    renderSession();
  };
  $("#btnClearAllSessions").onclick = () => {
    state.sessions = {};
    persistSessions();
    renderSession();
    toast("Cleared every target's session");
  };

  $("#btnRefreshHistory").onclick = loadHistory;
  applyTheme(currentTheme(), false);
  $("#themeToggle").onclick = () => applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  /* follow the OS only while the user has not made a choice of their own */
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      if (!savedTheme()) applyTheme(event.matches ? "dark" : "light", false);
    });
  }

  $("#btnRunAll").onclick = runAll;
  $("#btnRunCancel").onclick = () => {
    runCancelled = true;
    $("#runAllNote").textContent = "Cancelling after the current request…";
  };
  $("#runBoth").onchange = paintRunTarget;
  $("#btnRunClear").onclick = async () => {
    $("#runProgress").innerHTML = "";
    $("#btnRunClear").disabled = true;
    state.boot = await api("/api/bootstrap");     // pick up credentials added in Settings meanwhile
    paintRunTarget();
    toast("Results cleared — ready for another run");
  };

  $("#btnFetchCard").onclick = () => fetchPortalCard(false);
  $("#btnRefreshRecords").onclick = loadRecords;
  $("#btnRecordsCsv").onclick = recordsCsv;
  $("#recordFilter").oninput = () => {
    $("#recordFilterClear").classList.toggle("is-hidden", !$("#recordFilter").value);
    renderRecords();
  };
  $("#recordFilterClear").onclick = () => {
    $("#recordFilter").value = "";
    $("#recordFilterClear").classList.add("is-hidden");
    renderRecords();
    $("#recordFilter").focus();
  };
  $("#recordFilter").onkeydown = (event) => {
    if (event.key === "Escape") $("#recordFilterClear").click();
  };

  $("#btnSaveConfig").onclick = async () => {
    try {
      const data = await api("/api/config/save", { raw: $("#configRaw").value });
      state.boot = data.bootstrap;
      $("#configNote").textContent = "Saved";
      renderTargets();
      await loadFeature(state.feature);
      toast("config.json saved and reloaded");
    } catch (error) {
      $("#configNote").textContent = String(error);
      toast("Not saved — " + error.message, 6000);
    }
  };

  $("#btnReloadConfig").onclick = async () => {
    const data = await api("/api/config/reload", {});
    state.boot = data.bootstrap;
    await loadConfig();
    renderTargets();
    await loadFeature(state.feature);
    toast("Reloaded from disk");
  };

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); send(); }
  });
}

/* ------------------------------------------------------------- start */
(async function start() {
  const boot = await discoverApi();
  if (!boot) {
    showApiBanner();
    return;
  }
  try {
    state.boot = boot;
    state.feature = state.boot.features[0].key;
    loadSessions();
    $("#envApi").textContent = API_BASE ? API_BASE.replace(/^https?:\/\//, "") : location.host + " (same origin)";
    $("#dotApi").className = "dot";
    wire();
    await selectTarget(state.boot.targets[0].key, null);
    renderSession();
  } catch (error) {
    $(".content").innerHTML = '<div class="banner"><b>Failed to start.</b><br><br><code>'
      + String(error) + "</code></div>";
  }
})();

})();
