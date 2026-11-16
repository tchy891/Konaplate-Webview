# KONA WebView API Console — how it works

*For QA engineers, developers and managers who have not used this tool. No setup knowledge
assumed. If you just want the picture, open the console and click **How It Works** in the sidebar —
the animation there tells the same story, and **Download MP4** saves it as a video you can send
to someone.*

---

## 1. What problem it solves

Testing the KONA PLATE WebView APIs by hand means six requests in Postman or six cURL commands,
in a fixed order, where **each one needs a value that only the previous one can give you**. Register
a user, copy its `userId` into the next request, send that, copy the `bankCode` out of the reply,
and so on. Every run also needs a fresh identity, because the API rejects a user that already
exists. Then there is a seventh chore: a real plastic card number, which lives on a different
system entirely — the QA portal.

Done by hand, one complete pass is ten minutes of copying, and a single mistyped field sends you
back to the start.

This console does the whole pass in about twenty seconds, and keeps a record of every one.

---

## 2. The chain — six calls that feed each other

| # | Module | What it does | Needs | Hands on |
|---|---|---|---|---|
| 1 | **User Registration** | Creates a brand new test user | nothing | `userId` |
| 2 | **Bank Account Registration** | Registers a bank account through ARS | `userId` | `bankAccRegNo` |
| 3 | **Bank Account Inquiry** | Reads the account back | `userId` | `bankCode`, `bankAccount` |
| 4 | **PG Info Inquiry** | Checks the payment gateway for that bank | `bankCode` | confirms |
| 5 | **Apply Card** | Applies for a card on a chosen service | `userId`, `serviceId` | `cardApplyNo` |
| 6 | **Card Registration** | Maps a real plastic card to the application | `cardApplyNo`, a live card | done |

Two things make this work without copy-paste.

**The session.** Every reply is scanned for useful values — `userId`, `bankCode`, `cardApplyNo`
and about fifteen others — and they are held in a panel on screen. Any request field written as
`{{userId}}` is filled from there the moment you press Send.

**It is kept per affiliate and per WebView version.** A user created on Burger King V1 never
leaks into V2 or into iKuka. Switch version and the tool loads *that* version's own last user, so
you cannot accidentally register a bank account against the wrong one.

If a placeholder has no value yet, the server refuses to send at all. That refusal exists because
of a real bug: a `{{bankCode}}` that went out as literal text came back as error `000_015`, which
looks like a length problem and sends you hunting in the wrong place.

### What gets randomised

`ci`, `loginId` and `email` are regenerated on **every** send, so no run can collide with an
existing user. `ci` keeps its original length and prefix. Everything else comes from the request
body as you see it on screen. More fields can be added to the randomise list in `config.json`.

---

## 3. Who you are testing as — affiliate, version, project

Three selections decide where a request goes and who it claims to be.

- **Affiliate** — Burger King or iKuka. Each is an ASP on the KONA side.
- **WebView version** — V1 or V2. Same endpoint paths; different access key and project.
- **Project** — a project on the QA portal, which supplies the credentials.

Pick a project and the tool signs in to the portal, finds it in *My Projects* and reads three
things straight out of it:

| From the portal | Goes to |
|---|---|
| Summary tab → `aspId` | the `X-KM-User-AspId` header |
| Credentials → API Key Information → the ACTIVE **OASL** key | the `X-KM-Access-Key` header |
| the project's card services | the `serviceId` choices on Apply Card |

This is why iKuka runs without anyone pasting in a key: load one of its projects and the key comes
with it.

### One affiliate can only ever see its own things

An ASP ID and a card service ID are both fifteen digits that open with the same six-digit ASP
code. Burger King is `000187000000000` and owns `000187…` services; iKuka is `000163000000000`
and owns `000163…`. That code — not the project's name — is what ties a project to an affiliate,
which matters because `P1-P2-Tim Hortons-V1` is a *Burger King* project.

So the project dropdown lists only the selected affiliate's projects, the `serviceId` list holds
only the loaded project's services, and loading a project from another ASP is **refused** rather
than quietly filtered. Nobody can end up running Burger King with iKuka's service IDs.

---

## 4. Where the plastic cards come from

Card Registration needs a real card — number, expiry, CVC and PAR. Those live on the QA portal
under **Test Data → Card Data**, not in any request body.

Every time Card Registration runs, the tool signs in, opens that screen for the project and picks
a card that satisfies all of:

- status is **ACTIVE**
- it belongs to the **same service** the card was applied for
- this tool has **never used it before**

The third rule exists because the portal keeps showing a card as ACTIVE after it has been handed
out. Status alone does not tell you it is spent, which is why `003_027` — *user is already mapped
to card* — used to appear again and again. Every card this tool consumes is now written to
`used_cards.json` and never offered twice, and if the API still answers `003_027` the next free
card is tried automatically.

If every ACTIVE card for that service is gone, the fetch **stops** and names the services that
still have cards. It will not substitute a card from another service, because that registers the
wrong product and the mistake would only surface much later.

---

## 5. Running it

**One module at a time.** Pick it in the sidebar, check the body on the form, press **Send**. The
reply, the sent headers and a ready-made cURL are all in the Response panel.

**Everything at once.** The **Run All Modules** page runs the chain end to end on one freshly
created user. Each module has a tick box, so you can run four of the six — or just one. Ticking
**Run V1 and V2** does the whole thing twice, each leg with its own project, key and session.

Two controls worth knowing:

- **Physical Card (delivery)** — sits under Apply Card, because it is a property of that call:
  ticked means `isDeliveryRequired: true`, a plastic card; unticked means a mobile / virtual one.
- **Settle (s)** — an ARS registration is not visible to the inquiry instantly. This is the pause
  before step 3, eight seconds by default, and the run retries the inquiry if it still comes back
  empty.

A run that **includes** User Registration starts a clean session — a new user, nothing carried
over. A run **without** it keeps the session, so ticking only Apply Card and Card Registration
chains onto the last user created for that target.

---

## 6. What it leaves behind

Every send is written to a file holding the whole request and response.

- **History** — one row per call: time, module, affiliate, WebView, project, status, duration.
  Click any row for the full JSON.
- **Records** — one row per registered user, built from that history: who was created, when, under
  which project, the card applied for, the card registered, and a **Card Type** label —
  *Mobile / Virtual Card* when a card was only applied for, *Physical / Plastic Card* once one has
  been registered. Rows missing a card offer a one-click next step, and **CSV** exports exactly
  what is on screen.

History is also how the tool knows which cards it has already used, and which service the last
Apply Card ran on.

---

## 7. Where each part runs

```
   your browser  ──JSON over HTTP──▶  server.py (your machine)  ──▶  KONA WebView API
   the console                        holds the keys,                10.30.210.153:15890
   no key reaches it                  builds every request      ──▶  QA Portal
                                                                     dev-qa.konapay.net:10444
                                              │
                                              ▼
                                      history/*.json  ──▶  Records · CSV
```

The browser never holds an access key. It posts what you typed to a small Python server running on
your own machine; that server adds the credentials, calls KONA, and sends back the reply.

This also explains the one hosting limitation. The KONA host `10.30.210.153` is a private address
that exists only inside your network, so no cloud platform can reach it. The screens can be
deployed anywhere — they still talk to the Python server on your machine, which has to be running,
and only origins listed exactly in `server.allowedOrigins` are allowed to do that.

**Nothing in this tool requires an install.** It is Python's standard library and plain
HTML/CSS/JavaScript — no pip packages, no npm, no build step.

---

## 8. Changing what gets sent

Three places, in increasing permanence:

1. **On the form** — type into a field, or edit the raw JSON. Nothing is saved.
2. **Save body → this target** — stores it as the override for that affiliate and version.
   **Save body → shared default** stores it for all of them.
3. **Settings** — edit `config.json` directly: connections, bodies, per-affiliate overrides and
   the randomise rules.

Per-affiliate values live in the overrides. The test case IDs are a good example: Burger King
reports against `664156` and `664160`, iKuka against `668151`, and neither inherits the other's.

---

## 9. The error codes you will meet

| Code | Means | What to do |
|---|---|---|
| `000_000` | Success | — |
| `003_027` | Card already mapped to a user | Handled automatically — the next free card is tried |
| `003_029` | Card not found | The card number does not belong to this project |
| `000_015` | A field is the wrong length | Usually a placeholder that went out unresolved — run the module that produces it first |
| `30_999_028` | A required header is missing | No ASP ID or access key — load a project, or fill them in |

The status you see in History is the **HTTP** status. A call can answer `200` and still carry a
refusal in its result code, which is why both are kept.

---

## 10. KonaRelay, the assistant

The chip-shaped mark on the right edge of the window opens **KonaRelay**, the built-in agent - named for what this console does: hand the value from each call to the next. It answers from
this tool's own knowledge — the modules, the portal lookups, the error codes — and three of its
answers are read live from your own console: what is loaded right now, what happened in your last
run, and how many users and cards exist so far.

It also **does things**. Ask it to run a flow and it works out what it already knows from your
sentence, asks only for what is missing, shows you exactly what it is about to do, and then runs
it on the Run All page where you can watch each step. Ask how many test cards a project has left
and it counts them live on the portal — separating *ACTIVE* from *actually free*, because a card
that has already been used keeps showing as ACTIVE. It will also list your projects, a project's
service IDs, the users you have created, and your recent runs.

Things you can simply type:

- *"Run apply card and card registration on iKuka V1 with a virtual card"*
- *"How many cards are left for Revamped-P1-P2-BK?"*
- *"List the projects for iKuka"* · *"How many users have I created?"* · *"What did I run recently?"*

It is deliberately **not** a language model. Every explanation is written down in the source and
every number comes from your own portal, history and records. A tool that reports on test data
should not improvise an answer about an access key, an error code or a card count, and when
nothing matches your question it says so and offers the closest topics instead of guessing.

---

## Quick reference

| Thing | Value |
|---|---|
| Start the console | `python server.py` → opens on `127.0.0.1:8770` |
| KONA API host | `10.30.210.153:15890` (private — inside the network only) |
| QA portal | `dev-qa.konapay.net:10444` |
| Burger King ASP | `000187000000000` · services `000187…` · tcIdList `664156, 664160` |
| iKuka ASP | `000163000000000` · services `000163…` · tcIdList `668151` |
| Everything configurable | `config.json`, or the **Settings** page |
