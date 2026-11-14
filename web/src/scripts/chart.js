// Draws the simulation chart from assets/simulation.json in the page's own fonts and colours.
const NS = "http://www.w3.org/2000/svg";
const mk = (n, a = {}, t) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (t != null) e.textContent = t; return e; };
const nf = (n) => Math.round(n).toLocaleString("en-US");

function lineChart({ w, h, m, xMax, yMax, yTicks, xTicks, series, labels = true, label }) {
  const svg = mk("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": label, class: "plot" });
  const X = (x) => m.l + (x / xMax) * (w - m.l - m.r);
  const Y = (y) => h - m.b - (y / yMax) * (h - m.t - m.b);
  for (const t of yTicks) {
    svg.append(mk("line", { class: "grid", x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t) }));
    svg.append(mk("text", { class: "tick", x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, nf(t)));
  }
  for (const t of xTicks) svg.append(mk("text", { class: "tick", x: X(t), y: h - m.b + 18, "text-anchor": "middle" }, String(t)));
  svg.append(mk("text", { class: "tick", x: w - m.r, y: h - 4, "text-anchor": "end" }, "day"));
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    svg.append(mk("path", { class: "series " + s.cls, d }));
    if (labels && s.endLabel) svg.append(mk("text", { class: "end " + s.cls, x: X(s.values.length - 1) + 8, y: Y(s.values.at(-1)) + 4 }, s.endLabel(s.values.at(-1))));
  }
  return svg;
}

export async function drawChart(container) {
  const res = await fetch("/assets/simulation.json");
  if (!res.ok) throw new Error("simulation data not found");
  const d = await res.json();
  const phone = matchMedia("(max-width: 40rem)");
  const body = document.createElement("div");
  container.prepend(body);
  const draw = () => body.replaceChildren(...build(d, phone.matches));
  phone.addEventListener("change", draw);
  draw();
}

function build(d, narrow) {
  const first = d.runs[0];
  const last = d.days.length - 1;
  const paidOut = first.paid_out[last], back = first.melted_back[last];
  const total = d.days.map(() => 1_000_000);
  const a = lineChart({
    w: narrow ? 420 : 700, h: narrow ? 280 : 300,
    m: narrow ? { l: 80, r: 14, t: 14, b: 44 } : { l: 78, r: 190, t: 14, b: 40 },
    xMax: last, yMax: 1_000_000,
    yTicks: [0, 250_000, 500_000, 750_000, 1_000_000], xTicks: d.days.filter((x) => x % 10 === 0),
    labels: !narrow,
    label: `Over ${last} days the pot falls from 1,000,000 to ${nf(first.treasury[last])} coins because the DAO pays coins out, while ${nf(back)} melted back. People hold ${nf(first.circulating[last])}. The total stays 1,000,000. The curves are the same in all three runs.`,
    series: [
      { values: total, cls: "s-total" },
      { values: first.treasury, cls: "s-treasury", endLabel: (v) => `In the pot ${nf(v)}` },
      { values: first.circulating, cls: "s-ink", endLabel: (v) => `In people's hands ${nf(v)}` },
      { values: first.melted_back, cls: "s-melt", endLabel: (v) => `Melted back ${nf(v)}` },
    ],
  });
  const explain = document.createElement("p");
  explain.className = "chart-explain";
  explain.innerHTML = `In this simulation the DAO pays out ${d.payout_pct_of_treasury}% of the pot every day. In ${last} days it paid out <b>${nf(paidOut)}</b> coins, and <b class="melt">${nf(back)}</b> melted back, so the pot fell by <b>${nf(paidOut - back)}</b>. That is exactly what people now hold. <b>The pot only goes down because coins are paid out.</b> With no payouts, nothing would leave it: it could only grow as coins melt back, and the pot plus people's holdings would stay at exactly 1,000,000, the dashed line.`;
  const dayLegend = document.createElement("p");
  dayLegend.className = "legend";
  dayLegend.innerHTML = `<span class="key"><span class="sw s-treasury"></span>In the pot at day ${last}: ${nf(first.treasury[last])}</span> <span class="key"><span class="sw s-ink"></span>In people's hands: ${nf(first.circulating[last])}</span> <span class="key"><span class="sw s-melt"></span>Melted back so far: ${nf(back)}</span> <span class="key"><span class="sw s-total"></span>Total: 1,000,000</span>`;
  const yMax = Math.ceil(Math.max(...d.runs.flatMap((r) => r.paid)) / 500) * 500;
  const panels = d.runs.map((r) => {
    const box = document.createElement("div");
    const t = document.createElement("p"); t.className = "panel-title"; t.textContent = `${r.hoarders} hoard, ${100 - r.hoarders} spend`;
    box.append(t, lineChart({
      w: 320, h: narrow ? 170 : 230, m: { l: 52, r: 14, t: 10, b: 38 }, xMax: last, yMax,
      yTicks: [0, yMax / 2, yMax], xTicks: [0, 20, 40, 60],
      label: `${r.hoarders} wallets hoard and ${100 - r.hoarders} spend. An idle holder's 100 coins fall to ${nf(r.idle[last])}. A wallet paid regularly by the pot ends at ${nf(r.paid[last])}.`,
      series: [{ values: r.idle, cls: "s-melt" }, { values: r.paid, cls: "s-treasury" }], labels: false,
    }));
    return box;
  });
  const legend = document.createElement("p");
  legend.className = "legend";
  legend.innerHTML = '<span class="key"><span class="sw s-melt"></span>Idle holder: claims once, then nothing</span> <span class="key"><span class="sw s-treasury"></span>Paid by the pot: regular payouts</span>';
  const topTitle = document.createElement("h3"); topTitle.textContent = "Where the 1,000,000 coins are, day by day";
  const bottomTitle = document.createElement("h3"); bottomTitle.textContent = "Two sample wallets, in three different crowds";
  const grid = document.createElement("div"); grid.className = "panels"; grid.append(...panels);
  return [topTitle, explain, a, dayLegend, bottomTitle, legend, grid];
}
