# KONA WebView Helper

Local web console for the WebView registration flow — brand purple + turquoise theme, left sidebar,
panel cards, env footer. Python stdlib only, **no pip installs**.
 
```
Affiliate (Burger King | iKuka)   ×   WebView version (V1 | V2)   ×   Step
```
s
| Module | Endpoint | Status |
|--------|----------|--------|
| User Registration | `/web-view/api/v1/user/registration` | **working** — verified on BK V1 + V2 |
| Bank Account Registration | `/web-view/api/v1/bankaccounts/ars/register` | **working** — uses the `userId` above |
| Bank Account Inquiry | `/web-view/api/v1/bankaccounts/inquiry` | **working** — uses the same `userId` |
| PG Info Inquiry | `/web-view/api/v1/bankaccounts/pg-info/inquiry` | **working** — uses the inquiry's `bankCode` |
| Apply Card | `/web-view/api/v1/prepay-card/issue/delivery` | **working** — uses the same `userId` |
| Card Registration | `/web-view/api/v1/prepay-card/physical/register` | **working** — card pulled from the portal automatically |

All six paths are configured for **all four targets** (Burger King V1/V2, iKuka V1/V2); each call uses
the access key of the selected affiliate × version. Steps 1–5 are verified live end to end on Burger
King V1 and V2; iKuka is wired but untested pending its credentials.

### Step 5 options

Two fields on Apply Card are pickers in the Form view, driven by `features.apply_card.options`:

* **`serviceId`** — which product the card is issued against. Defaults to `000187000010000` from the
  sample cURL. It is a *suggestion list*, not a fixed choice: pick from the dropdown or type any
  other id. To add a product permanently, append to the `options.serviceId` array in `config.json`
  and it appears in the list for everyone:

  ```json
  "options": { "serviceId": [
    { "value": "000187000010000", "label": "000187000010000 — prepay card" },
    { "value": "000187000020000", "label": "000187000020000 — <your product>" }
  ] }
  ```

* **`isDeliveryRequired`** — `true` = physical / plastic card (delivered), `false` = virtual card.
  A two-value dropdown with those labels spelled out, so neither is picked by accident.

Any field in any step can be turned into a picker the same way: add `options.<dotted.path>` to that
feature. Booleans render as a strict dropdown; everything else as a type-ahead with suggestions.

### Project Name — filling ASP ID, Access Key and serviceIds from the portal

Every module page has a **Project** field in the Target panel. It is a dropdown of the projects
that **belong to the selected affiliate** - pick one and it loads itself, or press **Load from
portal**. The tool signs in to `dev-qa.konapay.net:10444`, finds that project in *My Projects*
and reads:

| From | What | Goes to |
|---|---|---|
| Summary tab | `aspId` | the `X-KM-User-AspId` field |
| Credentials tab → API Key Information | the **OASL** access key | the `X-KM-Access-Key` field |
| the project's card services | every `cardServiceId` + name | the `serviceId` **dropdown** on Apply Card |

`OASL` is the WebView/OpenAPI key — verified against both configured projects, where it matches
the keys that were already working. `OMCS` on the same screen belongs to another service and is
never used. If a project has no ACTIVE OASL key the tool falls back to the first ACTIVE key and
says so in the note under the field.

The project is remembered **per affiliate × version**, so Burger King V1 and V2 can point at
different projects, and it survives a reload. A **new sign-in starts clean**: every Project box
shows its placeholder until something is picked and loaded, on all module pages and on Run All.
With none loaded the ASP ID, access key and `serviceId` come from `config.json`, exactly as they
always have. **Save target to config** writes it into
`cardSource.projectsByTarget` so colleagues get it too. Load nothing and everything behaves exactly
as before, from `config.json`.

#### One affiliate, its own projects, its own service IDs

An ASP id and a card service id are both 15 digits opening with the same 6-digit ASP code:
Burger King is ASP `000187000000000` and owns `000187…` services, iKuka is `000163000000000` and
owns `000163…`. That code - not the project's name - is what ties a project to an affiliate, which
matters because `P1-P2-Tim Hortons-V1` is a **Burger King** project.

So the tool scopes three things to the affiliate selected in the Target panel:

| | Behaviour |
|---|---|
| Project dropdown | Only that affiliate's projects. Burger King lists 17, iKuka lists 5; neither sees the other's. `↻` re-reads the list from the portal, and **Other project…** turns it back into a free-text box. |
| Loading a project | Refused if it belongs to another ASP, with the message naming both: *'Revamped-P1 to P2-iKuka' belongs to ASP 000163000000000, but the selected affiliate is ASP 000187000000000.* |
| `serviceId` | Only the loaded project's own services - and within that project, only services whose ASP code matches it (a stray one is dropped and reported in the note). With no project loaded, only the `config.json` samples that match this affiliate's ASP are offered; the others are not shown at all. |

The project list needs one portal call per project to find its ASP (the list endpoint does not
return it), so the first load of an affiliate takes a few seconds; it is then cached for 10
minutes server-side and for the session in the browser.

Once a project is loaded, `serviceId` becomes a **dropdown** of that project's card services.
Each entry shows the bare id — `000187000010000` — and nothing else, so what you see is exactly
what is sent; the service name is the option's tooltip. A value already in the body that the
project does not offer is kept at the top of the list (tooltip: *not one of this project's card
services*) rather than silently dropped, and a **Custom…** entry turns the field back into a text
box for an id the portal has not listed. With no project loaded the field behaves as before: the
config suggestions, free text.

**Why this matters for Card Registration.** Apply Card can now issue against any service the
project offers, and the physical card must come from that same service. The card fetch therefore
prefers, in order: a serviceId you ask for explicitly, the serviceId of the **most recent
successful Apply Card** for that target, then the config default. If no unused ACTIVE card exists
for that service the fetch **stops with a message listing the services that do have cards free** —
it will not quietly hand back a card from another service, because that registers the wrong
product.

### Pulling card data from the QA portal (Card Registration)

Card Registration needs a real plastic card, which lives in the portal at
`dev-qa.konapay.net:10444` → project → **Test Data → Card Data**. The tool automates that: opening
the module fetches an ACTIVE card and fills `physicalCardNo`, `physicalCardExpDate`,
`physicalCardCVC` and `extMobileCardPar`. **Fetch card from portal** repeats it on demand. Cards
already registered through this tool (per the Records ledger) are skipped automatically, which is
what avoids `003_027 User is already mapped to card error`.

Configured under `cardSource` in `config.json` — project is chosen by the selected webview version:

| Version | Portal project | projectId |
|---|---|---|
| V1 | `P1-P2-Tim Hortons-V1` | `31201456118020001` |
| V2 | `Revamped-P1-P2-BK` | `31201031911600001` |

Add `projectsByTarget.<TARGET>.<VERSION>` if one affiliate needs a different project. `fieldMap`
maps portal columns to body fields, `statusFilter` defaults to `ACTIVE`, and `autoFetch: false`
turns off the fetch-on-open.

**Portal API notes** (discovered by reading its Next.js bundles — all in `core/card_source.py`):

* `POST /api/login` takes `{username, password}` — the password is sent **as-is** (the SPA's
  transform function is the identity). The session comes back in the `X-KM-AUTH-TOKEN` *response
  header*, not a cookie the server sets.
* **`X-KM-Accept-Language` is mandatory on every call** — without it everything fails with
  `30_999_028 Required Header is missing`. User-scoped calls also need `X-KM-UserId`.
* `GET /api/project?userEmail=…` is **case sensitive**: `kona2@yopmail.com` returns 25 projects,
  `Kona2@yopmail.com` returns 0.
* `GET /api/card-service/project/{projectId}` lists the services; the field is `cardServiceId`.
* `POST /api/test-data/card/list` `{projectId, serviceList, page, size}` →
  `{"cardInfo": [{cardNo, expiryDate, cvc, par, status, serviceId}], "pageInfo": {...}}`.
  **`serviceList` must be a list of objects keyed `serviceId`** — `[{"serviceId": "000187000010000"}]`.
  Plain strings, or objects keyed `cardServiceId`, return a bare `422 "Error from unspecified
  component::::Message not generate"` with no hint as to what is wrong.

The tool prefers a card whose `serviceId` matches the one Apply Card issued against — a project can
hold cards for several services (the V2 project holds six), and a mismatched service is a failure
you would otherwise hit.

### Why `ACTIVE` is not enough — and how 003_027 is handled

`status: ACTIVE` in the portal does **not** mean a card is free:

* a card consumed by Card Registration keeps reading `ACTIVE` for a while — it only flips to
  `TERMINATED` later (measured: still `ACTIVE` an hour after a successful registration);
* cards mapped by other testing, outside this tool, never show it at all. In the V2 project the
  first five `ACTIVE` cards of the right service were all already mapped.

So the tool defends in three layers:

1. **Never reuse** — any card this tool has sent is excluded, from `history\` and from
   `used_cards.json`.
2. **Auto-retry** — if the API answers `003_027 User is already mapped to card error`, the server
   fetches the next card and sends again, up to `cardSource.maxCardAttempts` (12). The UI reports
   which cards were skipped; the response you see is the final one.
3. **Remember** — every card that answered `003_027` is written to `used_cards.json`, so the next
   run skips it immediately. Retries inside one send never reach `history\`, so without this file
   the same dead cards would be retried forever. Delete an entry only if you know the card is free.

### Step 6 inputs

`cardApplyNo` is chained from step 5 and `userId` from step 1 — both must belong to the same user, so
they come from the selected target's session. These three identify the actual plastic card and are
meant to be typed in per run (the cURL values are offered as suggestions, not fixed):

| Field | Sample | Meaning |
|---|---|---|
| `physicalCardNo` | `1110110902360017` | the card number printed on the plastic |
| `physicalCardExpDate` | `3608` | expiry, `YYMM` |
| `physicalCardCVC` | `169` | CVC on the plastic |

`tcList` (empty) and `extMobileCardPar` come from the cURL as-is.

Normally you never type these — opening the module fills them from the portal. Known API responses:

* `003_029 Card not found.` — `physicalCardNo` is not a plastic card in inventory. A *mobile* card
  number from step 5 (`mobileCardNo`) gives this; the physical number has to come from the card itself.
* `003_027 User is already mapped to card error.` — that card is already registered to someone. It
  means a stale card number was sent; refetch from the portal, which only returns `ACTIVE` ones.

> **Timing note on step 3.** The ARS registration in step 2 is not instantly visible to the inquiry.
> Fired within a second of step 2 it can answer `200` with every `bankAcc*` field `null`, so no
> `bankCode` is captured and step 4 has nothing to use. Wait a few seconds and send step 3 again.
> Measured: null at 0.4 s, populated well before 3 min.

> **PG Info access key.** The sample cURL for step 4 carried a third key
> (`6167e69-198ef80d…`). It works, but so do both version keys — tested against all three — so the
> tool uses the selected version's key like every other step.

## Signing in

The console is behind an account. On first open you land on **`login.html`**, which offers
**Create account** when no account exists yet - the first one made is the owner of that copy.

| | |
|---|---|
| Passwords | PBKDF2-HMAC-SHA256, 240,000 rounds, a random salt per user. The password is never stored and cannot be read back; `users.json` holds only the hash, and it is git-ignored |
| Wrong password vs unknown user | the same message, and the same work done either way, so the page cannot be used to find out who has an account |
| Sessions | a random 32-byte token held server-side, valid 12 hours, sent back as `X-Kona-Session` |
| What is protected | **every** endpoint except the four `/api/auth/*` ones. The check sits in the request dispatcher, not in each handler, so a new endpoint is protected by default |
| What a stranger can learn | only whether any account exists - `/api/auth/me` returns nothing else |

Who you are signed in as sits in the **top right**, next to the light/dark switch: a circle with
your initial, your name, and the way out. In KonaRelay your own messages carry that same initial,
so the thread shows who said what. A stale token
sends you back to the gate rather than showing an empty console.

**The gate is the server, not the page.** The redirect in `app.js` is convenience; the thing
that actually refuses is the 401 from the dispatcher. Calling `/api/bootstrap` by hand without a
token returns `Sign in to use this.` - and `bootstrap` is where the access keys live.

### KonaRelay on the sign-in page

**Left alone, it flies.** After nine seconds with no mouse, key or touch on the sign-in page,
KonaRelay lights its thrusters, drops its shadow, throws its arms back and loops out and back on
a 7.5-second arc. The first sign of life lands it again, and opening the panel lands it
immediately. Only on the sign-in page - in the console there is work going on and a mascot doing
loops would be in the way. `prefers-reduced-motion` turns it off.

The sign-in page is two columns: the pitch on the left - the mark, a headline and three
lines with icons (chained links, a card with its chip, a saved record ticked) - and the sign-in
card on the right, with KonaRelay standing between them.

**The mascot wears the theme.** Every colour in it is one of the console's own variables,
written as a style property because SVG presentation attributes do not read `var()`. Change the
accent in the Theme menu, or switch to dark, and it repaints with everything else. Only the EMV
chip stays gold, because that is what a chip is.

On the sign-in page KonaRelay stands **off the right edge of the sign-in card**, level with its
middle. On a narrower window there is no room there, so it steps into the gap between the two
columns, and only then to the corner - it is never cut off and never on top of the card.
It is placed level with its middle - measured
from the card itself, so it follows the layout and stays put as the window is resized. Drag it
anywhere you like and that spot is remembered; the two pages keep **separate** spots, so moving
it on the sign-in page never shifts the one in the console, which keeps its corner.

The assistant is on the login page too, in **public mode**: `login.html` carries
`data-relay="public"`, which swaps its knowledge for six written answers - what the console is,
how it works, why not Postman, whether you need an account, where your password goes, and what it
is. In that mode it has **no actions at all** and no bridge to the console, so there is nothing
for it to run and nothing to read. The public answers name no project, no ASP, no key, no host
and no count, and they only link to each other.

## Run

```powershell
python server.py              # opens http://127.0.0.1:8770 in your browser
python server.py --port 9000 --no-browser
```

or double-click **`run.bat`**. Stop it with `Ctrl+C` in the console window.

The browser never calls the WebView APIs directly — this server proxies every call, so the access
key never leaves your machine. It binds to `127.0.0.1` only.

### Hosting the UI on Vercel (or any other host)

Vercel can serve the **UI only**. It cannot run the Python side, and more importantly a Vercel
function could never reach `10.30.210.153` — that is a private address on your own network. So the
split is: **Vercel serves the page, the Python server keeps running on your machine.**

Recommended import settings:

| Setting | Value |
|---|---|
| Framework Preset | `Other` |
| Root Directory | `web` |
| Build Command | leave empty (no build) |
| Output Directory | leave empty |
| Install Command | leave empty |
| Environment Variables | none |

Then, for the hosted page to drive your local server:

1. Add the deployment's exact origin to `server.allowedOrigins` in `config.json`
   (already set to `https://konaplate-webview-web.vercel.app`). Never put a wildcard such as
   `*.vercel.app` there — anyone can publish on that domain and would then be able to drive your
   local server while it runs.
2. Run `python server.py --no-browser` on a machine that can reach the WebView API.
3. Open the Vercel URL. The page finds `http://127.0.0.1:8770` by itself.

The local server answers the Private Network Access preflight that Chrome and Edge require before
an HTTPS page may call `http://127.0.0.1`; without that header the browser blocks the call before
it is sent. Preview deployments get their own URLs, so each one you want to use must be added to
the allowlist too.

**Want a URL colleagues can use without running anything locally?** Vercel cannot give you that.
Put the whole tool — `server.py` included — on a machine inside the network that can reach
`10.30.210.153`, and share that host's address instead.

### Running it under VS Code Live Server

Live Server only serves static files, so it **cannot replace** `server.py` — the `/api/*` calls that
proxy the WebView API, randomize fields, read/write `config.json` and store history all need Python.
Run both and it works:

1. `python server.py --no-browser` — the API, on port 8770.
2. In VS Code press **Go Live** (status bar). `.vscode/settings.json` already points Live Server at
   the `web/` folder on port 5500, and tells it to ignore `history/`, `*.py` and `*.json` so saving a
   request does not reload the page under you.
3. The page opens at `http://127.0.0.1:5500/index.html` and finds the API by itself — the sidebar's
   **API** row shows which base it locked onto.

Discovery order: `?api=` in the URL (remembered in `localStorage`) → the page's own origin → ports
8770, 8771, 8772, 8080. On a non-default port open
`http://127.0.0.1:5500/index.html?api=http://127.0.0.1:9000`. If nothing answers, the page shows a
banner telling you to start `server.py` instead of failing silently.

The API accepts cross-origin calls **only** from `127.0.0.1`, `localhost` and `::1`; any other
`Origin` gets no CORS headers.

What Live Server buys you is hot reload while editing `web/styles.css` / `web/app.js`. For ordinary
testing, `python server.py` alone is simpler — it serves the same page on 8770.

## The screens

**Appearance** — the **Theme** button in the top bar opens a small menu with two modes:

| | |
|---|---|
| **Default** | the palette the console ships with. It writes nothing of its own; the stylesheet decides |
| **Customised** | your own accent colour (eight presets or any colour you pick), font (System / Grotesk / Serif / Mono) and button shape (Rounded / Pill / Square) |

Customising writes a handful of CSS variables onto `<html>`, which is all the rest of the
stylesheet reads — so one colour repaints every button, link, focus ring, chip and badge, in
light and dark alike, with no second set of rules anywhere. The choice is remembered, and the
font and button shape are applied by the no-flash script in the page head so there is no flicker
on load.

**Nothing you choose can make text unreadable.** The shades are not guessed: the link colour is
darkened (or lightened, in dark mode) a step at a time until it measures **4.6:1** against the
surface, the button fill is pushed until either white or near-black clears 4.6:1 on it, and
whichever of those two wins becomes the label colour. Checked across all eight presets and
awkward picks like pure yellow and near-black, in both themes: **0 failures**.

**The default palette** is taken from installonair.com: their brand blue `#149FFF` with the
`#39BFD3` cyan second, on their near-white ground (`#FBFBFB`, `#C8DADF` lines, `#0F3C4B` text).
Two deliberate departures, both for readability: light-mode text and button fills use a deeper
shade of the same blue, because white on `#149FFF` is 2.8:1. The brand colour itself is kept for
glows, rings and focus, and in dark mode it carries near-black text at 6.5:1.

**Dark mode** — the toggle sits at the right of the top bar. On first visit it follows your OS
setting and keeps following it while you change that; clicking the toggle pins your choice in
`localStorage` and it stops following. An inline script in `index.html` applies the theme before
first paint, so there is no flash of the wrong theme on load.

**Run All Modules** — one button that runs the modules you tick against the selected target:
User Registration first, then every later module fed with that user's `userId`, `bankCode`,
`cardApplyNo` and so on. All six are ticked by default, so the button still means "the whole
chain" until you say otherwise. Each module still works on its own exactly as before; this is an extra
route through the same endpoints, not a second implementation, so the placeholder guard, the
portal card fetch and the `003_027` retry all still apply.

| Control | Meaning |
|---|---|
| **Target pills** | every affiliate × version — Burger King V1/V2, iKuka V1/V2 — pick one here |
| **Project** | optional: load a portal project to supply the ASP ID, access key and service IDs |
| **Service ID** | which of that project's card services to apply on; blank = the config default |
| **Modules** | one tick box per module - run four of the six, or just one. **Select all** / **Clear all** toggles them together, and the choice is remembered between sessions |
| **Physical Card (delivery)** | `isDeliveryRequired` for Apply Card; untick for a virtual card. It is indented under Apply Card because it is a property of that module, not a module of its own |
| **Run V1 and V2, one after the other** | runs the selection twice for the selected affiliate |
| **Stop on first failure** | off = carry on and report everything that broke |
| **Settle (s)** | pause after Bank Account Registration before the inquiry (default 8) |

The **Project** field works exactly as on the module pages, but is bound to the run target, and
each affiliate × version remembers its own. So "run V1 and V2" uses the right project, ASP ID and
access key for each leg. A project also makes a target with no configured key runnable — the key
comes from the portal — which is how iKuka becomes usable without editing `config.json`. Leave it
empty and the run behaves exactly as before, on the config values.

**What a partial selection means.** A run that includes User Registration starts a clean session
for that target, exactly as before - a new user, and nothing carried over. A selection *without*
it keeps the session, so ticking only Apply Card and Card Registration chains onto the last user
created for that target. The note under the tick boxes spells out what the current selection will
use before you run it (the `userId` it will reuse, a missing `cardApplyNo`, a virtual card with
Card Registration still ticked), and the server's placeholder guard still refuses to send a
request with an unresolved `{{...}}` in it.

The **Service ID** dropdown lists that project's card services by bare id. The run applies cards on
the one you pick and then fetches the physical card from the same service, so Apply Card and Card
Registration cannot drift apart.

The run has **its own target**, so you can fire a V2 run without disturbing the module page you
were on. It mirrors whatever the module pages are set to until you click a pill here, after which
it stays where you put it. A target with no access key yet (iKuka, today) is shown marked
`· no key` rather than hidden: selectable, and the moment you add the key in Settings it becomes
runnable — press **Refresh** and the pills re-read the config.

It starts each target from a clean session so a stale `cardApplyNo` cannot leak into Card
Registration, and it handles the ARS delay: if Bank Account Inquiry answers `200` with no bank
account yet, it waits and retries up to three more times before moving on. Progress is shown per
module, live, with a summary line per version. **Cancel** stops after the request in flight;
**Refresh** clears the results and re-reads config so the next run starts clean.

**Modules** — the sidebar lists every step in flow order (User Registration, Bank Account
Registration, Bank Account Inquiry, PG Info Inquiry, Apply Card, Card Registration). Pick one to work
on it; a module with no endpoint configured is greyed and marked *not set*. The selected module's
page shows:

* **TARGET** — affiliate and webview pills; Base URL, `X-KM-User-AspId`, `X-KM-Access-Key`,
  `X-KM-Time-Zone`, timeout. `Test connection` does a TCP check and colours the sidebar dot.
  `Save target to config` writes these back into `config.json`.
* **REQUEST** — method + path, then three tabs:
  * *Form* — one labelled row per body field, nested objects grouped (`addressInfo`), arrays edited
    as comma-separated lists. Fields regenerated on every send carry a purple **AUTO** tag.
  * *Raw JSON* — the same body as text; the two views stay in sync.
  * *Extra headers* — `Key: value` per line, added to the generated headers and overriding them on
    name clash.
  * Buttons: **Send Request** (or `Ctrl+Enter`), Randomize, Reset from config, Copy cURL,
    Save body → this target, Save body → shared default.
* **RESPONSE** — status chip + timing, with Body / Response headers / Sent headers / cURL tabs.
  A response belongs to one module on one target, so it is cleared back to *IDLE* whenever you
  switch module, affiliate or webview version — you never read a stale result under a new heading.
* **SESSION** — values captured from successful responses; click a chip to copy its `{{placeholder}}`.

**Records** — the ledger of what has been created: one row per card application, with a user that
has no application still getting a row.

| Column | Source |
|---|---|
| Registered · Affiliate · WV · Project Name · User ID · Login ID | User Registration |
| Card Apply No · Mobile Card No | Apply Card |
| Physical Card No | Card Registration |
| **Card Type** | derived — see below |
| **Next step** | an action button for whatever that row still needs |

The label is derived from how far that card got:

* **Physical / Plastic Card** — Apply Card *and* Card Registration both succeeded
* **Mobile / Virtual Card** — Apply Card succeeded, no physical registration yet
* **No card** — the user is registered but has applied for nothing

**Carrying on from a row.** The ledger knows what each user is missing, so it can start the next
step for you:

* *No card* → **Apply card**
* *Mobile / Virtual Card* → **Register card**
* *Physical / Plastic Card* → `complete`, nothing to do

The button switches to that row's own affiliate and webview version, loads **that user** into the
session (`userId`, `cardApplyNo`, login details) and opens the module — so you resume the user you
clicked, not whoever ran last. On Card Registration the portal card fetch then runs as usual. Note
it replaces the session for that target, which is the point: you are choosing a specific user. A
row from before affiliate/version tracking shows *unknown target* instead, since it cannot be
resumed safely.

The table is rebuilt from `history\` on every visit, so it is retroactive: runs made before the
screen existed appear in it. A filter box matches any column, hovering a row shows `serviceId`, the
delivery flag, the basic card number and the registration time, and **Download CSV** exports every
row with those extra fields included. Turning off *Save history* on a send keeps that call out of
the ledger.

**History** — every call written to `history\` with full request + response, including the Project Name it ran under; click a row to read it. Calls made before project support existed show a dash there.

**Settings** — edit `config.json` in the browser, save (invalid JSON is rejected, nothing written)
or reload from disk. No restart needed.

### How It Works - the animated explainer

Under **FLOW** in the sidebar: the six modules left to right, each lighting up in turn while a
packet carries the captured value (`userId`, `bankCode`, `cardApplyNo`) across to the next one.
Dashed lines come down from the **KONA PLATE User Portal** into Apply Card and Card Registration,
and the **Session** bar below fills with chips as the values are captured - each chip under the
step that produced it.

**Nothing moves until you press Play.** Opening the page draws the diagram and waits - no step is
highlighted, no timer is running. It then plays through **once** and stops on the finished
picture. One button does all of it: *Pause* while it runs, *Play* to carry on from a pause,
*Play again* once it has finished. Nothing starts or restarts on its own. Clicking any step pins it and explains what it needs, what it captures and
which endpoint it calls.

**Download MP4** records the chain as a video file. A browser cannot film part of a page, so
`web/flowvideo.js` draws the same diagram onto a canvas from the same data (shared through
`window.KonaFlow.data`, one source of truth for both renderers) and captures it with
`MediaRecorder` - 1704x816, 30fps, about 25 seconds. The clip carries the step panel too, so the
video explains each step rather than just animating it. H.264 recording needs Chrome or Edge 126 or
later; when the browser cannot encode it, nothing is downloaded silently in another container -
the panel says so and offers WebM as an explicit choice. The clip is captured in real time, so the
tab has to stay in front while it records.

The animation only runs while the page is on screen - `showPage()` stops it on the way out, so no
timer ticks behind the other pages. It also respects `prefers-reduced-motion`.

The written version, for someone who has never opened the tool, is **`docs/HOW-IT-WORKS.md`**.

### KonaRelay, the built-in agent

**The mascot** is the product, standing up: a rounded card body in the console's purple, a dark
visor with two lit eyes, the gold EMV chip on its chest, a magnetic stripe, two arms and two legs
with lit soles, and an antenna on top. It floats, its shadow breathes with it, it blinks, and it
waves when you point at it. While it is working the antenna pulses fast and the eyes narrow into
a scan, so you can see it thinking without opening the panel. The round avatar in the header and
beside every reply is the same character's head.

**Pick it up and put it anywhere.** Dragging moves it freely in both directions, not just up and
down one edge; the spot is remembered, and the panel opens from wherever it is standing (both
read the same `--chip-right` / `--chip-bottom` on `<html>`, so there is one source of truth).

Its panel opens above it: round avatar, name, live status dot, an expand control that doubles the
panel, and a close. **The panel is the same size wherever the mascot stands** - 560px tall, or as
much of that as the window allows. Sitting above the mascot is a preference, not a rule: dragged
to the middle or the top there is no room above, so the panel slides down until it fits, and
overlaps the mascot rather than shrinking into a letterbox. It travels with the mascot while you
drag, and re-fits when the window is resized.

**Opening it moves the mascot out from behind it** - down to the panel's bottom-right corner,
where it stays visible and is still what you click to close. Closing puts it back exactly where
you left it. The panel is always measured from that parked spot rather than from wherever the
mascot is standing at the moment, so opening cannot chase it across the screen. The composer is one rounded field - a mark on the left, the text box, a round
send button. It pings until it has been opened once, and again whenever a Run All finishes.

**KonaRelay** is named for what the console does: hand the value from each call to the next one. It is an *agent* over this tool's own knowledge and controls - not a language model.
Every answer is written in `web/assistant.js`, and the ones about your own data are read live
from the console through `window.KonaConsole` (a read-only bridge exposed by `app.js`). A QA tool
should not improvise an answer about an access key or an error code, so when nothing matches he
says so and offers the closest topics instead of guessing.

**What he can do**, as opposed to explain - seven actions, each one declaring the facts it
needs:

| Action | Asks for | Does |
|---|---|---|
| Run a flow for me | affiliate, version, project, modules, card type | drives the Run All page and reports the result |
| **Find the ASP ID** | affiliate, project | loads that project and shows its ASP ID, project ID and service count |
| **Access key for this project** | affiliate, project | the ACTIVE OASL key, and what OMCS is |
| **Service IDs** | affiliate, project | every card service with its name |
| **Active / free cards** | affiliate, version, project | per service: how many are free, and the next card numbers up |
| **Used / terminated cards** | affiliate, version, project | what this tool has already sent, and what the portal no longer lists as ACTIVE - counted separately, because they are different things |
| List the projects | affiliate | that affiliate's portal projects |
| List the users I created | - | the latest users with their card status |
| Give me the counts | - | users, applied, physical, virtual, per target |
| List my recent runs | - | the last calls with module, target and HTTP status |

The five project questions share one lookup: pick the affiliate, pick the project, and the portal
is read once - a second question about the same project reuses what is already loaded. Each one
hands on to the questions that usually follow it and never back to itself:

```
Find the ASP ID  ->  Access key  ->  Service IDs  ->  Active / free cards  ->  Run a flow
                                          \                                                              \                   ->  Used / terminated cards
                                            ->  Used / terminated  ->  Error 003_027
```

**Plain instructions work.** KonaRelay reads the module out of how people actually say it, not just
from its exact label:

| You type | It runs |
|---|---|
| *Register a user for Revamped-P1-P2-BK on Burger King V2* | User Registration, that project, BK V2 |
| *Apply a card for iKuka V1 with a virtual card* | Apply Card, `isDeliveryRequired: false` |
| *Register the bank account on Burger King V1* | Bank Account Registration |
| *Without CI- Auto Recharge for Burger King V2* | that variant, not the two separate modules |
| *Run the whole chain for all affiliates on both versions* | four runs: BK V1, BK V2, iKuka V1, iKuka V2 |

Anything already in the sentence is pulled out and not asked for again; the affiliate and version
default to the page you are on, and only the gaps are asked for. **All affiliates** and **both
versions** expand into a matrix of runs, executed one after the other with a per-target result
table at the end. A project belongs to one affiliate, so when several affiliates are named each
one uses whatever it already has loaded rather than being forced onto a project that is not its
own.

Naming a module is only an instruction when the sentence is not asking about one: *"why is bank
inquiry empty"* still gets the explanation, *"how do I run the flow"* still gets the how-to. The
one action that changes anything - running - always shows a confirmation naming exactly what will
happen before it sends.

It executes through `window.KonaConsole.runFlow()`, which sets the Run All controls and calls the
same `runAll()` the button calls, on the page where you can watch the steps. There is no second
execution path, so the placeholder guard, the portal card fetch and the `003_027` retry all still
apply.

**"How many ACTIVE cards are left?"** is answered by `/api/card-stock`, which counts per service:
total, ACTIVE, and **free** - ACTIVE minus every card this tool has already sent. Those are
different numbers, because the portal keeps showing a spent card as ACTIVE, and the free count is
the one that decides whether the next Card Registration can run.

**It behaves like a chat widget.** It speaks first - five seconds in, a small bubble pops out
beside the mark offering what it can do, dismissible and shown only once ever. Every reply carries
the mark beside it, so an answer reads as coming from someone, and the panel header shows a live
status dot. The mark itself stays where you put it: in its reader slot on the right edge, draggable.

**When it does not know, it says so in one line.** Three cases, three short answers:

| | |
|---|---|
| Something close | *"I am not sure I follow. Did you mean one of these?"* with the nearest two or three |
| A module named, no verb - *"bank account"* | *"I know Bank Account Registration, but not what you want with it."* |
| Nothing at all - *"tell me a joke"* | *"I do not know that one. I only cover this console - its modules, its data and its errors."* and the chips for what it does cover |

Confidence is measured on the words alone, before the ranking nudges, and a weak score only
counts when it accounts for the **whole** question. That is what stops *"who won the match"* being
answered with a list of users because it happens to contain "who": one stray word out of three is
an offer, not an answer.

**It shows its reasoning.** Every answer carries a collapsible **Thinking** block, in the shape
Claude and ChatGPT use: it fills while the work happens and folds away with the time it took and
the number of steps. What it shows is what actually happened - the intent it matched and its
score, the details pulled out of your sentence, which slots were still missing, every endpoint it
called, and the figure it ended on. It is a log, not a performance: nothing is written there that
did not happen.

**How the conversation moves:** each topic carries a `next` list - the questions that usually
follow it - which is what fills the **You might ask next** chips. Ask about Apply Card and he
offers the physical-vs-virtual difference and where the cards come from; ask about `003_027` and
he offers the "no unused ACTIVE card" case next. Free text is matched against each topic's words
and tags.

He covers 31 topics: the six modules and how they chain, Run All and partial selections, Project
Name / ASP / access keys / affiliate-scoped service IDs, the portal card source, the error codes
(`000_000`, `003_027`, `000_015`, `30_999_028`), Records and History, where to change a request
body, and three live ones - what is loaded right now, what happened in the last run, and how many
users and cards exist so far.

**Wiring a real model in** is one server route: post the question plus a short context block to
the Claude API and render the reply in the same bubble. The chips and the live-data answers stay
useful either way, so that is an addition rather than a rewrite.

### Long values are shortened on screen, never in the request

A captured identifier like `CA20261116135151600472` is shown with its middle removed -
`CA2026111...600472` - wherever it appears beside a label, in the Session chips, in the Run All
summary, in the Records table and in KonaRelay's replies. Both ends are kept, because that is what
people check, and the full value is always on the element's tooltip.

One rule, `shorten()` in `app.js`, shared with the assistant through the bridge so the two cannot
drift. It is **display only**: the request body, the raw JSON box, the response panel and the CSV
export all carry the full value, and the Records filter still searches the full text, so a search
for a complete `cardApplyNo` matches a row that shows it truncated.

Only opaque identifiers are cut. A project name, a login or a date is meant to be read, so it is
left whole however long it is.

## How a request is built

1. **Headers**, generated fresh per send:
   * `X-KM-User-AspId`, `X-KM-Access-Key` — from the selected target, editable in the TARGET panel
   * `X-KM-Correlation-Id` — auto `yyMMddHHmmss-<7 digits>`
   * `X-KM-Tran-Time` — auto `yyyyMMddHHmmss` *(the original cURL had an unevaluated JS snippet here)*
   * `X-KM-Time-Zone`, `Content-Type` — from config / the TARGET panel
   * plus anything in the Extra headers tab
2. **Body** = `features.<step>.body` deep-merged with `features.<step>.overrides.<TARGET>.<VERSION>`.
3. **Randomized per send** (`Randomize before send` on by default) — only these; everything else is
   taken from the body exactly as configured:
   * `ci` — 88 chars total, `KONAPL` prefix + random alphanumerics (same length as the sample)
   * `loginId` — 8 random lowercase/digit chars + `@yahoo.com`
   * `email` — 9 random lowercase/digit chars + `@yahoo.com`

## Where to change input parameters

1. **`config.json`** — the master file: base URLs, ASP IDs, access keys, endpoint paths, default
   bodies, per-affiliate/version overrides, random-field rules. Edit on disk or in **Settings**.
2. **In the UI, for one run** — type into the form, the Raw JSON box, the path or the credential
   fields. Nothing is persisted.
3. **Save buttons** — `Save body → this target` (override for the selected affiliate+version),
   `Save body → shared default` (all of them), `Save target to config` (URL, AspId, key, path).

### Examples

Default for everyone:

```json
"features": { "user_registration": { "body": { "loginPassword": "112233" } } }
```

iKuka V2 only — deep-merged, so list just what differs:

```json
"features": {
  "user_registration": {
    "overrides": {
      "IKUKA": {
        "V2": {
          "joinChannel": "IKUKA_APP",
          "tcIdList": ["668151"],
          "addressInfo": { "addressDetail": "9층" }
        }
      }
    }
  }
}
```

Also randomize the mobile number (its rule already exists under `randomFields`):

```json
"features": { "user_registration": { "randomize": ["ci", "loginId", "email", "mobileNumber"] } }
```

Change the CI shape — `length` is the total including the prefix:

```json
"randomFields": { "ci": { "type": "token", "length": 88, "prefix": "KONAPL", "charset": "alphanumeric" } }
```

Names in `randomize` may be dotted paths (`addressInfo.zipCode`) as long as a matching rule exists in
`randomFields`. Types: `token`, `email`, `mobile`, `digits`, `uuid`, `fixed`.

## Chaining the four steps

Each successful response feeds the **Session** panel: the randomized values actually sent
(`ci`, `loginId`, `email`, `mobileNumber`) plus any of `defaults.captureKeys` (`userId`,
`bankAccRegNo`, `cardNo`, `accessToken`, …) found anywhere in the response JSON. Reference them in
any later body:

```json
{ "userId": "{{userId}}", "bankCode": "020" }
```

**The session is kept per affiliate × webview version.** A `userId` created under Burger King V1
lives in the `BURGER_KING|V1` slot and is only used while that target is selected; switching to V2
shows V2's own values, so step 2 always registers the bank account against the user that step 1
created on that same target. The panel header names the slot, and a note lists which other targets
currently hold values. Sessions survive a page reload (`localStorage`), which matters under Live
Server since saving a file reloads the page.

**Switching version loads that version's last run.** If the slot you switch into is empty — a fresh
browser, another machine, or a flow you ran from a script — the tool seeds it from `history\`:
the newest successful User Registration *for that exact target*, plus everything later belonging to
that same `userId` (`bankAccRegNo`, `bankCode`, `cardApplyNo`, the mobile card fields). So moving
V2 → V1 gives you V1's most recent user, never V2's. A slot that already has a live session in the
tab is left alone; **Load latest from history** in the Session panel forces a refresh from disk.

A field whose whole value is a placeholder keeps the captured **type** — `"userId": "{{userId}}"`
sends the number `50001168506`, not a string. In the Form view each placeholder shows a green
`→ value` tag when it resolves for the selected target, or a red *no value yet* tag when step 1 has
not been run there.

Substitution happens at send time, so the later bodies are written once and reused for every
registered user.

A body that still contains an unresolved `{{placeholder}}` is **never sent**. The UI blocks it with
a message naming the missing value and the target, and the server refuses it as a backstop — so a
missing `bankCode` shows up as "run the earlier step first" rather than as a puzzling
`000_015 size must be between 3 and 3` from the API. The toast after each send also lists what was
captured, or says *nothing captured from the response*.

## Still needed from you

Burger King V1 and V2 are both configured and verified. Note that for user registration they share
the **same path and AspId** — only the access key differs:

| Target | Path | AspId | Access key |
|---|---|---|---|
| Burger King V1 | `/web-view/api/v1/user/registration` | `000187000000000` | `6167e69-bb878da6…` |
| Burger King V2 | `/web-view/api/v1/user/registration` | `000187000000000` | `6167e69-a0f12213…` |
| iKuka V1 | — | `000163000000000` | from the portal project |
| iKuka V2 | — | `000163000000000` | from the portal project |

iKuka's ASP ID is now in `config.json` (read from its own projects' Summary tab), and its access
key comes from whichever iKuka project you load - so iKuka runs without anything further being
pasted in. Still useful: the iKuka cURLs for steps 2–4, in case its bodies differ from Burger
King's.

### What a module counts AS - `role`

Records and the session seed used to key on the literal feature name `user_registration`, so a
user created by **Without CI**, **Without CI- Auto Recharge**, **Auto Recharge** or **Auto
Recharge- Change Account** was registered on the real system and then **never appeared in
Records** - 52 users in history, 46 in the table.

A feature now has a **role**: `role` from config if it sets one, otherwise its `parent`,
otherwise its own key. A variant counts as the module it sits under, and the two Auto Recharge
modules carry an explicit `"role": "user_registration"` because the cURL they were built from
calls `/user/registration` (change that field when their real endpoint is wired in).

The role is used by:

| | |
|---|---|
| `build_records()` | which responses create a user row, apply a card, or register one |
| `latest_session()` | which record anchors a target's session |
| the Run All loop | a variant still gets `isDeliveryRequired`, the settle pause and the empty-inquiry retry |
| Run All's session reset | a run counts as creating a user if any ticked module has that role |

Verified after the fix: Records shows every user across all four targets, and a fresh **Without
CI** run on Burger King V1 landed in Records, in History with its project name, and in that
target's session seed.

### Tooltips on a module

A feature can carry a `tooltip` in `config.json` - a list of lines shown on hover wherever that
module is offered: its variant pill, and its Run All tick box. Anything carrying one is marked
with a small (i), so the hover is discoverable rather than hidden.

**Auto Recharge** has one, holding the ARS test account that request expects - bank code, bank
name, date of birth, account number, account holder, and the note that the mobile number has to
be one that can receive ARS calls.

### Variants - several cURLs behind one module page

A feature with `"parent": "<key>"` is a **variant**: it does not get a sidebar entry, it appears
as a pill in the **Request** row on its parent's page. Switching pills loads that variant's own
endpoint, body and overrides. Nothing is shared or merged, and every field stays editable on the
form and in the Raw JSON box.

| Page | Pills |
|---|---|
| User Registration | User Registration · **Without CI** · **Without CI- Auto Recharge** |
| Bank Account Registration | Bank Account Registration · **Auto Recharge** · **Auto Recharge- Change Account** |

**The Without CI pair carries no `ci` field**, which needed one more thing: `randomize` lists only
`loginId` and `email` for them, because `set_by_path` *creates* a missing key - listing `ci` there
would have put a `ci` back into a body that deliberately has none.

They also use `dispostable.com` addresses rather than the usual `yahoo.com`, so a feature can now
carry its own **`randomFields`**, deep-merged over the global ones. Same mechanism, no leaking:
User Registration still randomises `ci` and still gets `yahoo.com`.

Their `tcIdList` types are kept exactly as pasted - strings in one, numbers in the other.

Both verified live on Burger King V2 (the key in their cURLs): HTTP 200, `000_000 Success`,
no `ci` in the sent body, `userId 50001169723` and `50001169724`.

### The two Auto Recharge modules

**Auto Recharge** and **Auto Recharge- Change Account** live **on the Bank Account Registration
page**, not in the sidebar. A `"parent": "bank_account_registration"` entry turns a feature into a
variant: the sidebar lists the parent only, and the page grows a **Request** switcher with one
pill per variant. Any feature can declare a parent the same way.

They stay three completely separate requests - separate `body`, separate endpoint, separate
per-affiliate overrides, separate history entries. Switching pills loads that variant's own
request; nothing is merged or carried across:

| Pill | Endpoint | Body |
|---|---|---|
| Bank Account Registration | `/bankaccounts/ars/register` | 9 fields, the ARS body |
| Auto Recharge | `/user/registration` | 12 fields, `loginId w1alnrc1m@...` |
| Auto Recharge- Change Account | `/user/registration` | 12 fields, `loginId w1alntuc1m@...`, `birthDate 19820716` |

Two things to know about both new ones:

- **It is not part of the chain.** It carries `"runAllDefault": false`, so it is unticked in Run
  All unless you tick it - the six-step chain runs exactly as it always has. Any feature can opt
  out the same way.
- **Both cURLs are the User Registration one.** Their path is
  `/web-view/api/v1/user/registration` and their bodies are user bodies, so as they stand the
  modules register a user. Give each the real auto-recharge endpoint and body and it becomes the
  module its name describes - only its `endpoints.<key>` entry and the feature's `body` need to
  change.

**The Change Account cURL carries a different access key**, `6167e69-15cc...07e1e`, which is
neither of the two in `config.json`. It belongs to the portal project **`Revamped-P3-P4-BK`**
(Burger King ASP, ACTIVE OASL key) - found by walking the account's projects and reading each
Credentials tab. Load that project in the **Project** field and the ASP ID and key come from it,
which is exactly what that field is for; no per-module key override is needed.

Both are wired like every other module: per-affiliate `tcIdList` (Burger King `664156, 664160`,
iKuka `668151`), `ci` / `loginId` / `email` randomised on every send, their own sidebar icons, and
history and Records entries. Both verified live on Burger King V1 - HTTP 200, `000_000 Success`,
`userId 50001169704` and `50001169706` captured.

### Test case IDs (`tcIdList`)

User Registration reports its run against the affiliate's QA test cases, so the list is
per-affiliate and set as an override, not shared:

| Affiliate | `tcIdList` | Where |
|---|---|---|
| Burger King | `["664156", "664160"]` | `features.user_registration.overrides.BURGER_KING.V1` and `.V2` |
| iKuka | `["668151"]` | `features.user_registration.overrides.IKUKA.V1` and `.V2` |

All four slots are set explicitly, so no affiliate inherits another's IDs from the shared default
body. `tcIdList` appears only in the User Registration payload - the other five modules' APIs do not
take it.

## Layout

```
server.py              local web server + JSON API (send proxy, randomize, config, history)
.vscode/settings.json  Live Server config (root = web/, port 5500, ignores history & *.py)
web/appearance.js      the Theme menu: presets, derived shades, the contrast fitting
web/appearance.css     that menu's styling
web/login.html         the sign-in page, with KonaRelay in public mode
web/login.js           sign in / create account, and the token every later call carries
core/auth.py           accounts and sessions: hashing, verification, token lifetime
web/index.html         the console
web/flowchart.js       the How It Works diagrams: SVG builders plus the stage director
web/flowchart.css      diagram styling, all of it theme tokens so dark mode needs no second set
web/flowvideo.js       the canvas twin of the chain diagram, recorded to MP4 by MediaRecorder
web/assistant.js       KonaRelay, the built-in agent: topics, actions, reasoning trace, the mark
web/assistant.css      KonaRelay's styling - the reader slot, the mark's animations, the chat sheet
web/styles.css         light + dark themes, both pure token swaps on [data-theme].
                       --accent is purple for TEXT, --accent-fill is purple as a BACKGROUND,
                       --on-accent is what sits on it; they diverge in dark mode because a
                       purple readable on a dark card is too light to carry white text.
                       Audited: 44 light pairs and 50 dark pairs, all >= WCAG AA.
web/app.js             front-end logic (dynamic form, session, history, settings)
config.json            all inputs: targets, bodies, overrides, random rules
core/config_store.py   load/save config, deep-merge overrides, capture-key search
core/randomizer.py     ci / loginId / email / mobile generators
core/api_client.py     header building, stdlib HTTP send, cURL rendering
history/               auto-saved request + response records
used_cards.json        physical cards already sent or found already-mapped - never offered again
app.py                 optional older Tkinter desktop version of the same tool
```
