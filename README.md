# KONA WebView Helper

Local web console for the WebView registration flow — brand purple + turquoise theme, left sidebar,
panel cards, env footer. Python stdlib only, **no pip installs**.

```
Affiliate (Burger King | iKuka)   ×   WebView version (V1 | V2)   ×   Step
```

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

**Dark mode** — the toggle sits at the right of the top bar. On first visit it follows your OS
setting and keeps following it while you change that; clicking the toggle pins your choice in
`localStorage` and it stops following. An inline script in `index.html` applies the theme before
first paint, so there is no flash of the wrong theme on load.

**Run All Modules** — one button that runs the whole chain against the selected target: User
Registration first, then every later module fed with that user's `userId`, `bankCode`,
`cardApplyNo` and so on. Each module still works on its own exactly as before; this is an extra
route through the same endpoints, not a second implementation, so the placeholder guard, the
portal card fetch and the `003_027` retry all still apply.

| Control | Meaning |
|---|---|
| **Target pills** | every affiliate × version — Burger King V1/V2, iKuka V1/V2 — pick one here |
| **Run V1 and V2, one after the other** | runs the full chain twice for the selected affiliate |
| **Apply a physical card (delivery)** | `isDeliveryRequired` for Apply Card; untick for a virtual card |
| **Stop on first failure** | off = carry on and report everything that broke |
| **Settle (s)** | pause after Bank Account Registration before the inquiry (default 8) |

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
| Registered · Affiliate · WV · User ID · Login ID | User Registration |
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

**History** — every call written to `history\` with full request + response; click a row to read it.

**Settings** — edit `config.json` in the browser, save (invalid JSON is rejected, nothing written)
or reload from disk. No restart needed.

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
          "tcIdList": ["700001", "700002"],
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
| iKuka V1 | — | **needed** | **needed** |
| iKuka V2 | — | **needed** | **needed** |

Still needed: the iKuka credentials, the cURLs for steps 2–4, and any affiliate-specific
`tcIdList` / `joinChannel` values.

## Layout

```
server.py              local web server + JSON API (send proxy, randomize, config, history)
.vscode/settings.json  Live Server config (root = web/, port 5500, ignores history & *.py)
web/index.html         the console
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
