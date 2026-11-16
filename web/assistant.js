/* ============================================================================
   KonaRelay - the KONA WebView console's built-in agent.

   What it is: a scripted assistant over this tool's own knowledge, not a remote
   language model. Nothing it says is generated or guessed - every answer is
   written here, and the ones about your data are read live from the console
   through window.KonaConsole. That is deliberate: a QA tool should not invent
   an answer about an access key or an error code.

   How the conversation works: every topic carries `next`, the questions that
   usually follow it, which is what fills the "You might ask next" chips. Free
   text is matched against each topic's words and tags; nothing matches, nothing
   is invented - it says so and offers the closest topics instead.
   ========================================================================== */
(() => {
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------- console bridge */
/* If app.js has not finished booting, every call returns a blank, so the
   assistant degrades to its static answers instead of throwing. */
function bridge() { return window.KonaConsole || {}; }

/* what KonaRelay remembers within a conversation */
const state = { projectNames: [] };

/* a bridge call that has to exist - says so plainly rather than throwing a type error */
function bridgeFn(name) {
  const fn = bridge()[name];
  if (!fn) throw new Error("the console has not finished loading - try that again in a moment");
  return fn;
}

function safe(name, fallback) {
  try {
    const fn = bridge()[name];
    return fn ? fn() : fallback;
  } catch (error) {
    return fallback;
  }
}

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function code(value) { return "<code>" + esc(value) + "</code>"; }

/* Long values are shortened the same way everywhere - the rule lives in app.js and is shared
   through the bridge, so KonaRelay cannot drift from what the rest of the console shows. */
function shorten(value, max) {
  const fn = bridge().shorten;
  return fn ? fn(value, max) : String(value === null || value === undefined ? "" : value);
}

/* a shortened value that carries the whole thing on hover */
function codeShort(value) {
  const full = String(value === null || value === undefined ? "" : value);
  return '<code title="' + esc(full) + '">' + esc(shorten(full)) + "</code>";
}

/* "user_registration" -> "User Registration", from the console's own feature list */
function featureLabel(key) {
  const found = (safe("features", []) || []).find((feature) => feature.key === key);
  if (found) return found.label;
  return String(key || "?").replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* ----------------------------------------------------------- the topics */
/* chip  : the short label on the button
   q     : what gets shown as the asked question
   tags  : extra words free text can match on
   a     : the answer (a string of simple HTML, or a promise of one)
   next  : the questions that usually follow - this is the "probable next question"
   go    : optional button that takes the user to the screen being described   */
const TOPICS = [
  /* ---------------------------------------------------------- orientation */
  {
    id: "what-is-this",
    chip: "What is this tool?",
    q: "What is this tool?",
    tags: ["about", "overview", "purpose", "start", "help", "console", "what"],
    a: () => "This console replaces the Postman and cURL round trip for the KONA PLATE "
      + "WebView APIs. Six modules run in order - <b>User Registration, Bank Account "
      + "Registration, Bank Account Inquiry, PG Info Inquiry, Apply Card, Card "
      + "Registration</b> - against one affiliate (Burger King or iKuka) and one WebView "
      + "version (V1 or V2).<br><br>Your browser never holds an access key: it posts to the "
      + "local Python server, and that server calls the API.",
    next: ["how-run-module", "run-all", "project-name"],
  },
  {
    id: "how-run-module",
    chip: "How do I run one module?",
    q: "How do I run one module?",
    tags: ["send", "single", "module", "run", "request", "how"],
    a: () => "Pick the module in the left sidebar, set <b>Affiliate</b> and <b>WebView</b> at "
      + "the top, then press <b>Send</b>.<br><ul>"
      + "<li>The body comes from <code>config.json</code>; you can edit any field on the form "
      + "before sending.</li>"
      + "<li><code>ci</code>, <code>loginId</code> and <code>email</code> are re-generated on "
      + "every send, so you never collide with a user that already exists.</li>"
      + "<li>Useful values in the response (<code>userId</code>, <code>bankCode</code>, "
      + "<code>cardApplyNo</code>) are captured into the <b>Session</b> panel for the next "
      + "module.</li></ul>",
    next: ["session-chain", "where-change-body", "read-response"],
  },
  {
    id: "session-chain",
    chip: "How does one module feed the next?",
    q: "How does one module feed the next?",
    tags: ["session", "chain", "placeholder", "userid", "carry", "feed"],
    a: () => "A field written as <code>{{userId}}</code> is filled from the <b>Session</b> "
      + "panel at the moment you send.<br><br>The session is kept <b>per affiliate and "
      + "version</b> - a userId created on Burger King V1 never leaks into V2. Switch version "
      + "and the tool loads that version's own last user.<br><br>If a placeholder has no "
      + "value, the server refuses to send rather than posting the literal text "
      + "<code>{{userId}}</code>.",
    next: ["my-state", "error-000-015", "switch-version"],
  },
  {
    id: "read-response",
    chip: "How do I read the response?",
    q: "How do I read the response?",
    tags: ["response", "result", "code", "status", "success", "read"],
    a: () => "The Response panel shows the HTTP status, the KONA result code and the raw "
      + "JSON.<br><ul>"
      + "<li><code>000_000</code> is success - everything else is a refusal with a reason.</li>"
      + "<li>The response is cleared when you switch module, so what you are looking at always "
      + "belongs to the module on screen.</li>"
      + "<li>Every send is saved to <b>History</b>, request and response together.</li></ul>",
    next: ["error-003-027", "error-000-015", "history"],
  },

  /* ------------------------------------------------------------- run all */
  {
    id: "run-all",
    chip: "How do I run everything at once?",
    q: "How do I run everything at once?",
    tags: ["run all", "batch", "chain", "one button", "everything", "all"],
    a: () => "Open <b>Run All Modules</b> under FLOW. Pick the target, optionally load a "
      + "project, then press <b>Run All Modules</b>. It runs the ticked modules in order and "
      + "feeds each result into the next, on one freshly created user.<br><br>It uses the same "
      + "endpoints a manual run uses - the placeholder guard, the portal card fetch and the "
      + "card retry all still apply.",
    go: { label: "Open Run All Modules", page: "runall" },
    next: ["act-run", "pick-modules", "run-both-versions"],
  },
  {
    id: "pick-modules",
    chip: "Can I run only some modules?",
    q: "Can I run only some modules?",
    tags: ["select", "modules", "subset", "tick", "checkbox", "four", "some"],
    a: () => "Yes. Each module has a tick box in the <b>Modules</b> row of Run All. Untick "
      + "what you do not need and only the rest will run, in their normal order. "
      + "<b>Select all</b> and <b>Clear all</b> toggle them together, and your choice is "
      + "remembered the next time you open the console.<br><br>All six are ticked by default, "
      + "so the button still means the whole chain until you change it.",
    next: ["partial-session", "physical-vs-virtual", "run-all"],
  },
  {
    id: "partial-session",
    chip: "What if I skip User Registration?",
    q: "What happens if I skip User Registration in a run?",
    tags: ["partial", "skip", "user registration", "session", "reuse"],
    a: () => "A run that <b>includes</b> User Registration wipes the session for that target "
      + "first - new user, nothing carried over.<br><br>A run <b>without</b> it keeps the "
      + "session, so ticking only Apply Card and Card Registration chains onto the last user "
      + "created for that target. The note under the tick boxes tells you which userId it will "
      + "reuse before you press the button.",
    next: ["pick-modules", "session-chain", "my-state"],
  },
  {
    id: "physical-vs-virtual",
    chip: "Physical or virtual card?",
    q: "What is the difference between a physical and a virtual card here?",
    tags: ["physical", "virtual", "plastic", "mobile", "delivery", "isdeliveryrequired"],
    a: () => "It is one field on Apply Card: <code>isDeliveryRequired</code>.<br><ul>"
      + "<li><b>true</b> - physical / plastic card, delivered. This is the "
      + "<b>Physical Card (delivery)</b> tick box under Apply Card in Run All.</li>"
      + "<li><b>false</b> - mobile / virtual card, nothing is shipped.</li></ul>"
      + "Card Registration registers a <b>plastic</b> card, so it only makes sense after a "
      + "physical apply. Records labels the result for you: "
      + "<b>Mobile / Virtual Card</b> when a card was only applied for, "
      + "<b>Physical / Plastic Card</b> once one has been registered.",
    next: ["portal-cards", "records", "pick-modules"],
  },
  {
    id: "run-both-versions",
    chip: "Can I run V1 and V2 together?",
    q: "Can I run V1 and V2 together?",
    tags: ["v1", "v2", "both", "versions", "twice"],
    a: () => "Tick <b>Run V1 and V2, one after the other</b>. The run goes through your "
      + "selection for V1, then repeats it for V2 on the same affiliate.<br><br>Each leg uses "
      + "its own project, ASP ID, access key and session, so the two never mix.",
    next: ["project-name", "pick-modules", "switch-version"],
  },
  {
    id: "settle",
    chip: "What is the Settle (s) box?",
    q: "What is the Settle (s) box for?",
    tags: ["settle", "wait", "delay", "ars", "null", "inquiry", "empty"],
    a: () => "A bank account is not visible to the inquiry the instant it is registered - the "
      + "ARS record takes a moment to propagate. Settle is the pause after Bank Account "
      + "Registration before the inquiry runs, 8 seconds by default.<br><br>If the inquiry "
      + "still answers 200 with every field null, the run retries it a few times on its own "
      + "rather than carrying an empty <code>bankCode</code> into PG Info Inquiry.",
    next: ["error-000-015", "run-all", "read-response"],
  },

  /* ---------------------------------------------------- project and keys */
  {
    id: "project-name",
    chip: "What does Project Name do?",
    q: "What does the Project Name field do?",
    tags: ["project", "portal", "load", "asp", "access key", "credentials"],
    a: () => "Pick a project and the tool signs in to the QA portal, finds it in My Projects "
      + "and fills three things for you:<br><ul>"
      + "<li><b>Summary tab</b> -> <code>aspId</code> into <code>X-KM-User-AspId</code></li>"
      + "<li><b>Credentials -> API Key Information</b> -> the OASL key into "
      + "<code>X-KM-Access-Key</code></li>"
      + "<li><b>Card services</b> -> the <code>serviceId</code> dropdown on Apply Card</li>"
      + "</ul>It is remembered per affiliate and version. Load nothing and everything behaves "
      + "exactly as before, on <code>config.json</code>.",
    next: ["act-projects", "act-services", "access-key"],
  },
  {
    id: "affiliate-services",
    chip: "Why don't I see every serviceId?",
    q: "Why don't I see every serviceId in the dropdown?",
    tags: ["serviceid", "service", "dropdown", "missing", "filter", "affiliate"],
    a: () => "Because a service belongs to one affiliate, and you are only ever shown the "
      + "ones that belong to the project you loaded.<br><br>An ASP ID and a service ID share "
      + "their first six digits: Burger King is <code>000187...</code>, iKuka is "
      + "<code>000163...</code>. The project dropdown lists only that affiliate's projects, "
      + "and the serviceId list only that project's services. Nothing from another ASP can "
      + "appear on the form.",
    next: ["wrong-asp", "no-card-for-service", "project-name"],
  },
  {
    id: "wrong-asp",
    chip: "\"Belongs to ASP ...\" error?",
    q: "What does \"belongs to ASP ...\" mean when I load a project?",
    tags: ["asp", "belongs", "refused", "wrong", "mismatch", "error"],
    a: () => "You asked for a project that belongs to a different affiliate than the one "
      + "selected - for example an iKuka project while Burger King is active.<br><br>The "
      + "lookup is refused rather than filtered, because loading it would hand this affiliate "
      + "another one's ASP ID, key and service IDs. Switch the affiliate first, or pick one of "
      + "this affiliate's own projects from the dropdown.",
    next: ["affiliate-services", "ikuka", "project-name"],
  },
  {
    id: "access-key",
    chip: "Where does the access key come from?",
    q: "Where does the access key come from?",
    tags: ["key", "access", "oasl", "omcs", "credentials", "secret", "header"],
    a: () => "Either from <code>config.json</code> for that affiliate and version, or from the "
      + "project you load - the project wins when both exist.<br><br>On the portal's "
      + "Credentials tab the tool takes the <b>ACTIVE OASL</b> key, which is the "
      + "WebView/OpenAPI one. <b>OMCS</b> on the same screen belongs to another service and is "
      + "never used. The key stays on the server; it is sent as "
      + "<code>X-KM-Access-Key</code> and never reaches the browser.",
    next: ["ikuka", "project-name", "error-30-999-028"],
  },
  {
    id: "ikuka",
    chip: "How do I run iKuka?",
    q: "How do I run iKuka?",
    tags: ["ikuka", "affiliate", "second", "other"],
    a: () => "Select <b>iKuka</b> at the top, then load one of its projects - "
      + "<code>Revamped-P1 to P2-iKuka</code> and four others are in the dropdown.<br><br>Its "
      + "ASP ID (<code>000163000000000</code>) is already in config, and the access key comes "
      + "from whichever project you load, so nothing needs pasting in. Its test case IDs and "
      + "default serviceId are iKuka's own, not Burger King's.",
    next: ["tcidlist", "affiliate-services", "project-name"],
  },
  {
    id: "tcidlist",
    chip: "What is tcIdList?",
    q: "What is tcIdList?",
    tags: ["tcid", "tcidlist", "test case", "664156", "668151"],
    a: () => "The QA test cases a User Registration run reports against. It is per affiliate "
      + "and set as an override, so neither inherits the other's:<br><ul>"
      + "<li>Burger King - <code>664156</code>, <code>664160</code></li>"
      + "<li>iKuka - <code>668151</code></li></ul>"
      + "It appears in the User Registration payload only; the other five modules' APIs do not "
      + "take it.",
    next: ["where-change-body", "ikuka", "randomize"],
  },

  /* --------------------------------------------------------------- cards */
  {
    id: "portal-cards",
    chip: "Where do physical cards come from?",
    q: "Where do the physical card numbers come from?",
    tags: ["card", "physical", "portal", "test data", "cvc", "par", "expiry"],
    a: () => "From the QA portal, every time Card Registration runs. The tool signs in, opens "
      + "<b>Test Data -> Card Data</b> for the project, and takes a card whose status is "
      + "<b>ACTIVE</b>: card number, expiry, CVC and PAR go straight into the request.<br><br>"
      + "It must belong to the <b>same service</b> the card was applied for, otherwise it "
      + "would register the wrong product.",
    next: ["act-cards", "error-003-027", "no-card-for-service"],
  },
  {
    id: "error-003-027",
    chip: "Error 003_027?",
    q: "What does error 003_027 mean?",
    tags: ["003_027", "003027", "already mapped", "mapped", "card error", "error"],
    a: () => "<b>The card is already mapped to a user.</b> It bit us often because a card the "
      + "portal has already handed out stays <b>ACTIVE</b> on screen - the status alone does "
      + "not tell you it is spent.<br><br>Three things now stop it: every card used here is "
      + "remembered and never offered twice, a card that still answers 003_027 is swapped for "
      + "the next free one automatically, and the retry is reported in the response note.",
    next: ["act-cards", "no-card-for-service", "portal-cards"],
  },
  {
    id: "no-card-for-service",
    chip: "\"No unused ACTIVE card\"?",
    q: "What do I do about \"no unused ACTIVE card for service ...\"?",
    tags: ["no card", "unused", "active", "exhausted", "out of cards", "service"],
    a: () => "Every ACTIVE card for that one service has been used. The message lists the "
      + "services that still have cards free.<br><br>The fetch stops instead of handing back a "
      + "card from another service - that would register a different product and the failure "
      + "would surface much later. Either apply on a service that still has cards, or have "
      + "more test cards generated for that one on the portal.",
    next: ["portal-cards", "affiliate-services", "error-003-027"],
  },
  {
    id: "error-000-015",
    chip: "Error 000_015?",
    q: "What does error 000_015 mean?",
    tags: ["000_015", "000015", "length", "invalid", "placeholder", "error"],
    a: () => "A field is not the length the API expects. In this tool it almost always means a "
      + "placeholder went out unresolved - a literal <code>{{bankCode}}</code> instead of a "
      + "real one.<br><br>That is why the server now refuses to send a body still containing "
      + "<code>{{...}}</code>. If you see it, run the module that produces the value first; "
      + "for <code>bankCode</code> that is Bank Account Inquiry, which may need a few seconds "
      + "to settle.",
    next: ["settle", "session-chain", "my-state"],
  },
  {
    id: "error-30-999-028",
    chip: "Error 30_999_028?",
    q: "What does error 30_999_028 mean?",
    tags: ["30_999_028", "30999028", "header", "missing", "required", "error"],
    a: () => "A required header is missing. The usual suspects are "
      + "<code>X-KM-User-AspId</code> and <code>X-KM-Access-Key</code> being blank because no "
      + "project is loaded and config has none for that target.<br><br>Load a project, or fill "
      + "them in the Target panel, and send again.",
    next: ["access-key", "project-name", "ikuka"],
  },

  /* ------------------------------------------------------------ the data */
  {
    id: "records",
    chip: "What is in Records?",
    q: "What is in the Records table?",
    tags: ["records", "table", "users", "cards", "csv", "export", "label"],
    a: () => "One row per registered user, built from the saved history: <b>Registered, "
      + "Affiliate, WV, Project Name, User ID, Login ID, Card Apply No, Mobile Card No, "
      + "Physical Card No, Card Type</b> and a next step.<br><br>Card Type reads "
      + "<b>Mobile / Virtual Card</b> when a card was only applied for and "
      + "<b>Physical / Plastic Card</b> once one has been registered. The <b>Next step</b> "
      + "column offers to apply or register a card for any row still missing one, and "
      + "<b>CSV</b> exports exactly what you see.",
    go: { label: "Open Records", page: "records" },
    next: ["act-users", "act-counts", "history"],
  },
  {
    id: "history",
    chip: "What is in History?",
    q: "What is in History?",
    tags: ["history", "log", "past", "saved", "requests"],
    a: () => "Every send, successful or not, saved as a file with the full request and "
      + "response. The list shows <b>Time, Feature, Affiliate, WebView, Project Name, Status</b> "
      + "and how long it took.<br><br>It is also what Records is built from, and what the card "
      + "fetch reads to know which cards have already been used.",
    go: { label: "Open History", page: "history" },
    next: ["records", "last-run", "read-response"],
  },
  {
    id: "where-change-body",
    chip: "How do I change a request body?",
    q: "How do I change a request body?",
    tags: ["body", "config", "change", "edit", "parameter", "input", "override", "settings"],
    a: () => "Three places, in increasing permanence:<br><ul>"
      + "<li><b>On the form</b> - type into the field, or the Raw JSON box. Nothing is "
      + "saved.</li>"
      + "<li><b>Save body -> this target</b> - stores it as the override for this affiliate "
      + "and version only. <b>Save body -> shared default</b> stores it for all of them.</li>"
      + "<li><b>Settings</b> - edit <code>config.json</code> directly: targets, bodies, "
      + "overrides and the random field rules.</li></ul>",
    go: { label: "Open Settings", page: "settings" },
    next: ["randomize", "tcidlist", "how-run-module"],
  },
  {
    id: "randomize",
    chip: "Which fields are randomised?",
    q: "Which fields are randomised on every send?",
    tags: ["random", "randomize", "ci", "loginid", "email", "unique", "duplicate"],
    a: () => "<code>ci</code>, <code>loginId</code> and <code>email</code> - re-generated for "
      + "every send so a run never collides with an existing user. <code>ci</code> keeps its "
      + "original length and prefix.<br><br>Everything else is taken from the request body as "
      + "you see it. You can add more - <code>mobileNumber</code> already has a rule - in "
      + "<code>config.json</code> under the module's <code>randomize</code> list.",
    next: ["where-change-body", "how-run-module", "tcidlist"],
  },
  {
    id: "switch-version",
    chip: "What changes between V1 and V2?",
    q: "What changes when I switch between V1 and V2?",
    tags: ["v1", "v2", "version", "switch", "webview", "difference"],
    a: () => "The access key and the project, and with them the services and test cards. The "
      + "endpoint path is the same for both - both WebView versions call the "
      + "<code>/web-view/api/v1/...</code> routes.<br><br>Session data is separate per version, "
      + "so switching loads that version's own last user rather than carrying one across.",
    next: ["session-chain", "project-name", "run-both-versions"],
  },
  {
    id: "hosting",
    chip: "Can I host this somewhere?",
    q: "Can I host this on Vercel or a shared server?",
    tags: ["vercel", "host", "deploy", "share", "unreachable", "api server"],
    a: () => "The screens, yes. The API, no - and that is not a bug.<br><br>The KONA host is "
      + "<code>10.30.210.153</code>, a private address that only exists inside your network, "
      + "so nothing running in a data centre can reach it. The deployed page therefore talks "
      + "to the Python server on <b>your own machine</b>, which must be running. Only origins "
      + "listed exactly in <code>server.allowedOrigins</code> are allowed to do that.",
    next: ["what-is-this", "what-are-you"],
  },

  /* ----------------------------------------------- live, about your data */
  {
    id: "my-state",
    chip: "What is loaded right now?",
    q: "What is loaded right now?",
    tags: ["now", "current", "state", "loaded", "my", "selected", "session"],
    a: () => {
      const where = safe("target", {});
      const project = safe("project", null);
      const session = safe("session", {});
      const keys = ["userId", "bankCode", "cardApplyNo", "physicalCardNo"];
      const got = keys.filter((key) => session[key]);
      let out = "<b>Target:</b> " + esc(where.label || "?") + " " + esc(where.version || "")
        + "<br><b>Project:</b> " + (project
          ? esc(project.projectName) + " (ASP " + esc(project.aspId) + ", "
            + (project.services || []).length + " service(s))"
          : "none loaded - running on config.json");
      out += "<br><b>Session:</b> " + (got.length
        ? got.map((key) => key + " = " + codeShort(session[key])).join(", ")
        : "empty, nothing has been run on this target yet");
      return out;
    },
    next: ["session-chain", "last-run", "my-numbers"],
  },
  {
    id: "last-run",
    chip: "What happened in my last run?",
    q: "What happened in my last run?",
    tags: ["last", "recent", "fail", "failed", "did", "happen", "wrong"],
    a: async () => {
      const data = await safeAsync("fetchHistory", { rows: [] });
      const rows = (data && data.rows) || [];
      if (!rows.length) return "Nothing has been sent yet - History is empty.";
      const recent = rows.slice(0, 6);
      const okOf = (row) => typeof row.status === "number" && row.status >= 200 && row.status < 300;
      const bad = recent.filter((row) => !okOf(row));
      let out = "The last " + recent.length + " calls:<ul>";
      recent.forEach((row) => {
        const when = String(row.timestamp || "").replace("T", " ").slice(5, 16);
        out += "<li>" + esc(when) + " - " + esc(featureLabel(row.feature)) + " - "
          + esc(row.affiliate || "") + " " + esc(row.version || "") + " - <b>"
          + (row.status === null ? "no reply" : esc(row.status)) + "</b></li>";
      });
      out += "</ul>";
      out += bad.length
        ? "<span class=\"chipstep\">" + bad.length + " did not come back 2xx. That number is "
          + "the HTTP status - open History for the KONA result code and the full "
          + "request.</span>"
        : "<span class=\"chipstep\">All answered 2xx. That is the HTTP status, not the KONA "
          + "result code - History has both.</span>";
      return out;
    },
    next: ["history", "read-response", "my-numbers"],
  },
  {
    id: "my-numbers",
    chip: "How much have I run so far?",
    q: "How much have I run so far?",
    tags: ["how many", "count", "total", "users", "numbers", "summary", "stats"],
    a: async () => {
      if (!trace) trace = think();
      traceStep("Reading <code>/api/records</code> - the ledger built from history.");
      const data = await safeAsync("fetchRecords", null);
      const sum = data && data.summary;
      if (!sum) return "I could not read the records just now - open <b>Records</b> and they "
        + "will load there.";
      return "<ul><li><b>" + sum.users + "</b> users registered</li>"
        + "<li><b>" + sum.applied + "</b> of them have an applied card</li>"
        + "<li><b>" + sum.physical + "</b> physical / plastic, <b>" + sum.virtual
        + "</b> mobile / virtual</li></ul>"
        + "<span class=\"chipstep\">Counted from every saved run, both affiliates.</span>";
    },
    next: ["records", "last-run", "physical-vs-virtual"],
  },

  /* ---------------------------------------------------------------- meta */
  {
    id: "what-are-you",
    chip: "Are you an AI?",
    q: "Are you an AI?",
    tags: ["ai", "llm", "bot", "model", "chatgpt", "claude", "who", "you"],
    a: () => "Honestly: I am <b>KonaRelay</b>, an <b>agent, not a language model</b>. I read "
      + "you type, work "
      + "out which of my actions you mean, pull out the details you already gave (affiliate, "
      + "version, project, modules), ask only for what is still missing, and then do it - "
      + "really do it, through the same code the buttons use.<br><br>What I never do is "
      + "<b>invent</b>. Every explanation here was written for this tool, and every number comes "
      + "from your own portal, history and records. A tool that reports on test data should not "
      + "improvise an access key, an error code or a card count.<br><br>If you want a model "
      + "writing the replies too, that is one server route away - the actions underneath would "
      + "stay exactly as they are.<br><br>The <b>Thinking</b> block above each answer is the real "
      + "trace: the intent I matched and its score, what I pulled out of your sentence, which "
      + "slots were missing, every endpoint I called. Nothing is written there that did not "
      + "happen.",
    next: ["act-run", "act-cards", "what-is-this"],
  },
];

/* ============================================================================
   ACTIONS - the things KonaRelay can do, as opposed to explain.

   Each one declares the facts it needs (its slots). KonaRelay asks for whatever is
   missing, one question at a time, pre-filling anything it could read out of
   what you typed or out of the console's current state. Nothing that changes
   the system runs without a confirmation step naming exactly what will happen.
   ========================================================================== */
const ACTIONS = [
  {
    id: "act-run",
    chip: "Run a flow for me",
    q: "Run a flow",
    tags: ["run", "execute", "start", "flow", "chain", "trigger", "fire", "go", "perform",
           "modules", "test"],
    slots: ["affiliate", "version", "project", "modules", "physical"],
    confirm: (values) => {
      const pairs = runPairs(values);
      const where = pairs.length === 1
        ? "<b>" + esc(pairs[0].label + " " + pairs[0].version) + "</b>"
        : "<b>" + pairs.length + " targets</b> one after the other — "
          + esc(pairs.map((p) => p.label + " " + p.version).join(", "));
      return "Run <b>" + esc(moduleSummary(values.modules)) + "</b> on " + where
        + (values.project ? " using <b>" + esc(values.project) + "</b>"
          : values.affiliate === "ALL"
            ? ", each on whatever project it already has loaded"
            : " on the config values")
        + ((values.modules || []).indexOf("apply_card") !== -1
          ? ", applying a " + (values.physical ? "physical / plastic" : "mobile / virtual")
            + " card" : "")
        + ". This creates real data on the test system.";
    },
    run: runFlowAction,
  },
  {
    id: "act-cards",
    chip: "How many cards are free?",
    q: "How many ACTIVE cards are available?",
    tags: ["cards", "card", "active", "available", "stock", "free", "many", "left", "remaining",
           "count", "how"],
    slots: ["affiliate", "version", "project"],
    run: cardStockAction,
  },
  {
    id: "act-projects",
    chip: "List the projects",
    q: "List the projects for an affiliate",
    tags: ["projects", "project", "list", "which", "portal", "available"],
    slots: ["affiliate"],
    run: listProjectsAction,
  },
  {
    id: "act-services",
    chip: "List a project's service IDs",
    q: "List a project's service IDs",
    tags: ["services", "service", "serviceid", "list", "products", "which"],
    slots: ["affiliate", "version", "project"],
    run: listServicesAction,
  },
  {
    id: "act-users",
    chip: "List the users I created",
    q: "List the users I have created",
    tags: ["users", "user", "list", "created", "registered", "records", "who"],
    slots: [],
    run: listUsersAction,
  },
  {
    id: "act-counts",
    chip: "Give me the counts",
    q: "Give me the counts",
    tags: ["count", "counts", "how many", "total", "summary", "numbers", "statistics", "stats"],
    slots: [],
    run: countsAction,
  },
  {
    id: "act-runs",
    chip: "List my recent runs",
    q: "List my recent runs",
    tags: ["runs", "recent", "history", "last", "list", "calls", "sent"],
    slots: [],
    run: listRunsAction,
  },
];

const BY_ID = {};
TOPICS.forEach((topic) => { BY_ID[topic.id] = topic; });
ACTIONS.forEach((action) => { BY_ID[action.id] = action; });

const STARTERS = ["act-run", "act-cards", "act-counts", "what-is-this", "project-name",
                  "error-003-027"];

async function safeAsync(name, fallback) {
  try {
    const fn = bridge()[name];
    if (!fn) return fallback;
    return await fn();
  } catch (error) {
    return fallback;
  }
}

/* ------------------------------------------------------------- the slots */
/* Each slot knows how to offer itself, and how to guess an answer out of free text so KonaRelay
   does not ask for something you already said. */
const SLOTS = {
  affiliate: {
    ask: "Which affiliate?",
    options: () => (safe("targets", []) || []).map((t) => ({ value: t.key, label: t.label }))
      .concat([{ value: "ALL", label: "All affiliates" }]),
  },
  version: {
    ask: "Which WebView version?",
    options: (values) => {
      const targets = safe("targets", []) || [];
      const found = targets.find((t) => t.key === values.affiliate);
      const versions = (found && found.versions)
        || (targets[0] && targets[0].versions) || ["V1", "V2"];
      return versions.map((v) => ({ value: v, label: v }))
        .concat([{ value: "BOTH", label: versions.join(" and ") + ", one after the other" }]);
    },
  },
  project: {
    ask: "Which project? These are the ones that belong to this affiliate.",
    optional: true,
    /* a project belongs to exactly one affiliate, so there is no single answer that covers
       "all affiliates" - each target uses whatever it already has loaded, or config.json */
    skip: (values) => values.affiliate === "ALL",
    fallback: "",
    options: async (values) => {
      const version = values.version === "BOTH" ? "V1" : values.version;
      const result = await bridgeFn("projectsFor")(values.affiliate, version);
      if (!result.ok) return [{ value: "", label: "Carry on without a project" }];
      const list = result.projects.map((name) => ({ value: name, label: name }));
      list.push({ value: "", label: "No project - use config.json" });
      return list;
    },
  },
  modules: {
    ask: "Which modules?",
    options: () => {
      const features = safe("features", []) || [];
      const chain = features.filter((f) => f.inChain !== false).map((f) => f.key);
      return [
        { value: chain.join(","), label: "The whole chain (" + chain.length + " modules)" },
        { value: "user_registration", label: "User Registration only" },
        { value: "apply_card,card_registration", label: "Apply Card + Card Registration" },
        { value: "__pick__", label: "Pick them one by one…" },
      ];
    },
    parse: (value) => (value === "__pick__" ? value : value.split(",").filter(Boolean)),
  },
  physical: {
    ask: "Physical or virtual card?",
    skip: (values) => (values.modules || []).indexOf("apply_card") === -1,
    fallback: true,
    options: () => [
      { value: "yes", label: "Physical / plastic card (delivery)" },
      { value: "no", label: "Mobile / virtual card" },
    ],
    parse: (value) => value === "yes",
  },
};

/* every affiliate+version the request covers, in the order they will run */
function runPairs(values) {
  const targets = safe("targets", []) || [];
  const chosen = values.affiliate === "ALL"
    ? targets : targets.filter((t) => t.key === values.affiliate);
  const pairs = [];
  chosen.forEach((target) => {
    const versions = values.version === "BOTH" ? (target.versions || ["V1", "V2"])
      : [values.version];
    versions.forEach((version) => pairs.push({ target: target.key, version: version,
                                               label: target.label }));
  });
  return pairs;
}

let pending = null;          /* {action, values, slot, picking} while a question is open */

function moduleSummary(keys) {
  const features = safe("features", []) || [];
  const chain = features.filter((f) => f.inChain !== false);
  if (!keys || !keys.length) return "nothing";
  if (keys.length === chain.length && chain.every((f) => keys.indexOf(f.key) !== -1)) {
    return "the whole chain (" + chain.length + " modules)";
  }
  if (keys.length > 3) return keys.length + " modules";
  return keys.map((key) => featureLabel(key)).join(", ");
}

/* How people actually name a module when they are telling you to run it. The longest phrase
   wins, so "register card" never reads as "register user". A variant is only chosen when its
   own words are there - "without ci", "auto recharge", "change account". */
const MODULE_PHRASES = [
  ["user_registration_without_ci_auto_recharge",
   ["without ci auto recharge", "without ci- auto recharge", "no ci auto recharge"]],
  ["user_registration_without_ci", ["without ci", "no ci", "ci less", "ciless"]],
  ["auto_recharge_bank_registration_change_account",
   ["auto recharge change account", "change account", "auto recharge- change account"]],
  ["auto_recharge_bank_registration", ["auto recharge"]],
  ["card_registration",
   ["card registration", "register card", "register a card", "register the card",
    "physical card registration", "map card", "map the card", "register plastic"]],
  ["apply_card",
   ["apply card", "apply a card", "apply for a card", "card apply", "issue card", "issue a card"]],
  ["pg_info_inquiry", ["pg info", "pg information", "payment gateway", "pg inquiry"]],
  ["bank_account_inquiry",
   ["bank account inquiry", "bank inquiry", "account inquiry", "check bank account",
    "look up the bank account", "inquire bank"]],
  ["bank_account_registration",
   ["bank account registration", "register bank account", "register a bank account",
    "register the bank account", "add bank account", "bank registration", "ars register"]],
  ["user_registration",
   ["user registration", "register user", "register a user", "register the user", "create user",
    "create a user", "new user", "sign up", "signup", "register users"]],
];

function extract(text) {
  const lower = " " + String(text).toLowerCase().replace(/[,.;!?]/g, " ") + " ";
  const found = {};

  /* version: V1, V2, or both */
  if (/\b(both versions?|v1 and v2|v1 & v2|each version|all versions?)\b/.test(lower)) {
    found.version = "BOTH";
  } else {
    const version = lower.match(/\bv\s?([12])\b/);
    if (version) found.version = "V" + version[1];
  }

  /* affiliate: one of them, or all of them */
  if (/\b(all affiliates?|both affiliates?|every affiliate|all targets?)\b/.test(lower)) {
    found.affiliate = "ALL";
  } else {
    (safe("targets", []) || []).forEach((target) => {
      const label = target.label.toLowerCase();
      if (lower.indexOf(label) !== -1 || lower.indexOf(target.key.toLowerCase()) !== -1) {
        found.affiliate = target.key;
      }
    });
    if (/\bbk\b/.test(lower)) found.affiliate = "BURGER_KING";
  }

  /* project, by its own name */
  (state.projectNames || []).forEach((name) => {
    if (lower.indexOf(name.toLowerCase()) !== -1) found.project = name;
  });

  /* modules: the exact labels first, then the way people say them */
  const features = safe("features", []) || [];
  const picked = [];
  let rest = lower;
  /* longest label first, so "Without CI- Auto Recharge" is not read as "Without CI" plus
     "Auto Recharge" - two different modules */
  features.slice().sort((a, b) => b.label.length - a.label.length).forEach((feature) => {
    const label = feature.label.toLowerCase();
    if (label.length > 3 && rest.indexOf(label) !== -1) {
      picked.push(feature.key);
      rest = rest.split(label).join(" ");
    }
  });
  MODULE_PHRASES.forEach((entry) => {
    const key = entry[0];
    if (picked.indexOf(key) !== -1) return;
    entry[1].forEach((phrase) => {
      if (rest.indexOf(phrase) !== -1) {
        if (picked.indexOf(key) === -1) picked.push(key);
        rest = rest.split(phrase).join(" ");
      }
    });
  });
  if (picked.length) {
    /* keep them in the order the console runs them, not the order they were typed */
    const order = features.map((f) => f.key);
    found.modules = order.filter((key) => picked.indexOf(key) !== -1);
  }
  if (/\ball (six|6|modules|of them)\b|\bwhole (chain|flow)\b|\beverything\b|\bfull (flow|chain|run)\b/
      .test(lower)) {
    found.modules = features.filter((f) => f.inChain !== false).map((f) => f.key);
  }

  if (/\bvirtual\b|\bmobile card\b/.test(lower)) found.physical = false;
  if (/\bphysical\b|\bplastic\b/.test(lower)) found.physical = true;
  return found;
}

/* the console's state is a legitimate default - do not ask for what is already selected */
function seedFromConsole(values) {
  const where = safe("target", {});
  if (values.affiliate === undefined && where.target) values.affiliate = where.target;
  if (values.version === undefined && where.version) values.version = where.version;
  return values;
}

function startAction(action, prefill, echo, keepTrace) {
  pending = { action: action, values: Object.assign({}, prefill || {}), picking: null };
  if (echo !== false) bubble("me", esc(action.q));
  if (!keepTrace) {
    trace = think();
    traceStep("Starting <b>" + esc(action.chip) + "</b>.");
    const seeded = Object.keys(pending.values).filter((k) => pending.values[k] !== undefined);
    traceStep(seeded.length
      ? "Already known: " + seeded.map((k) => esc(k)).join(", ") + "."
      : "Nothing known yet - I will ask for everything it needs.");
  }
  askNext();
}

async function askNext() {
  if (!pending) return;
  const action = pending.action, values = pending.values;
  for (const name of action.slots) {
    const slot = SLOTS[name];
    if (values[name] !== undefined) continue;
    if (slot.skip && slot.skip(values)) {
      traceStep("<b>" + esc(name) + "</b> does not apply here - skipping it.");
      values[name] = slot.fallback;
      continue;
    }
    traceStep("Still need <b>" + esc(name) + "</b> - asking.", "end");
    traceDone();
    return askSlot(name, slot, values);
  }
  if (action.confirm) {
    traceStep("Everything it needs is known. Asking you to confirm before it runs.", "end");
    traceDone();
    return askConfirm();
  }
  traceStep("Everything it needs is known - nothing to confirm, this only reads.", "end");
  return fire();
}

async function askSlot(name, slot, values) {
  pending.slot = name;
  const thinking = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  let options;
  try {
    options = await Promise.resolve(slot.options(values));
  } catch (error) {
    options = [];
  }
  thinking.innerHTML = esc(slot.ask);
  if (!options.length) {
    thinking.innerHTML = esc(slot.ask) + "<br><br>I could not read the list for that.";
    pending = null;
    return;
  }
  optionChips(options.map((option) => ({
    label: option.label,
    onPick: () => fillSlot(name, option.value, option.label),
  })), true);
}

function fillSlot(name, rawValue, label) {
  if (!pending) return;
  const slot = SLOTS[name];
  bubble("me", esc(label));
  if (!trace) trace = think();
  traceStep("Got <b>" + esc(name) + "</b> = " + esc(label) + ".");
  const value = slot.parse ? slot.parse(rawValue) : rawValue;
  if (value === "__pick__") return pickModules();
  pending.values[name] = value;
  pending.slot = null;
  askNext();
}

/* the one slot that needs more than a single tap */
function pickModules() {
  const features = safe("features", []) || [];
  pending.picking = features.map((f) => f.key);          /* start with everything ticked */
  const host = bubble("bot", "Tap a module to drop it from the run, then press Done.");
  const wrap = document.createElement("div");
  wrap.className = "chipsuggest";
  host.appendChild(wrap);
  const paint = () => {
    wrap.innerHTML = "";
    features.forEach((feature) => {
      const on = pending.picking.indexOf(feature.key) !== -1;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chipq" + (on ? " chipq--on" : "");
      button.textContent = (on ? "✓ " : "") + feature.label;
      button.onclick = () => {
        const at = pending.picking.indexOf(feature.key);
        if (at === -1) pending.picking.push(feature.key);
        else pending.picking.splice(at, 1);
        paint();
      };
      wrap.appendChild(button);
    });
    const done = document.createElement("button");
    done.type = "button";
    done.className = "chipq chipq--go";
    done.textContent = "Done (" + pending.picking.length + ")";
    done.onclick = () => {
      if (!pending.picking.length) return;
      const ordered = features.map((f) => f.key)
        .filter((key) => pending.picking.indexOf(key) !== -1);
      pending.picking = null;
      bubble("me", moduleSummary(ordered));
      pending.values.modules = ordered;
      askNext();
    };
    wrap.appendChild(done);
    body.scrollTop = body.scrollHeight;
  };
  paint();
}

function askConfirm() {
  const action = pending.action;
  bubble("bot", action.confirm(pending.values));
  optionChips([
    { label: "Yes, run it", go: true, onPick: fire },
    { label: "Cancel", onPick: () => { bubble("me", "Cancel"); pending = null;
      bubble("bot", "Stopped - nothing was sent."); suggest("You might ask next", STARTERS); } },
  ], true);
}

async function fire() {
  const action = pending.action, values = pending.values;
  pending = null;
  try {
    await action.run(values);
  } catch (error) {
    traceStep("It stopped with an error: " + esc(error.message || error), "end");
    bubble("bot", "That did not finish: " + esc(error.message || error));
  }
  traceDone();            /* whatever the action left open, close it with the elapsed time */
}

/* ---------------------------------------------------------- what actions do */
async function runFlowAction(values) {
  const pairs = runPairs(values);
  if (!pairs.length) {
    bubble("bot", "I could not work out which affiliate and version to run on.");
    return;
  }
  if (!trace) trace = think();
  traceStep("Expanded to <b>" + pairs.length + " run" + (pairs.length === 1 ? "" : "s")
    + "</b>: " + esc(pairs.map((p) => p.label + " " + p.version).join(", ")) + ".");
  const say = bubble("bot", "Starting" + (pairs.length > 1 ? " " + pairs.length + " runs" : "")
    + "… the steps appear on the Run All page.");
  dock.classList.add("is-thinking");

  const results = [];
  for (const pair of pairs) {
    const only = pairs.length === 1;
    if (!only) {
      say.innerHTML = "Running <b>" + esc(pair.label) + " " + esc(pair.version) + "</b> — "
        + (results.length + 1) + " of " + pairs.length + "…";
    }
    traceStep("Running " + esc(moduleSummary(values.modules)) + " on <b>"
      + esc(pair.label + " " + pair.version) + "</b>…");
    let outcome;
    try {
      outcome = await bridgeFn("runFlow")({
        target: pair.target, version: pair.version,
        /* a project belongs to one affiliate, so it is only applied where it belongs */
        projectName: (values.affiliate === "ALL" ? "" : values.project) || "",
        modules: values.modules,
        physical: values.physical !== false,
      });
    } catch (error) {
      outcome = { ok: false, error: String(error.message || error) };
    }
    results.push({ pair: pair, outcome: outcome || { ok: false, error: "no answer" } });
  }
  dock.classList.remove("is-thinking");
  traceStep(results.filter((r) => r.outcome && r.outcome.ok).length + " of " + results.length
    + " run(s) passed.", "end");
  traceDone("Ran for ");

  const good = results.filter((row) => row.outcome && row.outcome.ok).length;
  const head = results.length === 1
    ? (results[0].outcome.error
        ? "<b>That run did not start.</b> " + esc(results[0].outcome.error)
        : results[0].outcome.cancelled ? "<b>Cancelled part way through.</b>"
          : results[0].outcome.ok ? "<b>Done — every module passed.</b>"
            : "<b>Finished, but something failed.</b>")
    : "<b>" + good + " of " + results.length + " runs passed.</b>";

  say.innerHTML = head + "<br>" + esc(moduleSummary(values.modules))
    + (values.project ? " · " + esc(values.project) : "")
    + table(["Target", "Result", "userId", "cardApplyNo"], results.map((row) => [
      esc(row.pair.label + " " + row.pair.version),
      row.outcome.error ? '<b class="chipbad">' + esc(row.outcome.error.slice(0, 40)) + "</b>"
        : row.outcome.cancelled ? '<b class="chipbad">cancelled</b>'
          : row.outcome.ok ? '<b class="chipok">passed</b>'
            : '<b class="chipbad">failed</b>',
      row.outcome.userId ? codeShort(row.outcome.userId) : "—",
      row.outcome.cardApplyNo ? codeShort(row.outcome.cardApplyNo) : "—",
    ]));

  suggest("You might ask next",
    good === results.length ? ["act-users", "act-counts", "act-cards"]
      : ["act-runs", "error-003-027", "read-response"]);
}

async function cardStockAction(values) {
  const say = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  if (!trace) trace = think();
  traceStep("Calling <code>/api/card-stock</code> for <b>"
    + esc(values.project || "the configured project")
    + "</b> - the server signs in to the portal and reads Test Data.");
  const data = await bridgeFn("cardStock")(values.affiliate, values.version,
                                            values.project || "");
  if (!data || !data.ok) {
    say.innerHTML = "I could not read the card data: " + esc((data && data.error) || "no answer");
    return;
  }
  const rows = data.services.filter((service) => service.total > 0);
  const head = "<b>" + esc(data.projectName) + "</b> holds <b>" + data.totals.total
    + "</b> test cards. <b>" + data.totals.free + "</b> are free to use right now"
    + (data.totals.usedHere
      ? " (" + data.totals.active + " " + esc(data.statusFilter) + ", minus "
        + data.totals.usedHere + " this tool has already sent)" : "") + ".";
  say.innerHTML = head + table(
    ["Service", "Name", "Free", data.statusFilter, "Total"],
    rows.map((service) => [
      "<code>" + esc(service.serviceId) + "</code>", esc(service.name),
      "<b>" + service.free + "</b>", String(service.active), String(service.total),
    ]))
    + (rows.length < data.services.length
      ? '<span class="chipstep">' + (data.services.length - rows.length)
        + " service(s) have no cards at all.</span>" : "")
    + (data.truncated
      ? '<span class="chipstep">More cards exist than one page returns - these are the first '
        + 'page.</span>' : "");
  const empty = rows.filter((service) => service.free === 0).length;
  suggest("You might ask next",
    empty ? ["no-card-for-service", "act-run", "portal-cards"] : ["act-run", "act-services", "portal-cards"]);
}

async function listProjectsAction(values) {
  const say = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  if (!trace) trace = think();
  traceStep("Asking the portal which projects belong to <b>"
    + esc(affiliateLabel(values.affiliate)) + "</b>.");
  const result = await bridgeFn("projectsFor")(values.affiliate, "V1");
  if (!result.ok) { say.innerHTML = "I could not read that list: " + esc(result.error); return; }
  state.projectNames = result.projects.slice();
  say.innerHTML = "<b>" + esc(affiliateLabel(values.affiliate)) + "</b> owns <b>"
    + result.projects.length + "</b> project(s) on the portal:<ul>"
    + result.projects.map((name) => "<li>" + esc(name) + "</li>").join("")
    + '</ul><span class="chipstep">Only this affiliate\'s own - a project from another ASP '
    + 'cannot be loaded here.</span>';
  suggest("You might ask next", ["act-cards", "act-services", "affiliate-services"]);
}

async function listServicesAction(values) {
  if (!values.project) {
    bubble("bot", "That needs a project - the service IDs belong to one.");
    suggest("You might ask next", ["act-projects", "affiliate-services"]);
    return;
  }
  const say = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  let loaded = bridgeFn("loadedProject")(values.affiliate, values.version);
  if (!loaded || loaded.projectName !== values.project) {
    const result = await bridgeFn("loadProject")(values.affiliate, values.version,
                                                 values.project);
    if (!result.ok) { say.innerHTML = "Could not load it: " + esc(result.error); return; }
    loaded = bridgeFn("loadedProject")(values.affiliate, values.version);
  }
  say.innerHTML = "<b>" + esc(values.project) + "</b> offers <b>" + loaded.services.length
    + "</b> card service(s):"
    + table(["Service ID", "Name"], loaded.services.map((service) => [
      "<code>" + esc(service.serviceId) + "</code>", esc(service.name || "—")]))
    + '<span class="chipstep">ASP ' + esc(loaded.aspId)
    + " - every one of these opens with the same six digits.</span>";
  suggest("You might ask next", ["act-cards", "act-run", "affiliate-services"]);
}

async function listUsersAction() {
  const say = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  if (!trace) trace = think();
  traceStep("Reading <code>/api/records</code> - the ledger built from history.");
  const data = await safeAsync("fetchRecords", null);
  const rows = (data && data.rows) || [];
  if (!rows.length) { say.innerHTML = "No users yet - nothing has been registered."; return; }
  const recent = rows.slice(0, 10);
  say.innerHTML = "<b>" + rows.length + "</b> users registered so far. The most recent "
    + recent.length + ":"
    + table(["User ID", "Affiliate", "WV", "Project", "Card"], recent.map((row) => [
      codeShort(row.userId), esc(row.affiliate || "—"),
      esc(row.version || "—"), esc(row.projectName || "—"),
      esc(row.cardType || "none yet"),
    ]));
  suggest("You might ask next", ["act-counts", "records", "act-run"]);
}

async function countsAction() {
  const say = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  const data = await safeAsync("fetchRecords", null);
  if (!data || !data.summary) { say.innerHTML = "I could not read the records just now."; return; }
  const rows = data.rows || [];
  const per = {};
  rows.forEach((row) => {
    const key = (row.affiliate || "?") + " " + (row.version || "");
    per[key] = per[key] || { users: 0, applied: 0, physical: 0 };
    per[key].users += 1;
    if (row.cardApplyNo) per[key].applied += 1;
    if (row.cardType === "Physical / Plastic Card") per[key].physical += 1;
  });
  say.innerHTML = "<b>" + data.summary.users + "</b> users, <b>" + data.summary.applied
    + "</b> with an applied card, <b>" + data.summary.physical + "</b> physical and <b>"
    + data.summary.virtual + "</b> virtual."
    + table(["Target", "Users", "Applied", "Physical"],
      Object.keys(per).sort().map((key) => [
        esc(key), String(per[key].users), String(per[key].applied), String(per[key].physical)]));
  suggest("You might ask next", ["act-users", "act-runs", "records"]);
}

async function listRunsAction() {
  const say = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  if (!trace) trace = think();
  traceStep("Reading <code>/api/history</code>.");
  const data = await safeAsync("fetchHistory", { rows: [] });
  const rows = (data && data.rows) || [];
  if (!rows.length) { say.innerHTML = "History is empty - nothing has been sent yet."; return; }
  const recent = rows.slice(0, 10);
  const ok = (row) => typeof row.status === "number" && row.status >= 200 && row.status < 300;
  say.innerHTML = "The last " + recent.length + " of <b>" + rows.length + "</b> calls:"
    + table(["Time", "Module", "Target", "HTTP"], recent.map((row) => [
      esc(String(row.timestamp || "").replace("T", " ").slice(5, 16)),
      esc(featureLabel(row.feature)),
      esc((row.affiliate || "") + " " + (row.version || "")),
      (ok(row) ? '<b class="chipok">' : '<b class="chipbad">')
        + (row.status === null ? "—" : esc(row.status)) + "</b>",
    ]))
    + '<span class="chipstep">That is the HTTP status. History has the KONA result code '
    + 'too.</span>';
  suggest("You might ask next", ["act-counts", "history", "read-response"]);
}

function table(headers, rows) {
  return '<table class="chiptable"><thead><tr>'
    + headers.map((head) => "<th>" + esc(head) + "</th>").join("")
    + "</tr></thead><tbody>"
    + rows.map((row) => "<tr>" + row.map((cell) => "<td>" + cell + "</td>").join("") + "</tr>")
      .join("")
    + "</tbody></table>";
}

/* ------------------------------------------------------- free text match */
const STOP = ["the", "a", "an", "is", "are", "do", "does", "how", "what", "why", "can", "i",
              "my", "me", "to", "of", "in", "on", "for", "and", "it", "this", "that", "with"];

function words(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9_]+/g, " ").split(" ")
    .filter((word) => word.length > 1 && STOP.indexOf(word) === -1);
}

/* Word overlap alone gets a few sentences wrong: "apply card and card registration" is full of
   card words but asks for a run, and "what did I run recently" is full of run words but asks for
   a list. These are the phrasings that decide it, applied as a nudge on top of the score. */
/* Naming a module only means "run it" when the sentence is an instruction. "Why is bank inquiry
   empty" names a module too, and wants the explanation. */
const ASKING = new RegExp("\\b(why|what|when|which|who|where|how|does|do i|can i|should|is|are|was|were|explain|mean|meaning|difference)\\b");

const HINTS = [
  { id: "act-runs", boost: 5, test: (t) => /\b(recent|recently|lately|last (few )?runs?|history)\b/.test(t) },
  { id: "act-cards", boost: 4, test: (t) => /\b(how many|count|left|available|free|remaining|stock)\b/.test(t) && /\bcards?\b/.test(t) },
  { id: "act-counts", boost: 3, test: (t) => /\b(how many|count|totals?|summary|so far)\b/.test(t) && !/\bcards?\b/.test(t) && !/\buser/.test(t) },
  /* naming a module is an instruction only when the sentence is not asking about it */
  { id: "act-run", boost: 9, test: (t, found) => (found.modules || []).length > 0
      && !ASKING.test(t)
      && !/\b(how many|count|left|available|free|remaining|recent|list)\b/.test(t) },
  { id: "act-run", boost: 4, test: (t) => /\b(run|execute|start|fire|trigger|perform)\b/.test(t)
      && !ASKING.test(t)
      && !/\b(recent|recently|lately|history|what did)\b/.test(t) },
];

function match(question) {
  const asked = words(question);
  if (!asked.length) return [];
  const lower = " " + String(question).toLowerCase() + " ";
  const found = extract(question);
  const howTo = /how (do|can|should|would) (i|you|we)/.test(lower)
    || /what (is|does|are)/.test(lower);
  const nudge = {};
  HINTS.forEach((hint) => {
    if (hint.test(lower, found)) nudge[hint.id] = (nudge[hint.id] || 0) + hint.boost;
  });
  /* actions score a little higher than articles about the same words: someone who types
     "how many active cards" wants the number, not the paragraph about where cards come from */
  const scored = TOPICS.concat(ACTIONS.map((a) => Object.assign({ bonus: 2 }, a))).map((topic) => {
    const hay = words(topic.q + " " + topic.chip + " " + (topic.tags || []).join(" "));
    let score = 0;
    asked.forEach((word) => {
      if (hay.indexOf(word) !== -1) score += 2;                       // whole word
      else if (hay.some((h) => h.indexOf(word) === 0 && word.length > 3)) score += 1;
    });
    if (score && topic.bonus) score += topic.bonus;
    if (nudge[topic.id]) score += nudge[topic.id];
    /* "how do I run the flow" is asking to be told, not asking to be run */
    if (howTo && String(topic.id).indexOf("act-") === 0) score -= 5;
    return { topic: BY_ID[topic.id] || topic, score: score };
  }).filter((row) => row.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ------------------------------------------------------------- the panel */
/* ------------------------------------------------------------- the mascot */
/* KonaRelay is a card that stands up: a rounded card body in the console's purple, a dark visor
   with two lit eyes, the gold EMV chip on its chest, a magnetic stripe, two arms and two legs
   with lit soles, and an antenna that pulses when it is working. It is a product mascot, not a
   cartoon - no cheeks, no mouth, just the visor - so it reads the same way the console does.
   FACE is the head alone, for the round avatar in the header and beside every reply. */
const MASCOT = '<svg viewBox="0 0 80 100" width="100%" height="100%" aria-hidden="true">'
  + '<defs>'
  + '<linearGradient id="relayBody" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#9B6BFF"/><stop offset="0.55" stop-color="#6D28D9"/>'
  + '<stop offset="1" stop-color="#3C1680"/></linearGradient>'
  + '<linearGradient id="relayLimb" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#43208F"/>'
  + '</linearGradient>'
  + '<linearGradient id="relayChip" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#FFE9A8"/><stop offset="1" stop-color="#DFA73A"/>'
  + '</linearGradient>'
  + '<radialGradient id="relayEye" cx="50%" cy="40%" r="60%">'
  + '<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#9FE8FF"/>'
  + '</radialGradient>'
  + '</defs>'

  /* the shadow it floats above */
  + '<ellipse class="chipmate__shadow" cx="40" cy="95" rx="19" ry="3.6" fill="#1A0F33"'
  + ' opacity=".28"/>'

  /* legs, with lit soles */
  + '<g>'
  + '<rect x="26" y="68" width="10" height="22" rx="5" fill="url(#relayLimb)"/>'
  + '<rect x="44" y="68" width="10" height="22" rx="5" fill="url(#relayLimb)"/>'
  + '<rect class="chipmate__sole" x="26.5" y="83" width="9" height="7" rx="3.5" fill="#67E8F9"'
  + ' opacity=".95"/>'
  + '<rect class="chipmate__sole" x="44.5" y="83" width="9" height="7" rx="3.5" fill="#67E8F9"'
  + ' opacity=".95"/>'
  + '</g>'

  /* arms */
  + '<g class="chipmate__arm chipmate__arm--l">'
  + '<rect x="4" y="38" width="9" height="24" rx="4.5" fill="url(#relayLimb)"/>'
  + '<circle cx="8.5" cy="60" r="5.2" fill="#8B5CF6"/></g>'
  + '<g class="chipmate__arm chipmate__arm--r">'
  + '<rect x="67" y="38" width="9" height="24" rx="4.5" fill="url(#relayLimb)"/>'
  + '<circle cx="71.5" cy="60" r="5.2" fill="#8B5CF6"/></g>'

  /* the antenna - it pulses while it works */
  + '<path d="M40 14V7" stroke="#A78BFA" stroke-width="2.4" stroke-linecap="round"/>'
  + '<circle class="chipmate__ping" cx="40" cy="4.6" r="3.8" fill="#67E8F9"/>'

  /* the card body */
  + '<rect x="11" y="13" width="58" height="62" rx="13" fill="url(#relayBody)"/>'
  + '<rect x="11" y="13" width="58" height="62" rx="13" fill="none" stroke="#C4A9FB"'
  + ' stroke-opacity=".55" stroke-width="1.4"/>'
  + '<path d="M16 72 60 18v9L22 73z" fill="#FFFFFF" opacity=".08"/>'

  /* the visor */
  + '<rect x="17" y="21" width="46" height="24" rx="12" fill="#140C29"/>'
  + '<rect x="17" y="21" width="46" height="24" rx="12" fill="none" stroke="#67E8F9"'
  + ' stroke-opacity=".35" stroke-width="1.2"/>'
  + '<g>'
  + '<ellipse class="chipmate__eye" cx="31" cy="33" rx="5.4" ry="6" fill="url(#relayEye)"/>'
  + '<ellipse class="chipmate__eye" cx="49" cy="33" rx="5.4" ry="6" fill="url(#relayEye)"/>'
  + '</g>'

  /* the chip and the stripe - this is a card, after all */
  + '<rect x="20" y="53" width="17" height="13" rx="3.4" fill="url(#relayChip)"/>'
  + '<g stroke="#A9741B" stroke-width="1.1" stroke-linecap="round" opacity=".7">'
  + '<path d="M20 59.5h17M28.5 53v13"/></g>'
  + '<rect x="42" y="55" width="19" height="4" rx="2" fill="#FFFFFF" opacity=".42"/>'
  + '<rect x="42" y="61.5" width="12" height="3.4" rx="1.7" fill="#FFFFFF" opacity=".26"/>'
  + '</svg>';

/* the head alone, for the round avatar */
const FACE = '<svg viewBox="0 0 60 60" width="100%" height="100%" aria-hidden="true">'
  + '<defs>'
  + '<linearGradient id="relayFaceBody" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#9B6BFF"/><stop offset="1" stop-color="#4C1D95"/>'
  + '</linearGradient>'
  + '<radialGradient id="relayFaceEye" cx="50%" cy="40%" r="60%">'
  + '<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#9FE8FF"/>'
  + '</radialGradient>'
  + '</defs>'
  + '<path d="M30 7V3" stroke="#A78BFA" stroke-width="2.6" stroke-linecap="round"/>'
  + '<circle cx="30" cy="2.6" r="2.6" fill="#67E8F9"/>'
  + '<rect x="6" y="7" width="48" height="46" rx="13" fill="url(#relayFaceBody)"/>'
  + '<rect x="11" y="15" width="38" height="21" rx="10.5" fill="#140C29"/>'
  + '<ellipse class="chipmate__eye" cx="22" cy="25.5" rx="4.6" ry="5.1" fill="url(#relayFaceEye)"/>'
  + '<ellipse class="chipmate__eye" cx="38" cy="25.5" rx="4.6" ry="5.1" fill="url(#relayFaceEye)"/>'
  + '<rect x="15" y="41" width="13" height="7" rx="2" fill="#FFE9A8" opacity=".9"/>'
  + '<rect x="32" y="42.5" width="14" height="3.6" rx="1.8" fill="#FFFFFF" opacity=".4"/>'
  + '</svg>';

const SEEN_KEY = "konaChipSeen";
const SPOT_KEY = "konaRelaySpot";

let dock, panel, body, askInput, open = false, built = false;

/* the two small marks the composer uses */
const ICON_WRITE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"'
  + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M20.5 11.2a7.8 7.8 0 0 1-8.4 7.8 8.8 8.8 0 0 1-2.5-.4L4.5 20l1.4-4.3a7.6 7.6 0 0 1'
  + '-1.4-4.5 7.8 7.8 0 0 1 8-7.7 7.8 7.8 0 0 1 8 7.7z"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none"'
  + ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"'
  + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14 4h6v6M20 4l-7.2 7.2"/><path d="M10 20H4v-6M4 20l7.2-7.2"/></svg>';

function build() {
  if (built) return;

  dock = document.createElement("div");
  dock.className = "chipdock has-news";
  dock.id = "chipDock";
  const spot = savedSpot();
  place(spot ? spot.right : 22, spot ? spot.bottom : 20);
  dock.innerHTML = '<button class="chipmate" id="chipMate" type="button"'
    + ' title="Ask KonaRelay - it can run modules for you. Drag to move.">'
    + '<span class="chipmate__dot"></span>' + MASCOT + '</button>';
  document.body.appendChild(dock);

  panel = document.createElement("section");
  panel.className = "chipchat";
  panel.id = "chipChat";
  panel.hidden = true;
  panel.innerHTML =
      '<header class="chipchat__head">'
    +   '<span class="chipchat__face">' + FACE + '</span>'
    +   '<span class="chipchat__who">'
    +     '<span class="chipchat__name">KonaRelay</span>'
    +     '<span class="chipchat__role"><i class="chipchat__live"></i>'
    +     'Answers instantly · runs your modules</span>'
    +   '</span>'
    +   '<button class="chipchat__btn" id="chipBig" type="button"'
    +   ' title="Make this bigger">' + ICON_EXPAND + '</button>'
    +   '<button class="chipchat__btn" id="chipClose" type="button" title="Close">&times;</button>'
    + '</header>'
    + '<div class="chipchat__body" id="chipBody"></div>'
    + '<div class="chipchat__foot">'
    +   '<div class="chipfoot__row">'
    +     '<span class="chipfoot__hint">Pick a question, or type your own</span>'
    +     '<button class="chipfoot__reset" id="chipReset" type="button">Start over</button>'
    +   '</div>'
    +   '<form class="chipask" id="chipAsk">'
    +     '<span class="chipask__icon">' + ICON_WRITE + '</span>'
    +     '<input id="chipInput" type="text" autocomplete="off"'
    +     ' placeholder="Describe what you need...">'
    +     '<button type="submit" class="chipask__send" title="Send">' + ICON_SEND + '</button>'
    +   '</form>'
    + '</div>';
  document.body.appendChild(panel);

  body = $("#chipBody");
  askInput = $("#chipInput");

  $("#chipClose").onclick = close;
  $("#chipBig").onclick = () => {
    panel.classList.toggle("is-big");
    $("#chipBig").title = panel.classList.contains("is-big")
      ? "Back to the small size" : "Make this bigger";
    body.scrollTop = body.scrollHeight;
  };
  $("#chipReset").onclick = () => { body.innerHTML = ""; greet(); };
  $("#chipAsk").onsubmit = (event) => {
    event.preventDefault();
    const text = askInput.value.trim();
    if (!text) return;
    askInput.value = "";
    askFreeText(text);
  };
  dragging($("#chipMate"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) close();
  });
  built = true;
}

/* KonaRelay can be dragged up and down its rail; the position is remembered. */
/* Pick it up and put it anywhere. The offsets live on <html>, so the panel - which opens from
   wherever it is standing - follows it without a second source of truth. */
function place(right, bottom) {
  const root = document.documentElement.style;
  root.setProperty("--chip-right", Math.round(right) + "px");
  root.setProperty("--chip-bottom", Math.round(bottom) + "px");
}

function savedSpot() {
  try {
    const raw = localStorage.getItem(SPOT_KEY);
    if (!raw) return null;
    const spot = JSON.parse(raw);
    return typeof spot.right === "number" && typeof spot.bottom === "number" ? spot : null;
  } catch (error) {
    return null;
  }
}

function dragging(mate) {
  let moved = false, startX = 0, startY = 0, fromRight = 0, fromBottom = 0;

  mate.addEventListener("pointerdown", (event) => {
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    const box = dock.getBoundingClientRect();
    fromRight = window.innerWidth - box.right;
    fromBottom = window.innerHeight - box.bottom;
    mate.setPointerCapture(event.pointerId);
  });
  mate.addEventListener("pointermove", (event) => {
    if (!mate.hasPointerCapture(event.pointerId)) return;
    const dx = startX - event.clientX, dy = startY - event.clientY;
    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    moved = true;
    dock.classList.add("is-dragging");
    const width = dock.offsetWidth || 90, height = dock.offsetHeight || 104;
    place(Math.min(window.innerWidth - width - 8, Math.max(8, fromRight + dx)),
          Math.min(window.innerHeight - height - 8, Math.max(8, fromBottom + dy)));
  });
  mate.addEventListener("pointerup", (event) => {
    mate.releasePointerCapture(event.pointerId);
    dock.classList.remove("is-dragging");
    if (moved) {
      const root = getComputedStyle(document.documentElement);
      try {
        localStorage.setItem(SPOT_KEY, JSON.stringify({
          right: parseInt(root.getPropertyValue("--chip-right"), 10) || 22,
          bottom: parseInt(root.getPropertyValue("--chip-bottom"), 10) || 20,
        }));
      } catch (error) { /* storage blocked */ }
      return;                       // a drag is not a click
    }
    open ? close() : show();
  });
}

/* ---------------------------------------------------------- the greeting */
/* What a chat widget does that a silent icon does not: it speaks first, once. A small bubble
   pops out beside the mark a few seconds in, says what it can do, and goes away for good when
   dismissed or when the panel is opened. It never reappears after that. */
const TEASE_KEY = "konaRelayTeased";
const TEASE_AFTER_MS = 5000;
const TEASE_FOR_MS = 14000;
let teaseNode = null, teaseTimer = null;

/* Only its own flag - not "have you ever opened the panel". KonaRelay introduces itself once under
   its new name, to everyone, and then never again. */
function teaseSeen() {
  try {
    return localStorage.getItem(TEASE_KEY) === "1";
  } catch (error) {
    return false;
  }
}

function rememberTease() {
  try { localStorage.setItem(TEASE_KEY, "1"); } catch (error) { /* storage blocked */ }
}

function hideTease(permanent) {
  clearTimeout(teaseTimer);
  if (permanent) rememberTease();
  if (!teaseNode) return;
  teaseNode.classList.remove("is-in");
  const node = teaseNode;
  teaseNode = null;
  setTimeout(() => node.remove(), 260);
}

function showTease() {
  if (open || teaseSeen() || teaseNode) return;
  teaseNode = document.createElement("div");
  teaseNode.className = "chiptease";
  teaseNode.innerHTML = '<button class="chiptease__x" type="button" title="Not now">&times;</button>'
    + '<b>Need a hand?</b>'
    + '<span>I can run a module, count free test cards, or explain an error code.</span>'
    + '<span class="chiptease__cta">Ask KonaRelay →</span>';
  dock.parentNode.insertBefore(teaseNode, dock);
  /* sits beside the mark, wherever the mark has been dragged to */
  /* it sits above whatever spot the mascot has been parked in */
  teaseNode.style.bottom = "calc(var(--chip-bottom, 20px) + 108px)";
  teaseNode.style.right = "var(--chip-right, 22px)";
  requestAnimationFrame(() => teaseNode.classList.add("is-in"));

  teaseNode.querySelector(".chiptease__x").onclick = (event) => {
    event.stopPropagation();
    hideTease(true);
  };
  teaseNode.onclick = () => { hideTease(true); show(); };
  teaseTimer = setTimeout(() => hideTease(false), TEASE_FOR_MS);
}

function show() {
  open = true;
  hideTease(true);
  dock.classList.add("is-open");
  dock.classList.remove("has-news");
  try { localStorage.setItem(SEEN_KEY, "1"); } catch (error) { /* storage blocked */ }
  panel.hidden = false;
  if (!body.children.length) greet();
  setTimeout(() => askInput.focus(), 120);
}

function close() {
  open = false;
  dock.classList.remove("is-open");
  panel.hidden = true;
}

/* ------------------------------------------------------------- messaging */
/* ------------------------------------------------------------ reasoning */
/* A visible trace of how the answer was reached, in the shape Claude and ChatGPT use: a
   collapsible block that fills while the work happens and then folds away with the time it
   took. What it shows is what actually happened - the intent it matched and the score, the
   details it pulled out of your sentence, which slots were still missing, every endpoint it
   called. It is a log, not a performance: nothing is written there that did not happen. */
let trace = null;

function think() {
  const node = document.createElement("details");
  node.className = "chipthink";
  node.open = true;
  node.innerHTML = '<summary class="chipthink__sum">'
    + '<span class="chipthink__spin"></span>'
    + '<span class="chipthink__label">Thinking…</span></summary>'
    + '<div class="chipthink__body"></div>';
  body.appendChild(node);
  const host = node.querySelector(".chipthink__body");
  const started = Date.now();
  let count = 0;

  const api = {
    step: function (text, kind) {
      count += 1;
      const line = document.createElement("div");
      line.className = "chipthink__step" + (kind ? " chipthink__step--" + kind : "");
      line.innerHTML = text;
      host.appendChild(line);
      body.scrollTop = body.scrollHeight;
      return api;
    },
    done: function (word) {
      const ms = Date.now() - started;
      node.querySelector(".chipthink__label").textContent = (word || "Thought for ")
        + (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms")
        + " · " + count + " step" + (count === 1 ? "" : "s");
      node.classList.add("is-done");
      node.open = false;
      return api;
    },
  };
  return api;
}

function traceStep(text, kind) {
  if (trace) trace.step(text, kind);
}

function traceDone(word) {
  if (trace) trace.done(word);
  trace = null;
}

/* a short, readable account of what was understood from a sentence */
function traceEntities(found) {
  const bits = [];
  if (found.affiliate) {
    bits.push("affiliate <b>" + esc(found.affiliate === "ALL" ? "all of them"
      : affiliateLabel(found.affiliate)) + "</b>");
  }
  if (found.version) {
    bits.push("version <b>" + esc(found.version === "BOTH" ? "V1 and V2" : found.version) + "</b>");
  }
  if (found.project) bits.push("project <b>" + esc(found.project) + "</b>");
  if (found.modules) {
    bits.push("module" + (found.modules.length === 1 ? " " : "s ") + "<b>"
      + esc(found.modules.map((key) => featureLabel(key)).join(", ")) + "</b>");
  }
  if (found.physical !== undefined) {
    bits.push("card type <b>" + (found.physical ? "physical" : "virtual") + "</b>");
  }
  return bits.length ? "Picked out " + bits.join(", ") + "."
    : "Nothing specific in the sentence - I will have to ask.";
}

/* --------------------------------------------------------------- messages */
function bubble(kind, html) {
  const node = document.createElement("div");
  node.className = "chipmsg chipmsg--" + kind;
  node.innerHTML = html;
  if (kind === "bot") {
    /* a reply is the mark plus the bubble, so it reads as coming from someone */
    const row = document.createElement("div");
    row.className = "chiprow";
    const face = document.createElement("span");
    face.className = "chipface";
    face.innerHTML = FACE;
    row.appendChild(face);
    row.appendChild(node);
    body.appendChild(row);
  } else {
    body.appendChild(node);
  }
  body.scrollTop = body.scrollHeight;
  return node;
}

function suggest(label, ids, extra) {
  const ok = (ids || []).map((id) => BY_ID[id]).filter(Boolean);
  if (!ok.length && !extra) return;
  const wrap = document.createElement("div");
  wrap.className = "chipsuggest";
  if (label) {
    const head = document.createElement("span");
    head.className = "chipsuggest__label";
    head.textContent = label;
    wrap.appendChild(head);
  }
  if (extra) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "chipq chipq--go";
    go.textContent = extra.label;
    go.onclick = () => {
      const jump = bridge().go;
      if (jump) jump(extra.page);
      close();
    };
    wrap.appendChild(go);
  }
  ok.forEach((topic) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chipq" + (topic.run ? " chipq--act" : "");
    button.textContent = topic.chip;
    button.onclick = () => (topic.run ? startAction(topic, seedFromConsole({})) : answer(topic));
    wrap.appendChild(button);
  });
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

/* chips for an open question - free-form options rather than topic ids */
function optionChips(options, scroll) {
  const wrap = document.createElement("div");
  wrap.className = "chipsuggest";
  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chipq" + (option.go ? " chipq--go" : "");
    button.textContent = option.label;
    button.onclick = () => {
      wrap.querySelectorAll("button").forEach((node) => { node.disabled = true; });
      wrap.classList.add("is-used");
      option.onPick();
    };
    wrap.appendChild(button);
  });
  body.appendChild(wrap);
  if (scroll) body.scrollTop = body.scrollHeight;
  return wrap;
}

function greet() {
  bubble("bot", "Hi, I am <b>KonaRelay</b>. Ask me about this console, or tell me what "
    + "to run — one module or the whole chain.<br><br>"
    + "<span class=\"chipstep\">Try: “Register a user for Revamped-P1-P2-BK on "
    + "Burger King V2”</span>");
  suggest("Try one of these", STARTERS);
  /* so a typed project name can be recognised straight away */
  warmProjectNames();
}

async function warmProjectNames() {
  const targets = safe("targets", []) || [];
  for (const target of targets) {
    try {
      const result = await bridgeFn("projectsFor")(target.key, (target.versions || ["V1"])[0]);
      if (result && result.ok) {
        state.projectNames = (state.projectNames || []).concat(result.projects);
      }
    } catch (error) { /* the portal may be unreachable - KonaRelay still works */ }
  }
}

async function answer(topic) {
  bubble("me", esc(topic.q));
  const thinking = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
  dock.classList.add("is-thinking");
  let html;
  try {
    html = await Promise.resolve(topic.a());
  } catch (error) {
    html = "Something went wrong reading that - " + esc(error.message || error);
  }
  await wait(260);
  dock.classList.remove("is-thinking");
  thinking.innerHTML = html;
  body.scrollTop = body.scrollHeight;
  suggest("You might ask next", topic.next, topic.go);
}

function askFreeText(text) {
  bubble("me", esc(text));
  trace = think();
  traceStep("Read: “" + esc(text) + "”");

  /* a question is open - try to answer that first */
  if (pending && pending.slot) {
    traceStep("A question is already open: I asked for <b>" + esc(pending.slot) + "</b>.");
    if (/^(cancel|stop|never ?mind|forget it)$/i.test(text.trim())) {
      traceStep("That reads as a cancel.", "end");
      traceDone("Stopped after ");
      pending = null;
      bubble("bot", "Dropped it. What else?");
      suggest("You might ask next", STARTERS);
      return;
    }
    const slot = SLOTS[pending.slot];
    const guess = guessSlot(pending.slot, text, pending.values);
    if (guess !== undefined) {
      traceStep("Read it as <b>" + esc(String(guess)) + "</b> for that slot.", "end");
      traceDone();
      pending.values[pending.slot] = guess;
      pending.slot = null;
      askNext();
      return;
    }
    traceStep("Could not read an answer for <b>" + esc(pending.slot) + "</b> out of that.", "end");
    traceDone();
    bubble("bot", "I still need that one. " + esc(slot.ask));
    askSlot(pending.slot, slot, pending.values);
    return;
  }

  const found = extract(text);
  traceStep(traceEntities(found));
  const hits = match(text);
  if (hits.length) {
    traceStep("Best match: <b>" + esc(hits[0].topic.chip) + "</b> (score " + hits[0].score + ")"
      + (hits[1] ? ", then " + esc(hits[1].topic.chip) + " (" + hits[1].score + ")" : "") + ".");
  } else {
    traceStep("Nothing in what I know scores against that.");
  }

  /* an action wins outright, with whatever the sentence already told us filled in */
  if (hits.length && hits[0].topic.run && hits[0].score >= 3) {
    traceStep("That is an instruction, so I will do it rather than explain it.", "end");
    const prefill = seedFromConsole(extract(text));
    startAction(hits[0].topic, prefill, false, true);
    return;
  }
  if (hits.length && hits[0].score >= 2) {
    const topic = hits[0].topic;
    const others = hits.slice(1, 4).map((row) => row.topic.id);
    traceStep("That is a question. Answering from "
      + (topic.live ? "live data" : "written knowledge") + ".", "end");
    traceDone();
    const thinking = bubble("bot", '<span class="chipdots"><i></i><i></i><i></i></span>');
    dock.classList.add("is-thinking");
    Promise.resolve(topic.a()).then(async (html) => {
      await wait(260);
      dock.classList.remove("is-thinking");
      thinking.innerHTML = html;
      suggest("You might ask next", (topic.next || []).concat(others).slice(0, 4), topic.go);
    });
    return;
  }
  traceStep("Below the threshold I trust, so I will not guess.", "end");
  traceDone();
  bubble("bot", "I do not have a written answer for that one, and I will not guess at it. "
    + "Here is what I do know about - one of these may be close:");
  suggest("Try one of these", hits.length
    ? hits.slice(0, 4).map((row) => row.topic.id)
    : STARTERS);
}

/* read one slot's answer out of a typed reply */
function guessSlot(name, text, values) {
  const found = extract(text);
  if (found[name] !== undefined) return found[name];
  const lower = text.trim().toLowerCase();
  if (name === "physical") {
    if (/^(y|yes|physical|plastic)/.test(lower)) return true;
    if (/^(n|no|virtual|mobile)/.test(lower)) return false;
  }
  if (name === "project") {
    if (/^(none|no|skip|without)/.test(lower)) return "";
    const names = state.projectNames || [];
    const hit = names.find((project) => project.toLowerCase() === lower)
      || names.find((project) => project.toLowerCase().indexOf(lower) !== -1 && lower.length > 3);
    if (hit) return hit;
  }
  if (name === "modules") {
    if (/\ball\b|\bevery\b|\bwhole\b|\bchain\b/.test(lower)) {
      return (safe("features", []) || []).filter((f) => f.inChain !== false).map((f) => f.key);
    }
  }
  if (name === "affiliate" && /^(all|both|every|all of them)$/.test(lower)) return "ALL";
  if (name === "version" && /^(all|both|each|v1 and v2)$/.test(lower)) return "BOTH";
  return undefined;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ boot */
function start() {
  build();
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch (error) { /* storage blocked */ }
  if (seen) dock.classList.remove("has-news");

  /* KonaRelay notices when a Run All finishes - that is the moment someone actually wants to be
     asked "now what?", so he offers the next step instead of waiting to be opened. */
  window.addEventListener("kona:runfinished", (event) => {
    const detail = (event && event.detail) || {};
    const line = detail.cancelled ? "Your run was cancelled part way through."
      : detail.ok ? "Your run finished and every module passed."
      : "Your run finished, but something failed along the way.";
    if (!open) {
      dock.classList.add("has-news");
      return;
    }
    bubble("bot", line + " What next?");
    suggest("You might ask next",
      detail.ok ? ["records", "my-numbers", "pick-modules"] : ["last-run", "read-response", "error-003-027"]);
  });

  /* speak first, once - the way a chat widget introduces itself */
  if (!teaseSeen()) setTimeout(showTease, TEASE_AFTER_MS);

  window.KonaRelay = { open: show, close: close, ask: askFreeText, tease: showTease };
  window.KonaChip = window.KonaRelay;        /* the name it shipped under first */
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

})();
