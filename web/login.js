/* ============================================================================
   The gate: sign in, or create the account that signs you in.

   The token this returns is what every later call carries. It is stored under one key, and
   app.js refuses to start without it - though the real check is on the server, which answers
   401 to any data endpoint called without a live session.
   ========================================================================== */
(() => {
"use strict";

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "konaSession";
const USER_KEY = "konaUser";

/* the console and this page may be served from the same origin or from a static host */
const API_BASE = location.port === "5500" || location.protocol === "file:"
  ? "http://127.0.0.1:8770" : "";

let mode = "in";               /* "in" = sign in, "up" = create account */

async function call(path, payload) {
  const response = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json().catch(() => ({ error: "the server did not answer in JSON" }));
  if (!response.ok && !data.error) throw new Error("HTTP " + response.status);
  return data;
}

function note(text, kind) {
  const node = $("#gateNote");
  node.textContent = text || "";
  node.className = "gate__note" + (kind ? " is-" + kind : "");
}

function toast(message, ms) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("is-on");
  setTimeout(() => node.classList.remove("is-on"), ms || 3200);
}

function setMode(next) {
  mode = next;
  $("#tabIn").classList.toggle("is-on", next === "in");
  $("#tabUp").classList.toggle("is-on", next === "up");
  $("#gateConfirmRow").classList.toggle("is-hidden", next === "in");
  $("#gateGo").textContent = next === "in" ? "Sign in" : "Create account";
  $("#gatePass").setAttribute("autocomplete", next === "in" ? "current-password" : "new-password");
  note(next === "in" ? "" : "Pick anything you will remember - at least 8 characters.");
  clearForm();
  $("#gateUser").focus();
}

/* Empty every field, now and again a moment later.

   Once is not enough: the browser's own password manager fills these in after the page has
   settled, and the back/forward cache restores whatever was typed when you return to this page
   from the console. So this runs on load, on every pageshow, and once more on a short delay -
   which is what it takes for the fields to actually be empty rather than momentarily empty. */
function clearForm() {
  const form = $("#gateForm");
  if (form) form.reset();
  ["#gateUser", "#gatePass", "#gateConfirm"].forEach((sel) => {
    const field = $(sel);
    if (field) field.value = "";
  });
}

function clearFormSoon() {
  clearForm();
  setTimeout(clearForm, 120);
  setTimeout(clearForm, 400);
}

function land(data, made) {
  try {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  } catch (error) { /* storage blocked - the console will ask again */ }
  clearFormSoon();          /* nothing typed stays on screen once it has been accepted */
  note("");
  toast(made ? "Account created — taking you in…"
             : "Signed in as " + data.user.display + " — taking you in…", 2200);
  setTimeout(() => { location.href = "index.html"; }, 700);
}

async function submit(event) {
  event.preventDefault();
  const username = $("#gateUser").value.trim();
  const password = $("#gatePass").value;
  if (!username || !password) {
    note("Both fields, please.", "bad");
    return;
  }
  if (mode === "up" && password !== $("#gateConfirm").value) {
    note("Those two passwords are not the same.", "bad");
    return;
  }
  $("#gateGo").disabled = true;
  note(mode === "in" ? "Checking…" : "Creating your account…");
  try {
    const data = await call(mode === "in" ? "/api/auth/login" : "/api/auth/signup",
                            { username, password });
    if (!data.ok) {
      note(data.error || "That did not work.", "bad");
      return;
    }
    land(data, mode === "up");
  } catch (error) {
    note("The console's server is not reachable. Start it with: python server.py", "bad");
  } finally {
    $("#gateGo").disabled = false;
  }
}

async function start() {
  $("#tabIn").onclick = () => setMode("in");
  $("#tabUp").onclick = () => setMode("up");
  $("#gateForm").onsubmit = submit;

  /* arriving fresh, or coming back from the console after signing out */
  clearFormSoon();
  window.addEventListener("pageshow", clearFormSoon);

  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (error) { /* storage blocked */ }
  try {
    const me = await call("/api/auth/me", { token: token || "" });
    if (me.signedIn) {
      location.href = "index.html";          /* already in - do not ask twice */
      return;
    }
    /* nobody has an account yet, so the first thing to do is make one */
    if (!me.hasAccounts) {
      setMode("up");
      note("No account exists yet. The first one you make is the owner of this console.");
      return;
    }
  } catch (error) {
    note("The console's server is not reachable. Start it with: python server.py", "bad");
  }
  setMode("in");
}

start();

})();
