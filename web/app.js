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
  portalProjects: {},  /* keyed by affiliate - only the projects that affiliate's ASP owns */
  runModules: {},      /* Run All: feature key -> ticked; absent means ticked */
  runPhysical: true,   /* Run All: Apply Card issues a physical (delivery) card */
  view: "form",
  busy: false,
};

const SESSION_STORE = "konaSessions";

function sessionKey() {
  return state.target + "|" + state.version;
}

/* Long captured values (cardApplyNo, ci, par, tokens) are shown with their middle removed, so a
   label stays one line and still identifies the value: CA20261116135151600472 reads as
   CA2026111...600472. Both ends are kept because that is what people check. Display only -
   what gets SENT is never touched, and the full text is always on the element's tooltip. */
const SHORT_MAX = 16;

function shorten(value, max) {
  const text = value === null || value === undefined ? "" : String(value);
  const limit = max || SHORT_MAX;
  if (text.length <= limit) return text;
  const head = Math.ceil((limit - 1) * 0.6);
  return text.slice(0, head) + "…" + text.slice(text.length - (limit - 1 - head));
}

/* true when shorten() would actually cut something - used to decide whether a tooltip is worth it */
function isLong(value, max) {
  return String(value === null || value === undefined ? "" : value).length > (max || SHORT_MAX);
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

/* ------------------------------------------------------------- the session */
const TOKEN_KEY = "konaSession";
const USER_KEY = "konaUser";

function sessionToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (error) { return ""; }
}

function signedInUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (error) { return null; }
}

/* The server answers 401 to every data endpoint without a live session. When that happens the
   token is stale, so clear it and go back to the gate rather than showing an empty console. */
function toGate(why) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (error) { /* storage blocked */ }
  const base = location.pathname.replace(/[^/]*$/, "");
  location.href = base + "login.html" + (why ? "?why=" + encodeURIComponent(why) : "");
}

async function api(path, payload) {
  const headers = { "X-Kona-Session": sessionToken() };
  let options;
  if (payload === undefined) {
    options = { method: "GET", headers };
  } else {
    headers["Content-Type"] = "application/json";
    options = { method: "POST", headers, body: JSON.stringify(payload) };
  }
  const response = await fetch(API_BASE + path, options);
  const data = await response.json().catch(() => ({ error: "server returned non-JSON" }));
  if (response.status === 401 || data.signedOut) {
    toGate("expired");
    throw new Error("Your session has ended - signing in again.");
  }
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

async function probeApi(base) {
  try {
    const response = await fetch(base + "/api/bootstrap", {
      method: "GET", headers: { "X-Kona-Session": sessionToken() },
    });
    if (response.status === 401) return "signedout";
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
    if (boot === "signedout") {        /* the server is there, we are just not signed in */
      API_BASE = base;
      return "signedout";
    }
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

const CUSTOM_OPTION = "__custom__";

/* Replace the serviceId dropdown with a plain text box when "Custom…" is chosen,
   keeping the same data-path so readForm() still finds exactly one field. */
function swapToFreeText(select, row) {
  const input = document.createElement("input");
  input.className = select.className;
  input.dataset.path = select.dataset.path;
  input.dataset.type = select.dataset.type;
  input.spellcheck = false;
  input.placeholder = "Type a serviceId";
  input.value = "";
  select.replaceWith(input);
  input.focus();
  state.body = readForm();
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
      const values = refs.map((name) => shorten(session[name])).join(", ");
      /* the warning is kept to two words so it cannot crowd out the field name - the whole
         explanation is on the tooltip */
      tag.textContent = resolved ? "→ " + values : "No value yet";
      /* the tag is ellipsised when the value is long, so keep the whole thing on hover */
      tag.title = resolved
        ? refs.map((n) => n + " = " + session[n]).join("   ·   ")
        : "Nothing captured for " + refs.join(", ") + " on " + state.target + " "
          + state.version + " yet - run the module that produces it first";
      label.appendChild(tag);
    }

    wrap.appendChild(label);

    /* config.json -> features.<x>.options.<path> turns a field into a picker;
       a loaded portal project supplies the serviceId list instead */
    let choices = ((state.featureMeta && state.featureMeta.options) || {})[row.path];
    /* a loaded portal project turns serviceId into a real dropdown of that project's
       card services, so you pick one rather than remembering the number */
    let asDropdown = false;
    if (row.path.split(".").pop() === "serviceId") {
      const portal = serviceChoices();
      if (portal) {
        /* a loaded project decides the list outright - these are its services, nobody else's */
        choices = portal;
        asDropdown = true;
      } else if (choices) {
        /* no project loaded yet: config.json's samples, minus any that belong to another
           affiliate's ASP, so Burger King's id never shows up on an iKuka form */
        const mine = choices.filter((choice) => belongsToAffiliate(choice.value));
        choices = mine.length ? mine : null;
      }
    }

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
    } else if (choices && asDropdown && row.type !== "json") {
      /* a dropdown of the project's card services, plus whatever is currently in the body
         and a Custom… escape hatch so an unlisted id can still be typed */
      input = document.createElement("select");
      const seen = [];
      choices.forEach((choice) => {
        const node = document.createElement("option");
        node.value = String(choice.value);
        node.textContent = choice.label || String(choice.value);
        if (choice.title) node.title = choice.title;
        seen.push(node.value);
        input.appendChild(node);
      });
      if (!seen.includes(String(row.value))) {
        const node = document.createElement("option");
        node.value = String(row.value);
        node.textContent = String(row.value);
        node.title = "Not one of this project's card services";
        input.insertBefore(node, input.firstChild);
      }
      const custom = document.createElement("option");
      custom.value = CUSTOM_OPTION;
      custom.textContent = "Custom…";
      input.appendChild(custom);
      input.value = String(row.value);
      input.addEventListener("change", (event) => {
        if (event.target.value === CUSTOM_OPTION) swapToFreeText(event.target, row);
      });
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
  // a bank with a loop around it - an account that tops itself up
  auto_recharge_bank_registration:
    '<path d="M3.4 9.4 11 5.2l7.6 4.2"/><path d="M5.8 11v5.4M10 11v5.4M14.2 11v3.2"/>'
    + '<path d="M3.6 18.4h8.6"/>'
    + '<path d="M15.6 18.4a3.6 3.6 0 1 0-1.4-4.6"/><path d="M14 11.4v2.6h2.6"/>',
  // the same bank, with two arrows swapping - moving the recharge to another account
  auto_recharge_bank_registration_change_account:
    '<path d="M3.4 9.4 11 5.2l7.6 4.2"/><path d="M5.8 11v4.6M10 11v4.6"/>'
    + '<path d="M3.6 17.6h7.4"/>'
    + '<path d="M14.4 14.2h6.2l-1.8-1.9M20.6 18.2h-6.2l1.8 1.9"/>',
};
const FALLBACK_ICON = '<circle cx="12" cy="12" r="3.4"/>';

function iconSvg(paths) {
  return '<svg class="nav__svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + paths + "</svg>";
}

/* A module can have variants: separate features, each with its own endpoint, body and overrides,
   that share one page. Bank Account Registration has two - Auto Recharge and Auto Recharge-
   Change Account - and switching between them loads that variant's own request. Nothing is
   shared or merged: they are three distinct cURLs that happen to live behind one sidebar entry. */
function featureGroup(key) {
  const features = (state.boot || {}).features || [];
  const meta = features.find((f) => f.key === key);
  if (!meta) return null;
  const parentKey = meta.parent || key;
  const children = features.filter((f) => f.parent === parentKey);
  if (!children.length) return null;
  const parent = features.find((f) => f.key === parentKey);
  return parent ? [parent].concat(children) : null;
}

/* the sidebar entry a page belongs to - a variant highlights its parent */
function navKeyFor(key) {
  const meta = ((state.boot || {}).features || []).find((f) => f.key === key);
  return (meta && meta.parent) || key;
}

/* A feature can carry a tooltip in config.json - lines of free text, such as the test bank
   account a variant expects. Shown on hover wherever that module is offered. */
/* What a module counts AS, so the run loop treats a variant like the module it sits under:
   an Apply Card variant still gets isDeliveryRequired, a Bank Account Registration variant
   still gets the settle pause. The server decides the role; this reads it. */
function roleOf(key) {
  const feature = ((state.boot || {}).features || []).find((f) => f.key === key);
  return (feature && (feature.role || feature.parent)) || key;
}

function featureTooltip(feature) {
  const own = feature.tooltip;
  const text = Array.isArray(own) ? own.join("\n") : (own || "");
  if (text.trim()) return text;
  return feature.label + " - its own endpoint, body and test case IDs";
}

function paintVariants() {
  const row = $("#variantRow"), note = $("#variantNote");
  const group = featureGroup(state.feature);
  row.classList.toggle("is-hidden", !group);
  note.classList.toggle("is-hidden", !group);
  if (!group) return;

  const host = $("#variantPills");
  host.innerHTML = "";
  group.forEach((feature) => {
    const button = document.createElement("button");
    button.className = "pill" + (feature.key === state.feature ? " is-on" : "");
    button.textContent = feature.label;
    button.title = featureTooltip(feature);
    if (feature.tooltip && feature.tooltip.length) button.classList.add("pill--hint");
    button.onclick = () => { if (feature.key !== state.feature) loadFeature(feature.key); };
    host.appendChild(button);
  });
  note.textContent = group.length + " separate requests share this page. Each keeps its own "
    + "endpoint, body and overrides - switching here loads that one, nothing is carried over.";
}

/* the Modules group in the sidebar - one entry per feature, in config order */
function renderModuleNav() {
  const host = $("#moduleNav");
  host.innerHTML = "";
  const connection = currentConnection();
  const active = navKeyFor(state.feature);
  state.boot.features.filter((feature) => !feature.parent).forEach((feature) => {
    const configured = !!(connection.endpoints || {})[feature.key];
    const button = document.createElement("button");
    button.className = "nav__item nav__item--sub"
      + (feature.key === active && !$("#page-flow").classList.contains("is-hidden") ? " is-active" : "")
      + (configured ? "" : " is-todo");
    button.dataset.feature = feature.key;
    const group = featureGroup(feature.key);
    button.title = (configured ? feature.label : feature.label + " - no endpoint configured yet")
      + (group ? "  ·  " + (group.length - 1) + " more request(s) on this page: "
        + group.slice(1).map((f) => f.label).join(", ") : "");
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
  const project = currentProject();
  $("#baseUrl").value = connection.baseUrl || "";
  $("#aspId").value = (project && project.aspId) || connection.aspId || "";
  $("#accessKey").value = (project && project.accessKey) || connection.accessKey || "";
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
  paintProject();
  ensureProjectList(state.target, state.version);   /* that affiliate's projects only */
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
  paintVariants();
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
    projectName: (currentProject() || {}).projectName || "",
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
    chip.title = key + " = " + text + "  ·  click to copy {{" + key + "}}";
    chip.innerHTML = "<b>" + key + "</b>  " + shorten(text, 24);
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
      + "<td>" + (row.projectName || "—") + "</td>"
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

/* ------------------------------------------------------- portal project */
/* A project name is remembered per affiliate x version, alongside what the portal told us
   about it: the ASP ID, the OASL access key and the card services. Nothing here changes how
   a module behaves when no project is loaded - the config values stay in charge. */
const PROJECT_STORE = "konaProjects";
const PROJECT_OWNER = "konaProjectsFor";       /* the sign-in those loaded projects belong to */

/* A loaded project survives a reload within one sign-in, but a NEW sign-in starts clean: every
   Project box shows its placeholder until something is picked and loaded. Nothing else changes -
   the project is still kept per affiliate x version, and with none loaded the ASP ID, access key
   and serviceId come from config.json exactly as they always have. */
function loadProjects() {
  try {
    if (localStorage.getItem(PROJECT_OWNER) !== sessionToken()) {
      state.projects = {};
      localStorage.removeItem(PROJECT_STORE);
      localStorage.setItem(PROJECT_OWNER, sessionToken());
      return;
    }
    state.projects = JSON.parse(localStorage.getItem(PROJECT_STORE) || "{}");
  } catch (error) {
    state.projects = {};
  }
}

function persistProjects() {
  try {
    localStorage.setItem(PROJECT_STORE, JSON.stringify(state.projects || {}));
    localStorage.setItem(PROJECT_OWNER, sessionToken());
  } catch (error) { /* storage blocked */ }
}

function currentProject() {
  return (state.projects || {})[sessionKey()] || null;
}

/* The ASP code of the selected affiliate, from the header field or config.json. A service id
   opens with its owner's ASP code, which is what keeps one affiliate's ids off another's form. */
function selectedAspCode() {
  const header = ($("#aspId") ? $("#aspId").value : "").trim();
  const fallback = (currentConnection() || {}).aspId || "";
  const value = /^\d{6,}$/.test(header) ? header : String(fallback || "");
  return /^\d{6,}$/.test(value) ? value.slice(0, 6) : "";
}

function belongsToAffiliate(serviceId) {
  const code = selectedAspCode();
  const id = String(serviceId || "").trim();
  if (!code || !/^\d{6,}$/.test(id)) return true;     // nothing to judge it by - leave it alone
  return id.slice(0, 6) === code;
}

/* serviceId choices for the selected target: the portal's services when a project is
   loaded, otherwise whatever config.json offers for THIS affiliate. */
function serviceChoices() {
  const project = currentProject();
  if (!project || !(project.services || []).length) return null;
  /* label is the bare id: it is what gets sent, and showing anything else invites doubt.
     The service name lives in the option's tooltip instead. */
  return project.services.map((service) => ({
    value: service.serviceId,
    label: service.serviceId,
    title: service.name || "",
  }));
}

const CUSTOM_PROJECT = "__custom__";

/* Which affiliate a project (and so a service id) belongs to is decided by its ASP, not by its
   name: 'P1-P2-Tim Hortons-V1' is a Burger King project. The server classifies them, we only
   ever show the selected affiliate's own. */
function affiliateProjects(target) {
  return (state.portalProjects || {})[target] || null;
}

async function ensureProjectList(target, version, refresh) {
  if (!refresh && affiliateProjects(target)) return affiliateProjects(target);
  const entry = { loading: true, projects: [], error: "" };
  state.portalProjects[target] = entry;
  fillProjectPicks();
  try {
    const result = await api("/api/portal-projects", { target, version, refresh: !!refresh });
    state.portalProjects[target] = result.ok
      ? { projects: result.projects || [], filtered: result.filtered, note: result.note || "",
          aspId: result.aspId || "" }
      : { projects: [], error: result.error || "Could not read the portal project list" };
  } catch (error) {
    state.portalProjects[target] = { projects: [], error: String(error.message || error) };
  }
  fillProjectPicks();
  return affiliateProjects(target);
}

/* Fills one <select> with the affiliate's projects. The matching hidden <input> stays the single
   source of truth for the name, so everything downstream of it is untouched. */
function fillProjectPick(selectId, inputId, target, label) {
  const select = $("#" + selectId);
  if (!select) return;
  const input = $("#" + inputId);
  const entry = affiliateProjects(target);
  const chosen = input.value.trim();
  select.innerHTML = "";

  const head = document.createElement("option");
  head.value = "";
  head.textContent = !entry ? "Loading " + label + "'s projects…"
    : entry.loading ? "Loading " + label + "'s projects…"
    : entry.error ? "Portal list unavailable — use Other project…"
    : entry.projects.length ? "Select a project for " + label + "…"
    : "No project on the portal for " + label;
  select.appendChild(head);

  const names = [];
  ((entry && entry.projects) || []).forEach((project) => {
    const node = document.createElement("option");
    node.value = project.name;
    node.textContent = project.name;
    node.title = "ASP " + project.aspId + " · " + project.projectId
      + (project.projectStatus ? " · " + project.projectStatus : "");
    names.push(project.name);
    select.appendChild(node);
  });

  if (chosen && !names.includes(chosen)) {      // typed by hand, or loaded before the list arrived
    const node = document.createElement("option");
    node.value = chosen;
    node.textContent = chosen;
    select.insertBefore(node, select.firstChild.nextSibling);
  }

  const custom = document.createElement("option");
  custom.value = CUSTOM_PROJECT;
  custom.textContent = "Other project…";
  select.appendChild(custom);

  select.value = input.hidden ? chosen : CUSTOM_PROJECT;
}

function fillProjectPicks() {
  fillProjectPick("projectPick", "projectName", state.target, affiliateLabel(state.target));
  const run = typeof runTarget === "function" ? runTarget() : null;
  if (run) fillProjectPick("runProjectPick", "runProjectName", run.target, affiliateLabel(run.target));
}

function affiliateLabel(target) {
  const found = ((state.boot || {}).targets || []).find((t) => t.key === target);
  return found ? found.label : target || "this affiliate";
}

/* A pick either names a project or switches that row to free text. */
function onProjectPick(selectId, inputId, onLoad) {
  const select = $("#" + selectId);
  const input = $("#" + inputId);
  select.onchange = () => {
    if (select.value === CUSTOM_PROJECT) {
      input.hidden = false;
      input.value = "";
      input.focus();
      return;
    }
    input.hidden = true;
    input.value = select.value;
    if (select.value) onLoad();
  };
}

function paintProject() {
  const project = currentProject();
  $("#projectName").value = project ? project.projectName : "";
  $("#projectName").hidden = true;
  fillProjectPick("projectPick", "projectName", state.target, affiliateLabel(state.target));
  if (!project) {
    $("#projectNote").textContent = "Type a project name and load it: the ASP ID and Access Key "
      + "below are filled from that project, and its card services become the serviceId choices "
      + "on Apply Card.";
    return;
  }
  $("#projectNote").textContent = "Loaded " + project.projectName + " (" + project.projectId + ")"
    + " · ASP " + project.aspId + " · " + project.keyType + " key"
    + " · " + (project.services || []).length + " card service(s)"
    + (project.warnings && project.warnings.length ? "  ⚠ " + project.warnings.join(" ") : "");
}

/* Shared by the module pages and Run All: look a project up and store it against a scope. */
async function lookupProjectInto(scope, name) {
  /* the scope is "TARGET|VERSION": the server uses it to refuse a project from another ASP */
  const [target, version] = scope.split("|");
  const result = await api("/api/project-lookup", { projectName: name, target, version });
  if (!result.ok) return result;
  state.projects = state.projects || {};
  const previous = state.projects[scope] || {};
  /* keep a service the user already chose, if this project still offers it */
  const offered = (result.services || []).map((service) => service.serviceId);
  if (previous.chosenServiceId && offered.includes(previous.chosenServiceId)) {
    result.chosenServiceId = previous.chosenServiceId;
  }
  state.projects[scope] = result;
  persistProjects();
  return result;
}

async function loadProjectFromPortal() {
  const name = $("#projectName").value.trim();
  if (!name) {
    toast("Type the project name first");
    return;
  }
  const scope = sessionKey();
  $("#btnLoadProject").disabled = true;
  $("#projectNote").textContent = "Signing in to the portal and looking up " + name + "…";
  try {
    const result = await lookupProjectInto(scope, name);
    if (!result.ok) {
      $("#projectNote").textContent = "Not loaded — " + result.error;
      toast(result.error, 7000);
      return;
    }

    /* fill the two header fields this project dictates */
    $("#aspId").value = result.aspId || $("#aspId").value;
    $("#accessKey").value = result.accessKey || $("#accessKey").value;
    paintEnv();
    paintProject();
    if (state.featureMeta) renderForm();      // serviceId picker picks up the new choices
    toast("Loaded " + result.projectName + " — ASP " + result.aspId
      + ", " + result.keyType + " key, " + result.services.length + " service(s)", 6000);
  } catch (error) {
    $("#projectNote").textContent = "Not loaded — " + (error.message || error);
    toast(String(error), 6000);
  } finally {
    $("#btnLoadProject").disabled = false;
  }
}

/* ----------------------------------------------------------- run all */
/* Drives every module in order against one target, chaining the session as it goes.
   It reuses the same endpoints a manual run uses, so there is no second code path:
   the placeholder guard, the portal card fetch and the 003_027 retry all still apply. */
let runCancelled = false;
let runInProgress = false;      /* so a repaint cannot re-enable Run All mid-run */

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

/* The Run All page carries its own Project + Service ID, bound to the run target.
   Each affiliate x version keeps its own, so "run both versions" uses the right one for each. */
function runScope() {
  const chosen = runTarget();
  return chosen.target + "|" + chosen.version;
}

function paintRunProject() {
  const scope = runScope();
  const target = scope.split("|")[0];
  const project = (state.projects || {})[scope];
  $("#runProjectName").value = project ? project.projectName : "";
  $("#runProjectName").hidden = true;
  ensureProjectList(target, scope.split("|")[1]);
  fillProjectPick("runProjectPick", "runProjectName", target, affiliateLabel(target));

  const select = $("#runServiceId");
  select.innerHTML = "";
  const services = (project && project.services) || [];
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = "Choose Service ID";
  fallback.title = "Nothing chosen - the run falls back to the serviceId in config.json";
  select.appendChild(fallback);
  services.forEach((service) => {
    const node = document.createElement("option");
    node.value = service.serviceId;          // bare id - this is what gets sent
    node.textContent = service.serviceId;
    if (service.name) node.title = service.name;
    select.appendChild(node);
  });
  select.value = (project && project.chosenServiceId) || "";
  select.disabled = !services.length;

  $("#runProjectNote").textContent = project
    ? "Loaded " + project.projectName + " · ASP " + project.aspId + " · " + project.keyType
      + " key · " + services.length + " service(s). The run uses these instead of config.json"
      + (select.value ? ", applying cards on " + select.value + "." : ".")
    : "Optional. Without a project the run uses the ASP ID, access key and serviceId from "
      + "config.json, exactly as before.";
}

async function loadRunProject() {
  const name = $("#runProjectName").value.trim();
  if (!name) {
    toast("Type the project name first");
    return;
  }
  const scope = runScope();
  $("#btnRunLoadProject").disabled = true;
  $("#runProjectNote").textContent = "Signing in to the portal and looking up " + name + "…";
  try {
    const result = await lookupProjectInto(scope, name);
    if (!result.ok) {
      $("#runProjectNote").textContent = "Not loaded — " + result.error;
      toast(result.error, 7000);
      return;
    }
    paintRunTarget();
    if (scope === sessionKey()) {            // same target as the module pages - keep them in step
      $("#aspId").value = result.aspId || $("#aspId").value;
      $("#accessKey").value = result.accessKey || $("#accessKey").value;
      paintProject();
      paintEnv();
    }
    toast("Loaded " + result.projectName + " — ASP " + result.aspId + ", "
      + result.services.length + " service(s)", 6000);
  } catch (error) {
    $("#runProjectNote").textContent = "Not loaded — " + (error.message || error);
  } finally {
    $("#btnRunLoadProject").disabled = false;
  }
}

async function runAllForTarget(target, version, options, host) {
  const targetMeta = state.boot.targets.find((t) => t.key === target);
  const conn = targetMeta.versions.find((v) => v.key === version);
  const scope = target + "|" + version;
  /* a project loaded for this target supplies the ASP ID and access key; config is the fallback */
  const project = (state.projects || {})[scope] || null;
  const aspId = (project && project.aspId) || conn.aspId;
  const accessKey = (project && project.accessKey) || conn.accessKey;
  runHeading(host, targetMeta.label + "  ·  " + version
    + (project ? "  ·  " + project.projectName : ""));

  if (!accessKey || accessKey === "CHANGE_ME") {
    const row = runStepRow(host, "Credentials");
    row("fail", "No access key for this target — load a Project above, or set one in Settings");
    return { ok: false, done: 0, total: 0 };
  }

  const features = state.boot.features.filter((f) => options.modules.includes(f.key));

  /* Creating a user starts a clean slate for this target, otherwise a stale cardApplyNo from an
     earlier run could be carried into Card Registration. A selection WITHOUT User Registration
     is deliberately chaining onto the last run, so its session is kept. */
  if (options.modules.some((key) => roleOf(key) === "user_registration")) {
    state.sessions[scope] = {};
  }
  if (!state.sessions[scope]) state.sessions[scope] = {};
  const session = state.sessions[scope];
  const started = Date.now();
  let done = 0, failed = false;

  for (const feature of features) {
    if (runCancelled) break;
    const setRow = runStepRow(host, feature.label);
    try {
      const meta = await api("/api/body", { feature: feature.key, target, version });
      if (!meta.path) {
        setRow("skip", "No endpoint configured — skipped");
        continue;
      }

      const body = substituteSession(meta.body, session);
      if (roleOf(feature.key) === "apply_card") {
        body.isDeliveryRequired = !!options.physical;
        if (project && project.chosenServiceId) body.serviceId = project.chosenServiceId;
      }
      if (meta.cardSource) {
        setRow("busy", "Fetching an ACTIVE card from the portal…");
        const card = await api("/api/card-source", {
          target, version,
          projectName: project ? project.projectName : undefined,
          serviceId: (project && project.chosenServiceId) || undefined,
        });
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
        aspId: aspId, accessKey: accessKey,
        timeZone: $("#timeZone").value || "KST",
        timeout: Number($("#timeout").value) || 60,
        extraHeaders: "", useProxy: $("#useProxy").checked,
        projectName: (project || {}).projectName || "",
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
      if (roleOf(feature.key) === "bank_account_registration" && options.settle > 0) {
        setRow("ok", setRowText(result) + "  ·  settling " + options.settle + "s…");
        await sleep(options.settle * 1000);
        setRow("ok", setRowText(result));
      }
      /* ...and when it still is not, the inquiry answers 200 with every field null */
      if (roleOf(feature.key) === "bank_account_inquiry") {
        for (let attempt = 2; attempt <= 4 && !session.bankCode && !runCancelled; attempt += 1) {
          setRow("busy", "No bank account visible yet — retry " + attempt + " in "
            + Math.max(3, options.settle) + "s…");
          await sleep(Math.max(3, options.settle) * 1000);
          const retry = await api("/api/send", {
            feature: feature.key, target, version,
            baseUrl: conn.baseUrl, path: meta.path, method: meta.method,
            aspId: aspId, accessKey: accessKey,
            timeZone: $("#timeZone").value || "KST",
            timeout: Number($("#timeout").value) || 60,
            extraHeaders: "", useProxy: $("#useProxy").checked,
            projectName: (project || {}).projectName || "",
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
    + done + "/" + features.length + " modules in " + seconds + "s"
    + (session.userId ? "  ·  userId " + session.userId : "")
    + (session.cardApplyNo ? "  ·  cardApplyNo " + shorten(session.cardApplyNo) : "");
  summary.title = (session.userId ? "userId " + session.userId : "")
    + (session.cardApplyNo ? "   cardApplyNo " + session.cardApplyNo : "");
  host.appendChild(summary);
  if (scope === sessionKey()) renderSession();
  return { ok: !failed, done: done, total: features.length };
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
  runInProgress = true;
  $("#btnRunAll").disabled = true;
  $("#btnRunCancel").disabled = false;

  const modules = selectedModules();
  if (!modules.length) {
    $("#runAllNote").textContent = "Nothing selected - tick at least one module.";
    runInProgress = false;
    $("#btnRunAll").disabled = false;
    $("#btnRunCancel").disabled = true;
    return { ok: false, error: "No modules selected" };
  }
  const physicalBox = $("#runPhysical");
  const options = {
    modules: modules,
    physical: physicalBox ? physicalBox.checked : true,
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

  runInProgress = false;
  $("#btnRunAll").disabled = false;
  $("#btnRunCancel").disabled = true;
  $("#btnRunClear").disabled = false;
  const ran = modules.length === state.boot.features.length
    ? "every module" : "all " + modules.length + " selected modules";
  $("#runAllNote").textContent = runCancelled ? "Cancelled."
    : allOk ? "Done — " + ran + " passed." : "Done — some modules failed, see above.";
  toast(runCancelled ? "Run cancelled" : allOk ? "Run All finished — everything passed"
    : "Run All finished with failures", 6000);
  const session = state.sessions[chosen.target + "|" + versions[versions.length - 1]] || {};
  const outcome = {
    ok: allOk && !runCancelled, cancelled: runCancelled, modules: modules.length,
    versions: versions.slice(), target: chosen.target,
    userId: session.userId || "", cardApplyNo: session.cardApplyNo || "",
    physicalCardNo: session.physicalCardNo || "",
  };
  /* the assistant listens for this so it can offer the obvious next step */
  window.dispatchEvent(new CustomEvent("kona:runfinished", { detail: outcome }));
  loadRecords().catch(() => {});
  return outcome;
}

/* The run has its own target, so you can fire a V2 run without disturbing the module
   page you were on. Every affiliate x version is offered, including ones that still
   need credentials - those are marked rather than hidden. */
function runTarget() {
  /* also re-seeds if it was cached before a target existed */
  if (!state.runTarget || !state.runTarget.target) {
    state.runTarget = { target: state.target, version: state.version };
  }
  return state.runTarget;
}

/* ------------------------------------------------- module selection */
/* A run is whatever the user ticks. Everything stays ticked by default, so the button still
   means "all six" until someone says otherwise, and the choice survives a reload. */
const RUN_MODULES_STORE = "konaRunModules";

function loadRunModules() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(RUN_MODULES_STORE) || "{}");
  } catch (error) { /* ignore a corrupt entry */ }
  state.runModules = saved.modules || {};
  state.runPhysical = saved.physical !== false;
}

function persistRunModules() {
  try {
    localStorage.setItem(RUN_MODULES_STORE,
      JSON.stringify({ modules: state.runModules || {}, physical: state.runPhysical !== false }));
  } catch (error) { /* storage blocked */ }
}

function moduleOn(key) {
  const saved = (state.runModules || {})[key];
  if (saved !== undefined) return saved;              // whatever the user last chose wins
  const feature = ((state.boot || {}).features || []).find((f) => f.key === key);
  return !feature || feature.runAllDefault !== false; // a module can opt out of the default run
}

function selectedModules() {
  return ((state.boot || {}).features || []).filter((f) => moduleOn(f.key)).map((f) => f.key);
}

function paintRunModules() {
  const host = $("#runModules");
  if (!host) return;
  host.innerHTML = "";

  state.boot.features.forEach((feature) => {
    const label = document.createElement("label");
    label.className = "modpick" + (feature.parent ? " modpick--child" : "");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = moduleOn(feature.key);
    box.onchange = () => {
      state.runModules[feature.key] = box.checked;
      persistRunModules();
      paintRunModules();
      paintRunTarget();
    };
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + feature.label));
    label.title = featureTooltip(feature);
    if (feature.tooltip && feature.tooltip.length) label.classList.add("modpick--hint");
    host.appendChild(label);

    /* The card type is a property of Apply Card, not a seventh module - it lives inside that
       tick box so the two can never read as two separate steps. */
    if (feature.key === "apply_card") {
      const sub = document.createElement("label");
      sub.className = "modpick modpick--sub";
      sub.title = "Ticked: isDeliveryRequired true, a physical / plastic card. "
        + "Unticked: false, a mobile / virtual card.";
      const physical = document.createElement("input");
      physical.type = "checkbox";
      physical.id = "runPhysical";
      physical.checked = state.runPhysical !== false;
      physical.disabled = !box.checked;
      physical.onchange = () => {
        state.runPhysical = physical.checked;
        persistRunModules();
        paintRunModules();
      };
      sub.appendChild(physical);
      sub.appendChild(document.createTextNode(" Physical Card (delivery)"));
      if (!box.checked) sub.classList.add("is-off");
      host.appendChild(sub);
    }
  });

  const all = document.createElement("button");
  all.className = "btn btn--link";
  const every = state.boot.features.every((f) => moduleOn(f.key));
  all.textContent = every ? "Clear all" : "Select all";
  all.onclick = () => {
    state.boot.features.forEach((f) => { state.runModules[f.key] = !every; });
    persistRunModules();
    paintRunModules();
    paintRunTarget();
  };
  host.appendChild(all);

  paintRunModulesNote();
}

/* Says what a partial selection means before it is run, rather than after it fails. */
function paintRunModulesNote() {
  const chosen = selectedModules();
  const total = state.boot.features.length;
  const session = state.sessions[runScope()] || {};
  const notes = [];

  if (!chosen.length) {
    $("#runModulesNote").textContent = "Nothing selected - tick at least one module to run.";
    $("#btnRunAll").disabled = true;
    return;
  }
  $("#btnRunAll").disabled = runInProgress;

  if (!chosen.some((key) => roleOf(key) === "user_registration")) {
    notes.push(session.userId
      ? "No User Registration, so the run continues with this target's last user (userId "
        + session.userId + ") instead of creating one."
      : "No User Registration, and nothing has been run on this target yet - the later modules "
        + "have no userId to work with.");
  }
  if (chosen.includes("card_registration") && !chosen.includes("apply_card")) {
    notes.push(session.cardApplyNo
      ? "Card Registration will use the cardApplyNo from this target's last Apply Card ("
        + shorten(session.cardApplyNo) + ")."
      : "Card Registration needs a cardApplyNo and Apply Card is not selected.");
  }
  if (chosen.includes("pg_info_inquiry") && !chosen.includes("bank_account_inquiry")
      && !session.bankCode) {
    notes.push("PG Info Inquiry needs a bankCode from Bank Account Inquiry.");
  }
  if (chosen.includes("apply_card") && state.runPhysical === false
      && chosen.includes("card_registration")) {
    notes.push("Apply Card is set to a virtual card, so there is no plastic card for Card "
      + "Registration to register.");
  }

  $("#runModulesNote").textContent = chosen.length + " of " + total + " modules selected."
    + (notes.length ? "  " + notes.join("  ") : "");
}

function paintRunTarget() {
  const chosen = runTarget();
  const both = $("#runBoth").checked;
  const host = $("#runAllTarget");
  host.innerHTML = "";

  state.boot.targets.forEach((target) => {
    target.versions.forEach((version) => {
      /* a loaded portal project supplies the access key just as config.json does, so an
         affiliate driven entirely from the portal does not count as unconfigured */
      const loaded = (state.projects || {})[target.key + "|" + version.key];
      const key = (loaded && loaded.accessKey) || version.accessKey;
      const configured = key && key !== "CHANGE_ME";
      const active = target.key === chosen.target
        && (both ? true : version.key === chosen.version);
      const button = document.createElement("button");
      button.className = "pill" + (active ? " is-on" : "") + (configured ? "" : " pill--todo");
      button.textContent = target.label + " · " + version.key;
      button.title = configured
        ? "Run every module against " + target.label + " " + version.key
        : "No access key yet for " + target.label + " " + version.key
          + " — load one of its portal projects above, or add the key in Settings";
      button.onclick = () => {
        state.runTarget = { target: target.key, version: version.key };
        state.runTargetPinned = true;     // stop following the module pages' selection
        paintRunTarget();
      };
      host.appendChild(button);
    });
  });

  const current = state.boot.targets.find((t) => t.key === chosen.target);
  paintRunProject();
  paintRunModulesNote();            /* the session it reports on belongs to the run target */
  const picked = selectedModules().length;
  const what = picked === state.boot.features.length
    ? "every module" : picked + " of " + state.boot.features.length + " modules";
  $("#runAllNote").textContent = both
    ? "Will run " + what + " for " + (current ? current.label : chosen.target) + " V1, then again for V2."
    : "Will run " + what + " for " + (current ? current.label : chosen.target) + " " + chosen.version + ".";
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
    const project = currentProject();
    const result = await api("/api/card-source", {
      target: state.target, version: state.version,
      projectName: project ? project.projectName : undefined,
    });
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
      + Object.entries(result.fields).map(([k, v]) => k + "=" + shorten(v)).join("  ")
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

/* the columns that hold machine-made identifiers, which is where shortening helps and a
   truncated project name or e-mail would only get in the way */
const LONG_ID_COLUMNS = ["cardApplyNo", "mobileCardNo", "physicalCardNo", "basicCardNo"];

const RECORD_COLUMNS = [
  ["registeredAt", "Registered"], ["affiliate", "Affiliate"], ["version", "WV"],
  ["projectName", "Project Name"],
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
        /* Only opaque identifiers are shortened. A project name, a login or a date is meant to
           be read, so it is left whole however long it is. */
        const cut = LONG_ID_COLUMNS.indexOf(key) !== -1;
        td.textContent = (cut ? shorten(value, 20) : value) || "—";
        if (cut && isLong(value, 20)) td.title = value;   /* the whole thing on hover and in CSV */
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
/* ------------------------------------------------------ assistant bridge */
/* The console's own surface for assistant.js. Everything it can do here, a person could do by
   clicking: read the state, list what the portal offers, and drive the Run All page. It never
   builds a request of its own - runFlow sets the same controls you would set by hand and then
   calls the same runAll(), so there is one execution path, not two. */
window.KonaConsole = {
  targets: function () {
    return ((state.boot || {}).targets || []).map((t) => ({
      key: t.key, label: t.label, versions: t.versions.map((v) => v.key),
    }));
  },

  /* the portal projects that belong to one affiliate */
  projectsFor: async function (target, version) {
    const entry = await ensureProjectList(target, version || "V1");
    if (!entry) return { ok: false, error: "Could not read the project list", projects: [] };
    if (entry.error) return { ok: false, error: entry.error, projects: [] };
    return { ok: true, projects: (entry.projects || []).map((p) => p.name) };
  },

  loadedProject: function (target, version) {
    const project = (state.projects || {})[target + "|" + version];
    return project ? { projectName: project.projectName, aspId: project.aspId,
                       services: (project.services || []).map((s) => ({
                         serviceId: s.serviceId, name: s.name })) } : null;
  },

  loadProject: async function (target, version, name) {
    const result = await lookupProjectInto(target + "|" + version, name);
    if (!result.ok) return result;
    if (target === state.target && version === state.version) {
      $("#aspId").value = result.aspId || $("#aspId").value;
      $("#accessKey").value = result.accessKey || $("#accessKey").value;
      paintEnv();
      paintProject();
      if (state.featureMeta) renderForm();
    }
    paintRunProject();
    return result;
  },

  cardStock: function (target, version, projectName, detail) {
    return api("/api/card-stock", { target, version, projectName, detail: !!detail });
  },

  /* Run the chain - the same machinery the Run All page uses, with its controls set first
     so the user watches it happen on that page rather than in a hidden code path. */
  runFlow: async function (options) {
    const target = options.target, version = options.version;
    if (options.projectName) {
      const scope = target + "|" + version;
      const loaded = (state.projects || {})[scope];
      if (!loaded || loaded.projectName !== options.projectName) {
        const result = await window.KonaConsole.loadProject(target, version, options.projectName);
        if (!result.ok) return { ok: false, error: result.error };
      }
      if (options.serviceId) {
        (state.projects || {})[scope].chosenServiceId = options.serviceId;
        persistProjects();
      }
    }
    state.runTarget = { target, version };
    state.runTargetPinned = true;
    if (options.modules && options.modules.length) {
      state.boot.features.forEach((feature) => {
        state.runModules[feature.key] = options.modules.indexOf(feature.key) !== -1;
      });
    }
    if (options.physical !== undefined) state.runPhysical = !!options.physical;
    persistRunModules();
    $("#runBoth").checked = !!options.bothVersions;
    showPage("runall");                    /* so the step rows are visible while it runs */
    paintRunModules();
    paintRunTarget();
    return await runAll();
  },
  target: function () {
    const found = ((state.boot || {}).targets || []).find((t) => t.key === state.target);
    return { target: state.target, version: state.version, label: found ? found.label : state.target };
  },
  session: function () { return Object.assign({}, currentSession()); },
  project: function () {
    const project = currentProject();
    if (!project) return null;
    return {
      projectName: project.projectName, projectId: project.projectId, aspId: project.aspId,
      keyType: project.keyType, services: (project.services || []).map((s) => s.serviceId),
    };
  },
  features: function () {
    return ((state.boot || {}).features || []).map((f) => ({
      key: f.key, label: f.label, parent: f.parent || "",
      inChain: f.runAllDefault !== false,
    }));
  },
  shorten: function (value, max) { return shorten(value, max); },
  fetchRecords: function () { return api("/api/records", {}); },
  fetchHistory: function () { return api("/api/history", {}); },
  go: function (page) { showPage(page); },
  openFeature: async function (key) { await loadFeature(key); showPage("flow"); },
};

function showPage(page) {
  /* no diagram timer keeps running behind the other pages */
  if (page !== "howitworks" && window.KonaFlow) window.KonaFlow.leave();
  $$(".page").forEach((node) => node.classList.add("is-hidden"));
  $("#page-" + page).classList.remove("is-hidden");
  $$(".nav__item[data-page]").forEach((node) => node.classList.toggle("is-active", node.dataset.page === page));
  $$(".nav__item[data-feature]").forEach((node) =>
    node.classList.toggle("is-active",
      page === "flow" && node.dataset.feature === navKeyFor(state.feature)));
  const crumb = $(".crumb");
  if (page === "flow") {
    $("#pageTitle").textContent = state.featureMeta.label.toUpperCase();
    const parentKey = navKeyFor(state.feature);
    const parent = parentKey === state.feature ? null
      : state.boot.features.find((f) => f.key === parentKey);
    crumb.textContent = "Modules / " + (parent ? parent.label + " / " : "")
      + state.featureMeta.label;
  } else if (page === "runall") {
    $("#pageTitle").textContent = "RUN ALL MODULES";
    crumb.textContent = "Every module in order, on one freshly created user";
    /* mirror whatever target the module pages are on, until you pick one here */
    if (!state.runTargetPinned) state.runTarget = { target: state.target, version: state.version };
    paintRunTarget();
  } else if (page === "howitworks") {
    $("#pageTitle").textContent = "HOW IT WORKS";
    crumb.textContent = "What this console does, start to finish";
    if (window.KonaFlow) window.KonaFlow.enter();
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
      projectName: $("#projectName").value.trim(),
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

  /* who is signed in, and the way out */
  const who = signedInUser();
  if (who) {
    $("#whoName").textContent = who.display || who.username;
    $("#whoAvatar").textContent = (who.display || who.username).trim().charAt(0).toUpperCase();
    $("#whoAvatar").title = who.username + (who.role === "owner" ? " (owner)" : "");
    $("#whoBox").title = "Signed in as " + who.username;
  }
  $("#btnSignOut").onclick = async () => {
    try { await api("/api/auth/logout", { token: sessionToken() }); } catch (error) { /* going anyway */ }
    toGate();
  };

  $("#btnLoadProject").onclick = loadProjectFromPortal;
  $("#projectName").onkeydown = (event) => {
    if (event.key === "Enter") loadProjectFromPortal();
  };
  onProjectPick("projectPick", "projectName", loadProjectFromPortal);
  $("#btnRefreshProjects").onclick = async () => {
    $("#btnRefreshProjects").disabled = true;
    $("#projectNote").textContent = "Re-reading " + affiliateLabel(state.target)
      + "'s projects from the portal…";
    const entry = await ensureProjectList(state.target, state.version, true);
    $("#projectNote").textContent = entry && entry.error
      ? "Project list unavailable - " + entry.error
      : ((entry && entry.projects.length) || 0) + " project(s) for "
        + affiliateLabel(state.target) + (entry && entry.note ? ". " + entry.note : "");
    $("#btnRefreshProjects").disabled = false;
  };

  $("#btnRunAll").onclick = runAll;
  $("#btnRunCancel").onclick = () => {
    runCancelled = true;
    $("#runAllNote").textContent = "Cancelling after the current request…";
  };
  $("#runBoth").onchange = paintRunTarget;
  $("#btnRunLoadProject").onclick = loadRunProject;
  onProjectPick("runProjectPick", "runProjectName", loadRunProject);
  $("#runProjectName").onkeydown = (event) => {
    if (event.key === "Enter") loadRunProject();
  };
  $("#runServiceId").onchange = () => {
    const scope = runScope();
    const project = (state.projects || {})[scope];
    if (!project) return;
    project.chosenServiceId = $("#runServiceId").value || "";
    persistProjects();
    paintRunProject();
  };

  $("#btnRunClear").onclick = async () => {
    $("#runProgress").innerHTML = "";
    $("#btnRunClear").disabled = true;
    state.boot = await api("/api/bootstrap");     // pick up credentials added in Settings meanwhile
    paintRunModules();
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
  /* no token, no console - the server would refuse anyway, this just saves the round trip */
  if (!sessionToken()) {
    toGate();
    return;
  }
  const boot = await discoverApi();
  if (boot === "signedout") {
    toGate("expired");
    return;
  }
  if (!boot) {
    showApiBanner();
    return;
  }
  try {
    state.boot = boot;
    state.feature = state.boot.features[0].key;
    loadSessions();
    loadProjects();
    loadRunModules();
    $("#envApi").textContent = API_BASE ? API_BASE.replace(/^https?:\/\//, "") : location.host + " (same origin)";
    $("#dotApi").className = "dot";
    wire();
    await selectTarget(state.boot.targets[0].key, null);
    paintRunModules();          /* after the target exists, so the note reads the right session */
    renderSession();
  } catch (error) {
    $(".content").innerHTML = '<div class="banner"><b>Failed to start.</b><br><br><code>'
      + String(error) + "</code></div>";
  }
})();

})();
