// The sample note: an original design, drawn in SVG. It shows a 100-coin note whose value
// is computed with the same integer maths as the contract (rpow, rounding down), so the figures
// are what ft_balance_of would return. Drag the note, or use the controls, to move through time.
import { ONE, RAY, rpow, formatCoinsRound as formatCoins, REAL_FACTOR, DAY, MONTH, YEAR, secondsPerPercent, describeDuration } from "./worgl.js";

const NS = "http://www.w3.org/2000/svg";
const FACE = 100n * ONE;
const el = (name, attrs = {}, text) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
const $ = (id) => document.getElementById(id);

const RATES = {
  demo: { max: 2n * DAY, label: "demo rate", presets: [["Now", 0n], ["10 minutes", 600n], ["1 hour", 3600n], ["1 day", DAY]] },
  real: { max: 10n * YEAR, label: "real rate", presets: [["Now", 0n], ["1 month", MONTH], ["1 year", YEAR], ["10 years", 10n * YEAR]] },
};

export function initNote({ demoFactor }) {
  const svg = $("note");
  const factors = { demo: demoFactor, real: REAL_FACTOR };
  let rate = "demo";
  let offset = 0n;               // seconds the visitor has dragged forward
  const issuedAt = performance.now();
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const phone = matchMedia("(max-width: 40rem)");
  let view = build(svg, phone.matches);
  phone.addEventListener("change", () => { view = build(svg, phone.matches); render(); });

  const slider = $("note-slider");
  const presetBox = $("note-presets");
  const rateBox = $("note-rate");

  const sliderToSecs = (v) => {
    const f = Math.pow(v / 1000, 3);
    return BigInt(Math.round(Number(RATES[rate].max) * f));
  };
  const secsToSlider = (s) => Math.round(1000 * Math.cbrt(Number(s) / Number(RATES[rate].max)));

  function setOffset(secs, fromSlider = false) {
    offset = secs < 0n ? 0n : secs > RATES[rate].max ? RATES[rate].max : secs;
    if (!fromSlider) slider.value = String(secsToSlider(offset));
    render();
  }

  function renderControls() {
    presetBox.replaceChildren(...RATES[rate].presets.map(([label, secs]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => setOffset(secs));
      return b;
    }));
    for (const b of rateBox.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.rate === rate));
  }

  rateBox.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    rate = b.dataset.rate; offset = 0n; slider.value = "0"; renderControls(); render();
  }));
  slider.addEventListener("input", () => setOffset(sliderToSecs(Number(slider.value)), true));

  // Drag the note itself: dragging right moves forward in time (the whole width = the whole range).
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, v: Number(slider.value) };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const w = svg.getBoundingClientRect().width;
    const v = Math.max(0, Math.min(1000, drag.v + ((e.clientX - drag.x) / w) * 1000));
    slider.value = String(Math.round(v));
    setOffset(sliderToSecs(Math.round(v)), true);
  });
  const endDrag = () => { drag = null; };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  function elapsedLive() { return BigInt(Math.floor((performance.now() - issuedAt) / 1000)); }

  function render() {
    const factor = factors[rate];
    // Live seconds only matter at the demo rate; at the real rate a second changes nothing visible.
    const total = offset + (rate === "demo" ? elapsedLive() : 0n);
    const index = rpow(factor, total);
    const value = (FACE * index) / RAY;
    const melted = FACE - value;
    const { parts, meter } = view;
    parts.value.textContent = formatCoins(value, 4);
    parts.melted.textContent = formatCoins(melted, 4);
    parts.received.textContent = formatCoins(melted, 4);
    const per = secondsPerPercent(factor);
    const leftFrac = Number(value) / Number(FACE);
    meter.setLeft(leftFrac);
    parts.sub.textContent = parts.subShort ? `Loses 1% every ${describeDuration(per)}.` : `This sample note loses 1% every ${describeDuration(per)}. What it loses goes to the town pot.`;
    parts.when.textContent = offset === 0n ? "Issued when you opened this page" : `${describeOffset(offset)}, at the ${RATES[rate].label}`;
    $("note-readout").textContent = offset === 0n
      ? `The sample note started at 100 coins and has melted ${formatCoins(melted, 4)} since you opened this page. That amount went to the town pot.`
      : `${describeOffset(offset)} at the ${RATES[rate].label}: ${formatCoins(value, 2)} coins left, ${formatCoins(melted, 2)} went to the town pot.`;
  }

  renderControls();
  render();
  return { render };
}

function describeOffset(secs) {
  const s = Number(secs);
  if (s >= 365 * 86400 * 0.98) { const y = s / (365 * 86400); return `After ${y >= 9.5 ? Math.round(y) : y.toFixed(1).replace(/\.0$/, "")} ${y === 1 ? "year" : "years"}`; }
  if (s >= 30 * 86400 * 0.9) { const m = s / (30 * 86400); return `After ${m.toFixed(1).replace(/\.0$/, "")} ${m === 1 ? "month" : "months"}`; }
  return `After ${describeDuration(s)}`;
}

// ------------------------------------------------------------------ drawing
// Two layouts of the same note: a landscape note on wide screens, a portrait one on phones, so the
// figures stay readable at 360px.
function build(svg, narrow) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", narrow ? "0 0 400 520" : "0 0 960 420");
  drawBackground(svg, narrow);
  const parts = drawText(svg, narrow);
  const meter = drawMeter(svg, narrow);
  return { parts, meter, narrow };
}

function drawBackground(svg, narrow) {
  const W = narrow ? 400 : 960, H = narrow ? 520 : 420;
  svg.append(el("rect", { x: 0, y: 0, width: W, height: H, fill: "var(--note)" }));
  // Guilloche rosette: overlapping rotated ellipses, as on security paper.
  const g = el("g", { class: "guilloche" });
  const [cx, cy, rx, ry] = narrow ? [326, 64, 48, 15] : [168, 160, 118, 36];
  for (let i = 0; i < 36; i++) g.append(el("ellipse", { cx, cy, rx, ry, transform: `rotate(${i * 5} ${cx} ${cy})` }));
  svg.append(g);
  // Double-ruled border
  const o = narrow ? 6 : 8, i2 = narrow ? 13 : 18;
  svg.append(el("rect", { x: o, y: o, width: W - 2 * o, height: H - 2 * o, fill: "none", stroke: "var(--ink)", "stroke-width": 3 }));
  svg.append(el("rect", { x: i2, y: i2, width: W - 2 * i2, height: H - 2 * i2, fill: "none", stroke: "var(--ink)", "stroke-width": 1 }));
}

function drawText(svg, narrow) {
  const t = (cls, x, y, size, text, extra = {}) => {
    const e = el("text", { class: cls, x, y, "font-size": size, ...extra }, text);
    svg.append(e);
    return e;
  };
  if (!narrow) {
    t("sans", 330, 74, 32, "Wörgl note", { "font-weight": 600 });
    const sub = t("", 330, 104, 17, "", { "font-style": "italic" });
    const when = t("faded", 930, 74, 16, "", { "text-anchor": "end" });
    const value = t("value", 326, 196, 92, "");
    t("sans", 330, 236, 20, "WORGL", { "font-weight": 500 });
    t("faded", 330, 268, 17, "Melted");
    const melted = t("melted", 640, 268, 20, "", { "text-anchor": "end" });
    t("faded", 330, 296, 17, "Went to the town pot");
    const received = t("received", 640, 296, 20, "", { "text-anchor": "end" });
    return { sub, when, value, melted, received, subShort: false };
  }
  t("sans", 30, 58, 30, "Wörgl note", { "font-weight": 600 });
  const sub = t("", 30, 84, 15, "", { "font-style": "italic" });
  const when = t("faded", 30, 112, 14, "");
  const value = t("value", 26, 206, 76, "");
  t("sans", 30, 240, 18, "WORGL", { "font-weight": 500 });
  t("faded", 30, 284, 16, "Melted");
  const melted = t("melted", 372, 284, 19, "", { "text-anchor": "end" });
  t("faded", 30, 314, 16, "Went to the town pot");
  const received = t("received", 372, 314, 19, "", { "text-anchor": "end" });
  return { sub, when, value, melted, received, subShort: true };
}

/** A bar that shows how much of the note is left (ink) and how much has melted into the town pot (carmine). */
function drawMeter(svg, narrow) {
  const x = narrow ? 30 : 50, w = narrow ? 340 : 860, y = narrow ? 360 : 332, h = narrow ? 18 : 20;
  const left = el("rect", { class: "meter-left", x, y, width: w, height: h });
  const melted = el("rect", { class: "meter-melted", x: x + w, y, width: 0, height: h });
  svg.append(left, melted);
  svg.append(el("rect", { class: "meter-frame", x, y, width: w, height: h }));
  const lab = (cls, ax, anchor, text) => { const e = el("text", { class: cls, x: ax, y: y + h + 24, "font-size": narrow ? 15 : 17, "text-anchor": anchor }, text); svg.append(e); return e; };
  const leftText = lab("faded", x, "start", "");
  const meltedText = lab("melted", x + w, "end", "");
  if (narrow) svg.append(el("text", { class: "faded", x: 30, y: 492, "font-size": 13 }, "The bar shows how much of the note is left."));
  return {
    setLeft(frac) {
      const f = Math.max(0, Math.min(1, frac));
      const lostPx = f < 1 ? Math.max(3, (1 - f) * w) : 0;   // always show at least a sliver once anything has melted
      left.setAttribute("width", String(w - lostPx));
      melted.setAttribute("x", String(x + w - lostPx));
      melted.setAttribute("width", String(lostPx));
      leftText.textContent = `${(f * 100).toFixed(2)}% left`;
      meltedText.textContent = `${((1 - f) * 100).toFixed(2)}% melted into the town pot`;
    },
  };
}
