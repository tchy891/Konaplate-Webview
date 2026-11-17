/* ============================================================================
   Appearance - the colour, font and button shape of the console.

   Two modes. **Default** is the palette the console ships with and sets nothing of its own.
   **Customised** writes a handful of CSS variables onto <html>, which is all the rest of the
   stylesheet reads - so one accent colour repaints every button, link, focus ring, chip and
   badge, in light and dark alike, without a second set of rules anywhere.

   The choice is per browser, remembered under one key, and applied before first paint by a
   small script in the page head so there is no flash of the wrong colour.
   ========================================================================== */
(() => {
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const STORE = "konaAppearance";

const ACCENTS = [
  { id: "ocean", label: "Ocean", hex: "#149FFF" },
  { id: "violet", label: "Violet", hex: "#6D28D9" },
  { id: "teal", label: "Teal", hex: "#0D9488" },
  { id: "forest", label: "Forest", hex: "#15803D" },
  { id: "amber", label: "Amber", hex: "#B45309" },
  { id: "rose", label: "Rose", hex: "#BE123C" },
  { id: "indigo", label: "Indigo", hex: "#4338CA" },
  { id: "slate", label: "Slate", hex: "#475569" },
];

const FONTS = [
  { id: "system", label: "System", stack: '"Segoe UI","Malgun Gothic",system-ui,sans-serif' },
  { id: "grotesk", label: "Grotesk", stack: '"Segoe UI Variable Display","Segoe UI",Inter,'
    + '"Helvetica Neue",Arial,sans-serif' },
  { id: "serif", label: "Serif", stack: 'Georgia,"Times New Roman","Malgun Gothic",serif' },
  { id: "mono", label: "Mono", stack: 'Consolas,"Cascadia Mono","Courier New",'
    + '"Malgun Gothic",monospace' },
];

const SHAPES = [
  { id: "rounded", label: "Rounded", radius: "9px" },
  { id: "pill", label: "Pill", radius: "999px" },
  { id: "square", label: "Square", radius: "3px" },
];

const DEFAULTS = { mode: "default", accent: "ocean", custom: "", font: "system",
                   shape: "rounded" };

/* ------------------------------------------------------------- the colour */
function toRgb(hex) {
  let value = String(hex || "").trim().replace("#", "");
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(rgb, towards, amount) {
  return rgb.map((c, i) => Math.round(c + (towards[i] - c) * amount));
}

const hex = (rgb) => "#" + rgb.map((c) =>
  Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE = [255, 255, 255], INK = [7, 21, 31];
const AA = 4.6;                 /* a little over 4.5, so rounding never lands under it */

/* A chosen colour has to work as a button fill, as link text and as a glow - and the label on
   the button has to stay readable. None of that is assumed: each shade is pushed, a step at a
   time, until it actually measures 4.6:1 against what sits on it. That is why every preset and
   every colour you pick yourself comes out legible, in both themes, without a lookup table. */
function fitText(rgb, against, dark) {
  let text = rgb.slice();
  for (let i = 0; i < 24 && contrast(text, against) < AA; i += 1) {
    text = mix(text, dark ? WHITE : INK, 0.09);
  }
  return text;
}

function fitFill(rgb) {
  let fill = rgb.slice();
  for (let i = 0; i < 24; i += 1) {
    if (Math.max(contrast(WHITE, fill), contrast(INK, fill)) >= AA) break;
    /* move it away from the middle, whichever way it is already leaning */
    fill = luminance(fill) > 0.22 ? mix(fill, WHITE, 0.08) : mix(fill, INK, 0.08);
  }
  return fill;
}

function paletteFrom(colour, dark) {
  const rgb = toRgb(colour);
  if (!rgb) return null;
  const surface = dark ? [17, 35, 47] : WHITE;
  const text = fitText(rgb, surface, dark);
  const fill = fitFill(rgb);
  const onFill = contrast(WHITE, fill) >= contrast(INK, fill) ? "#FFFFFF" : "#07151F";
  return {
    "--accent": hex(text),
    "--accent-fill": hex(fill),
    "--accent-fill-hover": hex(dark ? mix(fill, WHITE, 0.18) : mix(fill, INK, 0.14)),
    "--accent-ink": hex(dark ? mix(text, WHITE, 0.25) : mix(text, INK, 0.25)),
    "--on-accent": onFill,
    "--accent-glow": "rgba(" + rgb.join(",") + ",.34)",
    "--accent-ring": "rgba(" + rgb.join(",") + ",.22)",
    "--brand": hex(rgb),
  };
}

/* ------------------------------------------------------------ apply / store */
function read() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE) || "{}"));
  } catch (error) {
    return Object.assign({}, DEFAULTS);
  }
}

function write(settings) {
  try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (error) { /* blocked */ }
}

function apply(settings) {
  const root = document.documentElement;
  const vars = ["--accent", "--accent-fill", "--accent-fill-hover", "--accent-ink", "--on-accent",
                "--accent-glow", "--accent-ring", "--brand", "--font", "--btn-radius"];
  vars.forEach((name) => root.style.removeProperty(name));
  if (settings.mode !== "custom") return;            /* default: the stylesheet decides */

  const chosen = settings.custom
    || (ACCENTS.find((a) => a.id === settings.accent) || ACCENTS[0]).hex;
  const dark = root.getAttribute("data-theme") === "dark";
  const palette = paletteFrom(chosen, dark);
  if (palette) {
    Object.keys(palette).forEach((name) => root.style.setProperty(name, palette[name]));
  }
  const font = FONTS.find((f) => f.id === settings.font);
  if (font && font.id !== "system") root.style.setProperty("--font", font.stack);
  const shape = SHAPES.find((s) => s.id === settings.shape);
  if (shape && shape.id !== "rounded") root.style.setProperty("--btn-radius", shape.radius);
}

/* the accent is derived differently for light and dark, so re-apply when the theme flips */
function watchTheme() {
  const observer = new MutationObserver(() => apply(read()));
  observer.observe(document.documentElement, { attributes: true,
                                               attributeFilter: ["data-theme"] });
}

/* ------------------------------------------------------------------ the menu */
function build() {
  const host = $("#appearanceMenu");
  if (!host) return;
  const settings = read();

  const swatches = ACCENTS.map((accent) =>
    '<button class="apx__dot" type="button" data-accent="' + accent.id + '" title="'
    + accent.label + '" style="background:' + accent.hex + '"></button>').join("");
  const fonts = FONTS.map((font) =>
    '<button class="apx__pick" type="button" data-font="' + font.id + '">'
    + font.label + "</button>").join("");
  const shapes = SHAPES.map((shape) =>
    '<button class="apx__pick" type="button" data-shape="' + shape.id + '">'
    + shape.label + "</button>").join("");

  host.innerHTML =
      '<div class="apx__head">Appearance</div>'
    + '<div class="apx__modes">'
    +   '<button class="apx__mode" type="button" data-mode="default">Default</button>'
    +   '<button class="apx__mode" type="button" data-mode="custom">Customised</button>'
    + '</div>'
    + '<div class="apx__body" id="apxBody">'
    +   '<div class="apx__row"><span>Colour</span><div class="apx__dots">' + swatches
    +     '<label class="apx__own" title="Any colour you like">'
    +       '<input type="color" id="apxColour"><i></i></label>'
    +   '</div></div>'
    +   '<div class="apx__row"><span>Font</span><div class="apx__picks" id="apxFonts">'
    +     fonts + "</div></div>"
    +   '<div class="apx__row"><span>Buttons</span><div class="apx__picks" id="apxShapes">'
    +     shapes + "</div></div>"
    + "</div>"
    + '<div class="apx__foot">'
    +   '<span class="apx__note" id="apxNote"></span>'
    +   '<button class="apx__reset" type="button" id="apxReset">Reset</button>'
    + "</div>";

  host.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const now = read();
    if (button.dataset.mode) now.mode = button.dataset.mode;
    if (button.dataset.accent) { now.accent = button.dataset.accent; now.custom = "";
                                 now.mode = "custom"; }
    if (button.dataset.font) { now.font = button.dataset.font; now.mode = "custom"; }
    if (button.dataset.shape) { now.shape = button.dataset.shape; now.mode = "custom"; }
    if (button.id === "apxReset") Object.assign(now, DEFAULTS);
    write(now);
    apply(now);
    paint(now);
  });

  $("#apxColour").addEventListener("input", (event) => {
    const now = read();
    now.custom = event.target.value;
    now.mode = "custom";
    write(now);
    apply(now);
    paint(now);
  });

  paint(settings);
}

function paint(settings) {
  const host = $("#appearanceMenu");
  if (!host) return;
  const custom = settings.mode === "custom";
  host.querySelectorAll("[data-mode]").forEach((node) =>
    node.classList.toggle("is-on", node.dataset.mode === settings.mode));
  host.querySelectorAll("[data-accent]").forEach((node) =>
    node.classList.toggle("is-on", custom && !settings.custom
      && node.dataset.accent === settings.accent));
  host.querySelectorAll("[data-font]").forEach((node) =>
    node.classList.toggle("is-on", custom && node.dataset.font === settings.font));
  host.querySelectorAll("[data-shape]").forEach((node) =>
    node.classList.toggle("is-on", custom && node.dataset.shape === settings.shape));
  $("#apxBody").classList.toggle("is-off", !custom);
  const own = $("#apxColour");
  if (own) {
    own.value = settings.custom || (ACCENTS.find((a) => a.id === settings.accent)
      || ACCENTS[0]).hex;
    own.parentNode.classList.toggle("is-on", custom && !!settings.custom);
  }
  $("#apxNote").textContent = custom
    ? "Your own colours, font and button shape."
    : "The colours this console ships with.";
}

/* -------------------------------------------------------------------- open */
function wire() {
  const button = $("#btnAppearance"), menu = $("#appearanceMenu");
  if (!button || !menu) return;
  build();
  watchTheme();
  button.onclick = (event) => {
    event.stopPropagation();
    menu.classList.toggle("is-open");
  };
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target) && event.target !== button) {
      menu.classList.remove("is-open");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") menu.classList.remove("is-open");
  });
}

apply(read());        /* before anything is drawn by the rest of the page */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}

})();
