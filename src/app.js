import {
  CONFIDENCE, IMPACT, SAMPLE, contested, decodeState, encodeState, fmt, parseCsv, plan, quadrants,
  simulate, toCsv, toMarkdown,
} from "./rice.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const STORE = "rice-planner:v1";

let state = decodeState(location.hash) || loadLocal() || structuredClone(SAMPLE);
let sim = null;
let simTimer = 0;

function loadLocal() {
  try {
    return decodeState(localStorage.getItem(STORE) || "");
  } catch {
    return null;
  }
}

function save() {
  const code = encodeState(state);
  history.replaceState(null, "", `#${code}`);
  try {
    localStorage.setItem(STORE, code);
  } catch {
    // Private windows can refuse storage. The URL still holds the state.
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// Editing -----------------------------------------------------------------

function select(options, value, onchange) {
  return el("select", { onchange }, options.map((o) => el("option", { value: o.value, selected: o.value === value, text: o.label })));
}

function numberInput(value, onInput, attrs = {}) {
  return el("input", { type: "number", min: 0, step: "any", value, ...attrs, oninput: (e) => {
    const n = Number(e.target.value);
    if (e.target.value !== "" && Number.isFinite(n) && n >= 0) onInput(n);
  } });
}

function renderEditor() {
  $("capacity").value = state.capacity;
  $("edit-rows").replaceChildren(
    ...state.items.map((item, i) => {
      const set = (key) => (v) => { state.items[i][key] = v; changed(); };
      // Keep a custom impact or confidence from an imported CSV selectable.
      const impacts = IMPACT.some((o) => o.value === item.impact) ? IMPACT : [...IMPACT, { value: item.impact, label: String(item.impact) }];
      const confs = CONFIDENCE.some((o) => o.value === item.confidence) ? CONFIDENCE : [...CONFIDENCE, { value: item.confidence, label: `${Math.round(item.confidence * 100)}%` }];
      return el("tr", {}, [
        el("td", {}, [el("input", { value: item.name, "aria-label": "Initiative name", oninput: (e) => set("name")(e.target.value) })]),
        el("td", { class: "num" }, [numberInput(item.reach, set("reach"), { "aria-label": "Reach", step: 50 })]),
        el("td", {}, [select(impacts, item.impact, (e) => set("impact")(Number(e.target.value)))]),
        el("td", {}, [select(confs, item.confidence, (e) => set("confidence")(Number(e.target.value)))]),
        el("td", { class: "num" }, [numberInput(item.effort, set("effort"), { "aria-label": "Effort in person-months", step: 0.5 })]),
        el("td", {}, [el("button", { type: "button", class: "icon", "aria-label": `Remove ${item.name}`, title: "Remove", text: "×", onclick: () => {
          state.items.splice(i, 1);
          renderEditor();
          changed();
        } })]),
      ]);
    }),
  );
}

// Results -----------------------------------------------------------------

function changed() {
  sim = null;
  renderResults();
  save();
  clearTimeout(simTimer);
  // The simulation takes a few milliseconds per thousand runs, so wait for typing to pause.
  simTimer = setTimeout(() => {
    sim = state.items.length ? simulate(state.items, state.capacity) : [];
    renderResults();
  }, 180);
}

function card(label, value, sub) {
  return el("div", { class: "card" }, [el("span", { class: "card-label", text: label }), el("span", { class: "card-total", text: value }), el("span", { class: "card-sub", text: sub })]);
}

function renderResults() {
  const p = plan(state.items, state.capacity);
  const funded = p.ranked.filter((r) => r.funded);
  const disputed = sim ? new Set(contested(sim)) : new Set();
  const surprises = sim ? p.ranked.filter((r) => !r.funded && sim[r.index].pFunded > 0.5) : [];

  $("cards").replaceChildren(
    card("Funded", `${funded.length} of ${state.items.length}`, "initiatives above the line"),
    card("Capacity used", `${fmt(p.used)} / ${fmt(state.capacity)}`, "person-months"),
    card("Funded RICE total", fmt(funded.reduce((s, r) => s + r.score, 0)), "sum of scores above the line"),
    card("Contested", sim ? String(disputed.size) : "...", "items funded in 20% to 80% of runs"),
  );

  const warnings = [];
  for (const r of surprises) warnings.push(`"${r.name}" is below the line, but it gets funded in ${Math.round(sim[r.index].pFunded * 100)}% of simulated quarters. A small change in the estimates above it would swap it in.`);
  const zero = state.items.filter((it) => !(it.effort > 0));
  if (zero.length) warnings.push(`Effort must be above zero to score: ${zero.map((it) => it.name).join(", ")}.`);
  $("warnings").replaceChildren(...warnings.map((w) => el("li", { text: w })));

  const top = Math.max(1, ...p.ranked.map((r) => r.score));
  let lineDrawn = false;
  $("rank-rows").replaceChildren(
    ...p.ranked.map((r) => {
      const first = !r.funded && !lineDrawn;
      if (first) lineDrawn = true;
      const chance = sim ? sim[r.index].pFunded : null;
      return el("tr", { class: `${r.funded ? "" : "cut"}${first ? " line" : ""}` }, [
        el("td", { class: "num", text: r.rank }),
        el("td", { text: r.name }),
        el("td", {}, [el("div", { class: "barcell" }, [el("i", { class: `bar ${r.funded ? "funded" : "cut"}`, style: `width:${Math.max(2, (r.score / top) * 110)}px` }), el("span", { text: fmt(r.score) })])]),
        el("td", { class: "num", text: fmt(r.effort) }),
        el("td", {}, [el("div", { class: "barcell" }, chance == null ? [el("span", { text: "..." })] : [
          el("span", { class: "meter" }, [el("i", { style: `width:${chance * 100}%` })]),
          el("span", { text: `${Math.round(chance * 100)}%` }),
          disputed.has(r.index) ? el("span", { class: "tag", text: "contested" }) : "",
        ])]),
      ]);
    }),
  );
  drawChart(p);
}

function drawChart(p) {
  const chart = $("chart");
  const W = 560, H = 360, m = { l: 58, r: 18, t: 16, b: 44 };
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!p.ranked.length) return chart.replaceChildren();
  const q = quadrants(state.items);
  const funded = new Map(p.ranked.map((r) => [r.index, r.funded]));
  const maxE = niceCeil(Math.max(...q.items.map((r) => r.effort)) * 1.08);
  const maxV = niceCeil(Math.max(...q.items.map((r) => r.value)) * 1.08);
  const x = (e) => m.l + (e / maxE) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / maxV) * (H - m.t - m.b);

  const nodes = [];
  for (let i = 0; i <= 4; i++) {
    const v = (maxV * i) / 4, e = (maxE * i) / 4;
    nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmt(v)));
    nodes.push(svg("text", { x: x(e), y: H - m.b + 18, class: "tick", "text-anchor": "middle" }, fmt(e)));
  }
  nodes.push(svg("text", { x: (m.l + W - m.r) / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, "Effort (person-months)"));
  nodes.push(svg("text", { x: 12, y: (m.t + H - m.b) / 2, class: "tick", "text-anchor": "middle", transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})` }, "Value"));

  nodes.push(svg("line", { x1: x(q.medianEffort), x2: x(q.medianEffort), y1: m.t, y2: H - m.b, class: "median" }));
  nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(q.medianValue), y2: y(q.medianValue), class: "median" }));
  const corner = (label, left, top) => svg("text", { x: left ? m.l + 8 : W - m.r - 8, y: top ? m.t + 12 : H - m.b - 8, class: "quad", "text-anchor": left ? "start" : "end" }, label);
  nodes.push(corner("Quick wins", true, true), corner("Big bets", false, true), corner("Fill-ins", true, false), corner("Money pits", false, false));

  const tip = $("tooltip");
  // Larger, low-effort points first so smaller ones stay on top and hoverable.
  for (const r of [...q.items].sort((a, b) => b.value - a.value)) {
    const cx = x(r.effort), cy = y(r.value);
    const dot = svg("circle", { cx, cy, r: 7, class: `pt ${funded.get(r.index) ? "funded" : "cut"}`, tabindex: 0, "aria-label": `${r.name}: value ${fmt(r.value)}, effort ${fmt(r.effort)}` });
    const show = () => {
      dot.classList.add("active");
      tip.replaceChildren(
        el("strong", { text: r.name }),
        el("div", {}, [el("span", { text: r.quadrant }), el("span", { text: funded.get(r.index) ? "Funded" : "Below the line" })]),
        el("div", {}, [el("span", { text: "Value" }), el("b", { text: fmt(r.value) })]),
        el("div", {}, [el("span", { text: "Effort" }), el("b", { text: `${fmt(r.effort)} pm` })]),
        el("div", {}, [el("span", { text: "RICE" }), el("b", { text: fmt(r.score) })]),
      );
      tip.hidden = false;
      const box = chart.getBoundingClientRect();
      const px = (cx / W) * box.width, py = (cy / H) * box.height;
      tip.style.left = `${px > box.width / 2 ? px - tip.offsetWidth - 14 : px + 14}px`;
      tip.style.top = `${Math.max(0, py - 20)}px`;
    };
    const hide = () => { dot.classList.remove("active"); tip.hidden = true; };
    dot.addEventListener("pointerenter", show);
    dot.addEventListener("focus", show);
    dot.addEventListener("pointerleave", hide);
    dot.addEventListener("blur", hide);
    nodes.push(dot);
  }
  chart.replaceChildren(...nodes);
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * mag >= v) return s * mag;
  return 10 * mag;
}

// Actions -----------------------------------------------------------------

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

async function copy(btn, text, done) {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, done);
  } catch {
    flash(btn, "Copy failed");
  }
}

$("capacity").addEventListener("input", (e) => {
  const n = Number(e.target.value);
  if (n > 0) { state.capacity = n; changed(); }
});
$("add").addEventListener("click", () => {
  state.items.push({ name: "New initiative", reach: 1000, impact: 1, confidence: 0.8, effort: 1 });
  renderEditor();
  changed();
  $("edit-rows").lastElementChild.querySelector("input").select();
});
$("reset").addEventListener("click", () => {
  state = structuredClone(SAMPLE);
  renderEditor();
  changed();
});
$("share").addEventListener("click", (e) => copy(e.target, location.href, "Link copied"));
$("copy-md").addEventListener("click", (e) => copy(e.target, toMarkdown(state, sim), "Copied"));
$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([toCsv(state.items)], { type: "text/csv" }));
  el("a", { href: url, download: "rice-plan.csv" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    state = { capacity: state.capacity, items: parseCsv(await file.text()) };
    renderEditor();
    changed();
  } catch (err) {
    $("warnings").replaceChildren(el("li", { text: `Could not import ${file.name}: ${err.message}` }));
  }
});

renderEditor();
changed();
