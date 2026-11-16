/* ============================================================================
   How It Works - the animated diagram that explains the console at a glance.

   THE CHAIN - the six modules in order, what each one needs, what it hands on,
   and the session filling up as the run proceeds.

   It is built here as an SVG string rather than hand-written markup, so the
   geometry stays consistent and the director below can drive it stage by
   stage. Colours come from the theme tokens, so light and dark both work.
   flowvideo.js draws the same thing onto a canvas for the MP4 export, from the
   data this file shares through window.KonaFlow.data.
   ========================================================================== */
(() => {
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------ the content */
const STAGES = [
  {
    n: 1, title: "User Registration", path: "/web-view/api/v1/user/registration",
    needs: [], gives: "userId",
    what: "Creates a brand new test user.",
    detail: "<code>ci</code>, <code>loginId</code> and <code>email</code> are re-generated on "
      + "every send, so a run can never collide with a user that already exists. "
      + "<code>tcIdList</code> reports the run against that affiliate's own QA test cases - "
      + "<code>664156, 664160</code> for Burger King, <code>668151</code> for iKuka.",
    gets: "userId (plus a mobile card number and PAR)",
  },
  {
    n: 2, title: "Bank Account Registration", path: "/web-view/api/v1/bankaccounts/ars/register",
    needs: ["userId"], gives: "bankAccRegNo",
    what: "Registers a bank account for that user through ARS.",
    detail: "The account details come from the request body; the user it belongs to is the "
      + "<code>userId</code> captured in step 1. Nothing is typed twice.",
    gets: "bankAccRegNo",
  },
  {
    n: 3, title: "Bank Account Inquiry", path: "/web-view/api/v1/bankaccounts/inquiry",
    needs: ["userId"], gives: "bankCode",
    what: "Reads the account back and learns which bank it is.",
    detail: "An ARS registration is not visible to this call straight away. The runner pauses "
      + "(the <b>Settle</b> box, 8 seconds by default) and retries if the reply comes back 200 "
      + "with every field null, rather than carrying an empty bank code forward.",
    gets: "bankCode, bankAccount, bankName",
  },
  {
    n: 4, title: "PG Info Inquiry", path: "/web-view/api/v1/bankaccounts/pg-info/inquiry",
    needs: ["bankCode"], gives: "verified",
    what: "Checks the payment gateway details for that bank.",
    detail: "This is the step that needs <code>bankCode</code> from step 3. Sending the literal "
      + "text <code>{{bankCode}}</code> is what used to produce <code>000_015</code>, so the "
      + "server now refuses any body still holding an unresolved placeholder.",
    gets: "nothing new - it confirms what is already known",
  },
  {
    n: 5, title: "Apply Card", path: "/web-view/api/v1/prepay-card/issue/delivery",
    needs: ["userId", "serviceId"], gives: "cardApplyNo",
    what: "Applies for a card on the service you choose.",
    detail: "<code>serviceId</code> decides which product is issued, and only that project's own "
      + "services are offered. <code>isDeliveryRequired</code> decides the kind: <b>true</b> is a "
      + "physical / plastic card that gets delivered, <b>false</b> is a mobile / virtual one.",
    gets: "cardApplyNo (plus the mobile card number, CVC, expiry and PAR)",
  },
  {
    n: 6, title: "Card Registration", path: "/web-view/api/v1/prepay-card/physical/register",
    needs: ["cardApplyNo", "ACTIVE card"], gives: "card mapped",
    what: "Maps a real plastic card to that application.",
    detail: "The card number, expiry, CVC and PAR are pulled live from the portal's "
      + "<b>Test Data -> Card Data</b>: ACTIVE only, from the same service the card was applied "
      + "for, and never one this tool has already used. If the API still answers "
      + "<code>003_027</code> the next free card is tried automatically.",
    gets: "a registered physical card - the run is complete",
  },
];

/* the chips that appear in the session bar as the run proceeds */
const SESSION_CHIPS = [
  { after: 0, label: "userId" },
  { after: 1, label: "bankAccRegNo" },
  { after: 2, label: "bankCode" },
  { after: 4, label: "cardApplyNo" },
  { after: 5, label: "physicalCardNo" },
];

/* ------------------------------------------------------------- geometry */
/* The gap has to hold the name of the value crossing it (bankAccRegNo is the widest), and a
   node has to hold its endpoint path. Both are sized for the longest case, not the average -
   that is what stops anything spilling over a box edge. */
const W = 1420;
const NODE_W = 160, NODE_H = 108, GAP = 84, NODE_Y = 150;
const nodeX = (i) => 20 + i * (NODE_W + GAP);
const MID_Y = NODE_Y + NODE_H / 2;
const BAR_Y = 322, BAR_H = 88;

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* wrap a title onto two lines without measuring: break on the last space before the middle */
function twoLines(text) {
  if (text.length <= 17) return [text, ""];
  const cut = text.lastIndexOf(" ", Math.ceil(text.length / 2) + 4);
  return cut > 0 ? [text.slice(0, cut), text.slice(cut + 1)] : [text, ""];
}

/* the endpoint, minus the prefix every one of them shares, broken at a slash if it is long */
function pathLines(path) {
  const short = path.replace("/web-view/api/v1", "");
  if (short.length <= 22) return [short, ""];
  const cut = short.lastIndexOf("/", Math.ceil(short.length / 2) + 6);
  return cut > 0 ? [short.slice(0, cut), short.slice(cut)] : [short, ""];
}

function defs() {
  return '<defs>'
    + '<marker id="flowArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7"'
    + ' markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M0 0 L10 5 L0 10 z" class="flowarrow__head"/></marker>'
    + '<marker id="flowArrowSoft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"'
    + ' markerHeight="6" orient="auto-start-reverse">'
    + '<path d="M0 0 L10 5 L0 10 z" class="flowarrow__head flowarrow__head--soft"/></marker>'
    + '</defs>';
}

/* ---------------------------------------------------------- diagram one */
function buildChain() {
  let svg = '<svg class="flowsvg" id="flowChainSvg" viewBox="0 0 ' + W + ' 432"'
    + ' preserveAspectRatio="xMidYMid meet" role="img"'
    + ' aria-label="The six modules in order, each feeding the next">' + defs();

  /* --- top row: what the portal supplies -------------------------------- */
  const portalX = nodeX(3), portalW = nodeX(5) + NODE_W - portalX;
  svg += '<g class="flowtop">'
    + '<rect class="flowbox flowbox--portal" x="' + portalX + '" y="18" width="' + portalW
    + '" height="62" rx="12"/>'
    + '<text class="flowbox__t" x="' + (portalX + 20) + '" y="43">KONA PLATE User Portal</text>'
    + '<text class="flowbox__s" x="' + (portalX + 20) + '" y="63">ASP ID &#183; access key'
    + ' &#183; service IDs &#183; ACTIVE test cards</text>'
    + '</g>';

  /* portal -> apply card and card registration */
  const applyX = nodeX(4) + NODE_W / 2, regX = nodeX(5) + NODE_W / 2;
  svg += '<path class="flowlink flowlink--portal" id="flowPortalApply" d="M' + applyX
    + ' 80 V' + (NODE_Y - 2) + '" marker-end="url(#flowArrowSoft)"/>'
    + '<text class="flowlink__tag" x="' + (applyX + 9) + '" y="118">service IDs</text>'
    + '<path class="flowlink flowlink--portal" id="flowPortalCard" d="M' + regX
    + ' 80 V' + (NODE_Y - 2) + '" marker-end="url(#flowArrowSoft)"/>'
    + '<text class="flowlink__tag" x="' + (regX + 9) + '" y="118">ACTIVE card</text>';

  /* --- the six modules -------------------------------------------------- */
  STAGES.forEach((stage, i) => {
    const x = nodeX(i);
    const lines = twoLines(stage.title);
    const paths = pathLines(stage.path);
    svg += '<g class="flownode" id="flownode-' + i + '" data-stage="' + i + '" tabindex="0">'
      + '<rect class="flownode__box" x="' + x + '" y="' + NODE_Y + '" width="' + NODE_W
      + '" height="' + NODE_H + '" rx="14"/>'
      + '<circle class="flownode__ring" cx="' + (x + NODE_W - 22) + '" cy="' + (NODE_Y + 22)
      + '" r="13"/>'
      + '<text class="flownode__n" x="' + (x + NODE_W - 22) + '" y="' + (NODE_Y + 27)
      + '" text-anchor="middle">' + stage.n + '</text>'
      + '<text class="flownode__t" x="' + (x + 16) + '" y="' + (NODE_Y + 42) + '">'
      + esc(lines[0]) + '</text>'
      + '<text class="flownode__t" x="' + (x + 16) + '" y="' + (NODE_Y + 60) + '">'
      + esc(lines[1]) + '</text>'
      + '<text class="flownode__p" x="' + (x + 16) + '" y="' + (NODE_Y + 83) + '">'
      + esc(paths[0]) + '</text>'
      + '<text class="flownode__p" x="' + (x + 16) + '" y="' + (NODE_Y + 97) + '">'
      + esc(paths[1]) + '</text>'
      + '</g>';

    /* The connector to the next module. The value it carries is written above the arrow and
       lights up while a packet - a single dot, so it has the whole gap to travel - crosses. */
    if (i < STAGES.length - 1) {
      const from = x + NODE_W, to = nodeX(i + 1);
      svg += '<path class="flowlink" id="flowlink-' + i + '" d="M' + (from + 4) + ' ' + MID_Y
        + ' H' + (to - 6) + '" marker-end="url(#flowArrow)"/>'
        + '<text class="flowlink__tag flowlink__tag--mid" id="flowtag-' + i + '" x="'
        + ((from + to) / 2) + '" y="' + (MID_Y - 20) + '" text-anchor="middle">'
        + esc(STAGES[i].gives) + '</text>'
        + '<g class="flowpacket" id="flowpacket-' + i + '" style="--from:' + (from + 4)
        + 'px;--to:' + (to - 10) + 'px">'
        + '<circle class="flowpacket__trail" cx="0" cy="' + MID_Y + '" r="9"/>'
        + '<circle class="flowpacket__dot" cx="0" cy="' + MID_Y + '" r="5.5"/>'
        + '</g>';
    }
  });

  /* --- the session bar -------------------------------------------------- */
  /* each chip sits under the step that produced it, on its own row below the label, so the
     two can never collide however long the value's name is */
  svg += '<rect class="flowsession" x="20" y="' + BAR_Y + '" width="' + (W - 40)
    + '" height="' + BAR_H + '" rx="14"/>'
    + '<text class="flowsession__t" x="40" y="' + (BAR_Y + 26) + '">Session</text>'
    + '<text class="flowsession__s" x="108" y="' + (BAR_Y + 26)
    + '">what each step captured, kept per affiliate &#215; version</text>';

  const CHIP_W = 160;
  SESSION_CHIPS.forEach((chip, i) => {
    const cx = nodeX(chip.after) + NODE_W / 2;
    svg += '<g class="flowchip" id="flowchip-' + i + '">'
      + '<rect class="flowchip__box" x="' + (cx - CHIP_W / 2) + '" y="' + (BAR_Y + 42)
      + '" width="' + CHIP_W + '" height="30" rx="15"/>'
      + '<text class="flowchip__t" x="' + cx + '" y="' + (BAR_Y + 62)
      + '" text-anchor="middle">' + esc(chip.label) + '</text></g>';
  });
  svg += '</svg>';
  return svg;
}

/* ------------------------------------------------------------- director */
const WORK_MS = 1500, SEND_MS = 1100;
let timer = null, stage = 0, phase = "work", playing = false, built = false, done = false;
/* nothing animates until someone asks for it - this stays false until Play (or a step click) */
let started = false;

function allNodes() { return Array.prototype.slice.call(document.querySelectorAll(".flownode")); }

function paintStage() {
  allNodes().forEach((node, i) => {
    node.classList.toggle("is-active", started && i === stage && phase === "work");
    node.classList.toggle("is-done",
      phase === "done" || i < stage || (i === stage && phase === "send"));
  });
  document.querySelectorAll(".flowpacket").forEach((packet, i) => {
    packet.classList.toggle("is-flying", i === stage && phase === "send");
  });
  document.querySelectorAll(".flowlink__tag--mid").forEach((tag, i) => {
    tag.classList.toggle("is-live", i === stage && phase === "send");
  });
  SESSION_CHIPS.forEach((chip, i) => {
    const node = $("#flowchip-" + i);
    if (node) node.classList.toggle("is-on", phase === "done" || stage > chip.after
      || (stage === chip.after && phase === "send"));
  });
  const apply = $("#flowPortalApply"), card = $("#flowPortalCard");
  if (apply) apply.classList.toggle("is-live", stage === 4);
  if (card) card.classList.toggle("is-live", stage === 5);
  paintDetail();
}

function paintDetail() {
  const data = STAGES[stage];
  const host = $("#flowDetail");
  if (!host) return;
  host.innerHTML =
      '<div class="flowdetail__n">Step ' + data.n + ' of 6</div>'
    + '<h3 class="flowdetail__h">' + esc(data.title) + '</h3>'
    + '<p class="flowdetail__what">' + esc(data.what) + '</p>'
    + '<p class="flowdetail__body">' + data.detail + '</p>'
    + '<div class="flowdetail__grid">'
    + '<div><span>Needs</span><b>' + (data.needs.length
        ? data.needs.map((need) => "<code>" + esc(need) + "</code>").join(" ")
        : "nothing - it starts the chain") + '</b></div>'
    + '<div><span>Captures</span><b>' + esc(data.gets) + '</b></div>'
    + '<div><span>Endpoint</span><b><code>' + esc(data.path) + '</code></b></div>'
    + '</div>';
}

/* It plays through once and stops on the finished picture - every step done, the session full.
   Nothing loops on its own; Play again is a button, not a timer. */
function tick() {
  if (phase === "work") {
    phase = "send";
    paintStage();
    timer = setTimeout(tick, stage === STAGES.length - 1 ? WORK_MS : SEND_MS);
    return;
  }
  if (stage === STAGES.length - 1) { finish(); return; }
  stage += 1;
  phase = "work";
  paintStage();
  timer = setTimeout(tick, WORK_MS);
}

function finish() {
  clearTimeout(timer);
  playing = false;
  done = true;
  phase = "done";
  paintStage();
  setButton();
}

function play() {
  if (playing) return;
  if (done) { restart(); return; }          // finished - Play means run it again
  done = false;
  started = true;
  playing = true;
  setButton();
  timer = setTimeout(tick, WORK_MS);
  paintStage();
}

function pause() {
  playing = false;
  clearTimeout(timer);
  setButton();
}

function restart() {
  clearTimeout(timer);
  stage = 0;
  phase = "work";
  done = false;
  started = true;
  playing = true;
  setButton();
  paintStage();
  timer = setTimeout(tick, WORK_MS);
}

function goTo(index) {
  pause();
  done = false;
  started = true;              /* reading one step counts as having started looking */
  stage = index;
  phase = "work";
  paintStage();
  setButton();
}

/* One button does all three jobs: Pause while it runs, Play to carry on from where it was
   paused, Play again once it has finished. Nothing restarts on its own. */
function setButton() {
  const button = $("#flowPlay");
  if (button) button.textContent = playing ? "Pause" : done ? "Play again" : "Play";
  const note = $("#flowState");
  if (note) {
    note.textContent = playing ? "Playing — step " + (stage + 1) + " of " + STAGES.length
      : done ? "Finished — press Play again to watch it once more."
      : started ? "Paused on step " + (stage + 1) + " of " + STAGES.length
      : "Press Play to watch the chain, or click any step to read it.";
  }
}

/* ----------------------------------------------------------------- boot */
function build() {
  if (built) return;
  const chain = $("#flowChainHost");
  if (!chain) return;
  chain.innerHTML = buildChain();
  built = true;

  allNodes().forEach((node) => {
    const index = Number(node.dataset.stage);
    node.addEventListener("click", () => goTo(index));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); goTo(index); }
    });
  });
  $("#flowPlay").onclick = () => (playing ? pause() : play());
  setButton();
  paintStage();
}

/* The page never starts animating on its own. Opening it draws the diagram and waits; the
   animation runs only when Play is pressed. No timer runs behind the other pages either. */
window.KonaFlow = {
  /* what the video recorder draws from - one source of truth for both renderers */
  data: { STAGES: STAGES, SESSION_CHIPS: SESSION_CHIPS,
          layout: { W: W, NODE_W: NODE_W, NODE_H: NODE_H, GAP: GAP, NODE_Y: NODE_Y,
                    MID_Y: MID_Y, BAR_Y: BAR_Y, BAR_H: BAR_H, nodeX: nodeX,
                    twoLines: twoLines, pathLines: pathLines },
          timing: { WORK_MS: WORK_MS, SEND_MS: SEND_MS } },
  enter: function () {
    build();
  },
  leave: function () { pause(); },
};

})();
