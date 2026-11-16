/* ============================================================================
   Download MP4 - records the chain animation to a video file.

   A browser cannot film a piece of the page directly, so the diagram is drawn a
   second time onto a <canvas> from the same data flowchart.js uses (shared via
   window.KonaFlow.data), and that canvas is captured with MediaRecorder.

   Format: MP4 (H.264) when the browser can encode it - Chrome and Edge 126 and
   later can. When it cannot, nothing is downloaded silently in another format:
   the button says so and offers WebM as an explicit choice, because a file with
   the wrong extension is worse than a clear message.
   ========================================================================== */
(() => {
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

const MP4_TYPES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1.4D401E",
  "video/mp4;codecs=h264",
  "video/mp4",
];
const WEBM_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

function pick(types) {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch (error) { /* keep looking */ }
  }
  return "";
}

/* ----------------------------------------------------------- the palette */
/* read from the live theme, so the video matches what is on screen */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
  return {
    bg: get("--surface-2", "#F4EFFB"),
    card: get("--surface", "#FFFFFF"),
    card2: get("--surface-3", "#EDE6F7"),
    line: get("--line-hover", "#D5C9EC"),
    text: get("--text", "#221C33"),
    soft: get("--text-soft", "#463E5C"),
    muted: get("--muted", "#5F6676"),
    accent: get("--accent-fill", "#6D28D9"),
    accentText: get("--accent", "#6D28D9"),
    onAccent: get("--on-accent", "#FFFFFF"),
    teal: get("--teal", "#0D9488"),
    tealText: get("--teal-text", "#0B7A70"),
    tealBg: get("--teal-bg", "#DCF5F1"),
    mono: get("--mono", "monospace"),
  };
}

const SANS = "'Segoe UI', system-ui, -apple-system, sans-serif";

/* --------------------------------------------------------- canvas helpers */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function arrow(ctx, x1, y1, x2, y2, colour, dashed) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2.2;
  if (dashed) ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 9 * Math.cos(angle - 0.42), y2 - 9 * Math.sin(angle - 0.42));
  ctx.lineTo(x2 - 9 * Math.cos(angle + 0.42), y2 - 9 * Math.sin(angle + 0.42));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function label(ctx, text, x, y, font, colour, align) {
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = align || "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
}

/* ------------------------------------------------------------ the frames */
/* The timeline is the same shape as the on-screen one: each step works, then
   hands its value on. A step holds long enough to read its panel - that is what
   the extra time in WORK_MS is for. t is milliseconds from the start. */
const TITLE_MS = 1700, WORK_MS = 2600, SEND_MS = 1000, OUTRO_MS = 3000;

/* break text into lines that fit, measuring with the real font */
function wrap(ctx, text, font, maxWidth, maxLines) {
  ctx.font = font;
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (maxLines && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    /* say it was cut rather than stopping mid-sentence with no sign */
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[\s.,;:]+$/, "") + "…";
    return kept;
  }
  return lines;
}

/* the detail text is written once, as HTML, in flowchart.js - strip it for canvas */
function plain(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function timeline(count) {
  const marks = [];
  let at = TITLE_MS;
  for (let i = 0; i < count; i += 1) {
    marks.push({ stage: i, phase: "work", from: at, to: at + WORK_MS });
    at += WORK_MS;
    if (i < count - 1) {
      marks.push({ stage: i, phase: "send", from: at, to: at + SEND_MS });
      at += SEND_MS;
    }
  }
  marks.push({ stage: count - 1, phase: "done", from: at, to: at + OUTRO_MS });
  return { marks: marks, total: at + OUTRO_MS };
}

function drawFrame(ctx, t, data, plan, colours, size) {
  const L = data.layout, stages = data.STAGES;
  const scale = size.w / L.W;
  ctx.save();
  ctx.fillStyle = colours.bg;
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.scale(scale, scale);
  ctx.translate(0, 54);                      /* room for the caption strip */

  const now = plan.marks.find((m) => t >= m.from && t < m.to)
    || plan.marks[plan.marks.length - 1];
  const progress = Math.max(0, Math.min(1, (t - now.from) / (now.to - now.from)));
  const intro = t < TITLE_MS;

  /* ---- caption ------------------------------------------------------- */
  ctx.save();
  ctx.translate(0, -54);
  label(ctx, "KONA WebView API Console", 22, 26, "800 22px " + SANS, colours.text);
  const caption = intro
    ? "Six API calls, each one feeding the next"
    : now.phase === "done"
      ? "Done - one user, one bank account, one card, all chained automatically"
      : "Step " + (now.stage + 1) + " of 6 - " + stages[now.stage].title;
  label(ctx, caption, 22, 47, "600 15px " + SANS, colours.muted);
  ctx.restore();

  /* ---- top row: what the portal supplies ------------------------------ */
  const portalX = L.nodeX(3), portalW = L.nodeX(5) + L.NODE_W - portalX;
  ctx.lineWidth = 1.4;
  ctx.fillStyle = colours.tealBg;
  ctx.strokeStyle = colours.teal;
  roundRect(ctx, portalX, 18, portalW, 62, 12); ctx.fill(); ctx.stroke();
  label(ctx, "KONA PLATE User Portal", portalX + 20, 43, "800 15px " + SANS, colours.text);
  label(ctx, "ASP ID · access key · service IDs · ACTIVE test cards",
    portalX + 20, 63, "600 12px " + SANS, colours.muted);

  [[4, "service IDs"], [5, "ACTIVE card"]].forEach(([index, text]) => {
    const x = L.nodeX(index) + L.NODE_W / 2;
    const live = now.stage === index && now.phase !== "done";
    arrow(ctx, x, 80, x, L.NODE_Y - 4, live ? colours.teal : colours.line, true);
    label(ctx, text, x + 9, 118, (live ? "800 " : "700 ") + "11.5px " + SANS,
      live ? colours.tealText : colours.muted);
  });

  /* ---- the six modules ------------------------------------------------ */
  stages.forEach((stage, i) => {
    const x = L.nodeX(i);
    const active = !intro && now.stage === i && now.phase === "work";
    const finished = !intro && (now.phase === "done" || i < now.stage
      || (i === now.stage && now.phase === "send"));

    ctx.save();
    if (active) {
      ctx.shadowColor = colours.accent;
      ctx.shadowBlur = 18 + 8 * Math.sin(progress * Math.PI * 2);
    }
    ctx.fillStyle = active ? colours.card2 : colours.card;
    ctx.strokeStyle = active ? colours.accent : finished ? colours.teal : colours.line;
    ctx.lineWidth = active ? 2.6 : 1.6;
    roundRect(ctx, x, L.NODE_Y, L.NODE_W, L.NODE_H, 14);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = active ? colours.accent : finished ? colours.tealBg : colours.card2;
    ctx.strokeStyle = active ? colours.accent : finished ? colours.teal : colours.line;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x + L.NODE_W - 22, L.NODE_Y + 22, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    label(ctx, String(stage.n), x + L.NODE_W - 22, L.NODE_Y + 27, "800 12.5px " + SANS,
      active ? colours.onAccent : finished ? colours.tealText : colours.soft, "center");

    const title = L.twoLines(stage.title), paths = L.pathLines(stage.path);
    label(ctx, title[0], x + 16, L.NODE_Y + 42, "800 14.5px " + SANS, colours.text);
    if (title[1]) label(ctx, title[1], x + 16, L.NODE_Y + 60, "800 14.5px " + SANS, colours.text);
    label(ctx, paths[0], x + 16, L.NODE_Y + 83, "600 10px " + colours.mono, colours.muted);
    if (paths[1]) {
      label(ctx, paths[1], x + 16, L.NODE_Y + 97, "600 10px " + colours.mono, colours.muted);
    }

    /* the connector and the value crossing it */
    if (i < stages.length - 1) {
      const from = x + L.NODE_W, to = L.nodeX(i + 1);
      const flying = !intro && now.stage === i && now.phase === "send";
      arrow(ctx, from + 4, L.MID_Y, to - 6, L.MID_Y, colours.line);
      label(ctx, stage.gives, (from + to) / 2, L.MID_Y - 20,
        (flying ? "800 " : "700 ") + "10.5px " + colours.mono,
        flying ? colours.accentText : colours.muted, "center");
      if (flying) {
        const px = (from + 4) + (to - 14 - from) * progress;
        ctx.save();
        ctx.globalAlpha = progress < .18 ? progress / .18
          : progress > .82 ? (1 - progress) / .18 : 1;
        ctx.fillStyle = colours.accent;
        ctx.globalAlpha *= .22;
        ctx.beginPath(); ctx.arc(px, L.MID_Y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = ctx.globalAlpha / .22;
        ctx.beginPath(); ctx.arc(px, L.MID_Y, 5.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
  });

  /* ---- the session bar ------------------------------------------------ */
  ctx.save();
  ctx.fillStyle = colours.bg;
  ctx.strokeStyle = colours.line;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([6, 5]);
  roundRect(ctx, 20, L.BAR_Y, L.W - 40, L.BAR_H, 14);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  label(ctx, "Session", 40, L.BAR_Y + 26, "800 14px " + SANS, colours.text);
  label(ctx, "what each step captured, kept per affiliate × version", 108, L.BAR_Y + 26,
    "600 11.5px " + SANS, colours.muted);

  data.SESSION_CHIPS.forEach((chip) => {
    const cx = L.nodeX(chip.after) + L.NODE_W / 2;
    const on = !intro && (now.phase === "done" || now.stage > chip.after
      || (now.stage === chip.after && now.phase === "send"));
    ctx.globalAlpha = on ? 1 : .3;
    ctx.fillStyle = on ? colours.tealBg : colours.card;
    ctx.strokeStyle = on ? colours.teal : colours.line;
    ctx.lineWidth = 1.3;
    roundRect(ctx, cx - 80, L.BAR_Y + 42, 160, 30, 15);
    ctx.fill();
    ctx.stroke();
    label(ctx, chip.label, cx, L.BAR_Y + 62, "700 12px " + colours.mono,
      on ? colours.tealText : colours.muted, "center");
    ctx.globalAlpha = 1;
  });

  /* ---- the step panel - the same words the page shows under the diagram */
  const PANEL_Y = L.BAR_Y + 102, PANEL_H = 168, PANEL_W = L.W - 40;
  ctx.fillStyle = colours.card;
  ctx.strokeStyle = colours.line;
  ctx.lineWidth = 1.4;
  roundRect(ctx, 20, PANEL_Y, PANEL_W, PANEL_H, 14);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = intro || now.phase === "done" ? colours.teal : colours.accent;
  roundRect(ctx, 20, PANEL_Y, 6, PANEL_H, 3);
  ctx.fill();

  if (intro) {
    label(ctx, "WHAT THIS TOOL DOES", 46, PANEL_Y + 30, "800 12px " + SANS, colours.tealText);
    label(ctx, "Six API calls, run in order, with no copy-paste between them",
      46, PANEL_Y + 62, "800 21px " + SANS, colours.text);
    wrap(ctx, "Each call needs something only the one before it can give: a userId, a bank "
      + "code, a card application number. The console carries those forward automatically, "
      + "creates a fresh test user every time, and pulls a real plastic card from the User "
      + "Portal when the last step needs one.",
      "600 14px " + SANS, PANEL_W - 60, 3)
      .forEach((line, i) => {
        label(ctx, line, 46, PANEL_Y + 95 + i * 22, "600 14px " + SANS, colours.soft);
      });
  } else {
    const step = stages[now.stage];
    const finishedAll = now.phase === "done";
    label(ctx, finishedAll ? "RUN COMPLETE" : "STEP " + step.n + " OF " + stages.length,
      46, PANEL_Y + 28, "800 12px " + SANS,
      finishedAll ? colours.tealText : colours.accentText);
    label(ctx, finishedAll ? "One user, one bank account, one registered card" : step.title,
      46, PANEL_Y + 58, "800 21px " + SANS, colours.text);
    label(ctx, finishedAll
      ? "Every value above was captured and handed on by the step before it."
      : step.what, 46, PANEL_Y + 84, "700 14.5px " + SANS, colours.soft);

    const textW = 880;
    wrap(ctx, finishedAll
      ? "The same chain runs for Burger King or iKuka, V1 or V2, and every send is saved - "
        + "which is what the Records table and the CSV export are built from."
      : plain(step.detail), "600 13.5px " + SANS, textW, 3)
      .forEach((line, i) => {
        label(ctx, line, 46, PANEL_Y + 112 + i * 20, "600 13.5px " + SANS, colours.muted);
      });

    if (!finishedAll) {
      const colX = 46 + textW + 50;
      const colW = PANEL_W - (colX - 20) - 24;
      const rows = [
        ["NEEDS", step.needs.length ? step.needs.join("  ·  ") : "nothing - it starts the chain"],
        ["CAPTURES", step.gets],
        ["ENDPOINT", step.path.replace("/web-view/api/v1", "")],
      ];
      let at = PANEL_Y + 28;
      rows.forEach(([head, value], i) => {
        label(ctx, head, colX, at, "800 10.5px " + SANS, colours.muted);
        const font = i === 2 ? "700 12px " + colours.mono : "700 13px " + SANS;
        wrap(ctx, value, font, colW, 2).forEach((line, j) => {
          label(ctx, line, colX, at + 20 + j * 17, font, colours.soft);
        });
        at += 54;
      });
    }
  }

  ctx.restore();
}

/* ------------------------------------------------------------ recording */
let busy = false;

function note(text, show) {
  const node = $("#flowRecNote");
  if (!node) return;
  node.hidden = show === false;
  node.textContent = text;
}

async function record(preferMp4) {
  if (busy) return;
  const flow = window.KonaFlow;
  if (!flow || !flow.data) { note("The diagram is not ready yet - open it first.", true); return; }

  const mime = preferMp4 ? pick(MP4_TYPES) : pick(WEBM_TYPES);
  if (!mime) {
    offerWebm();
    return;
  }

  busy = true;
  const button = $("#flowRecord");
  const wasLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Recording…";
  /* the clip is captured in real time, and a background tab stops painting - so say so */
  note("Recording — keep this tab in front until it finishes.", true);
  flow.leave();                               /* the on-screen animation stands still */

  /* 1704x816: the diagram at 1.2x plus the caption strip and the step panel.
     Both dimensions even, which H.264 requires. */
  const size = { w: 1704, h: 816 };
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  const colours = palette();
  const data = flow.data;
  const plan = timeline(data.STAGES.length);

  const stream = canvas.captureStream(30);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };

  const finished = new Promise((resolve) => { recorder.onstop = resolve; });
  drawFrame(ctx, 0, data, plan, colours, size);
  recorder.start();

  const started = performance.now();
  await new Promise((resolve) => {
    function step() {
      const t = performance.now() - started;
      drawFrame(ctx, Math.min(t, plan.total), data, plan, colours, size);
      note("Recording — " + Math.round(Math.min(t, plan.total) / 1000) + "s of "
        + Math.round(plan.total / 1000) + "s", true);
      if (t >= plan.total) { resolve(); return; }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });

  recorder.stop();
  stream.getTracks().forEach((track) => track.stop());
  await finished;

  const blob = new Blob(chunks, { type: mime });
  const ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";
  const name = "kona-webview-flow." + ext;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  note("Saved " + name + " — " + Math.round(blob.size / 1024) + " KB, "
    + Math.round(plan.total / 1000) + " seconds, 1704×816. Check your Downloads folder.",
    true);
  button.textContent = wasLabel;
  button.disabled = false;
  busy = false;
}

/* Only reached when the browser cannot encode H.264 - say so rather than quietly
   handing over a WebM named .mp4. */
function offerWebm() {
  const node = $("#flowRecNote");
  if (!node) return;
  node.hidden = false;
  node.innerHTML = "This browser cannot record <b>MP4</b> (it needs Chrome or Edge 126 or "
    + "later). Nothing was downloaded. ";
  const button = document.createElement("button");
  button.className = "btn btn--sm";
  button.textContent = "Download WebM instead";
  button.onclick = () => record(false);
  node.appendChild(button);
}

function wire() {
  const button = $("#flowRecord");
  if (!button) return;
  button.onclick = () => record(true);
  if (!pick(MP4_TYPES)) button.title = "This browser cannot encode MP4 - WebM will be offered";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}

})();
