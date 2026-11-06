// RICE scoring, a capacity cut line, and a Monte Carlo check on how stable
// the plan is when the estimates are uncertain. No DOM code here.

export const IMPACT = [
  { value: 3, label: "Massive" },
  { value: 2, label: "High" },
  { value: 1, label: "Medium" },
  { value: 0.5, label: "Low" },
  { value: 0.25, label: "Minimal" },
];
export const CONFIDENCE = [
  { value: 1, label: "High (100%)" },
  { value: 0.8, label: "Medium (80%)" },
  { value: 0.5, label: "Low (50%)" },
];

export const SAMPLE = {
  capacity: 12,
  items: [
    { name: "SSO for enterprise plans", reach: 900, impact: 2, confidence: 0.8, effort: 3 },
    { name: "Bulk CSV import", reach: 2500, impact: 1, confidence: 1, effort: 2 },
    { name: "Mobile offline mode", reach: 4000, impact: 1, confidence: 0.5, effort: 6 },
    { name: "Usage-based billing", reach: 600, impact: 3, confidence: 0.5, effort: 5 },
    { name: "Onboarding checklist", reach: 6000, impact: 0.5, confidence: 0.8, effort: 1 },
    { name: "Audit log export", reach: 400, impact: 1, confidence: 1, effort: 1 },
    { name: "Dark mode", reach: 5000, impact: 0.25, confidence: 1, effort: 1.5 },
    { name: "Slack notifications", reach: 3000, impact: 0.5, confidence: 0.8, effort: 1 },
    { name: "AI summary of activity", reach: 3500, impact: 1, confidence: 0.5, effort: 3 },
    { name: "Custom roles and permissions", reach: 700, impact: 2, confidence: 0.8, effort: 4 },
  ],
};

export function score({ reach, impact, confidence, effort }) {
  if (!(effort > 0)) return 0;
  return (reach * impact * confidence) / effort;
}

/** Items with their score and rank, highest score first. Ties keep input order. */
export function rank(items) {
  return items
    .map((item, index) => ({ ...item, index, score: score(item), value: item.reach * item.impact * item.confidence }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

/**
 * Walk down the ranked list and fund items until capacity runs out. An item
 * that does not fit is skipped, and smaller items below it can still fit.
 * This is the plan most teams actually make.
 */
export function cutLine(ranked, capacity) {
  let used = 0;
  const funded = new Set();
  for (const item of ranked) {
    if (used + item.effort <= capacity + 1e-9) {
      used += item.effort;
      funded.add(item.index);
    }
  }
  return { funded, used };
}

export function plan(items, capacity) {
  const ranked = rank(items);
  const { funded, used } = cutLine(ranked, capacity);
  return { ranked: ranked.map((r) => ({ ...r, funded: funded.has(r.index) })), used, capacity };
}

/** Quadrants split at the median value and median effort. */
export function quadrants(items) {
  const ranked = rank(items);
  const mv = median(ranked.map((r) => r.value));
  const me = median(ranked.map((r) => r.effort));
  const name = (r) => (r.value >= mv ? (r.effort <= me ? "Quick win" : "Big bet") : r.effort <= me ? "Fill-in" : "Money pit");
  return { medianValue: mv, medianEffort: me, items: ranked.map((r) => ({ ...r, quadrant: name(r) })) };
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Small, fast, seedable PRNG so simulations are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How likely is each item to be funded if the estimates are off?
 *
 * Reach and effort are drawn from a lognormal around the estimate. Lower
 * confidence means a wider spread, so a 50% confidence guess moves more than
 * a 100% one. Effort also gets a right skew, because work runs over more
 * often than under. Each run re-ranks and re-cuts the whole list.
 */
export function simulate(items, capacity, { runs = 2000, seed = 1, spread = 0.35 } = {}) {
  const rand = mulberry32(seed);
  const normal = () => {
    // Box-Muller
    const u = 1 - rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const counts = new Array(items.length).fill(0);
  const rankSums = new Array(items.length).fill(0);
  for (let r = 0; r < runs; r++) {
    const drawn = items.map((it) => {
      const sigma = spread * (1.5 - it.confidence);
      return {
        ...it,
        reach: it.reach * Math.exp(sigma * normal()),
        effort: it.effort * Math.exp(sigma * normal() + 0.5 * sigma * sigma),
      };
    });
    const ranked = rank(drawn);
    const { funded } = cutLine(ranked, capacity);
    for (const item of ranked) {
      rankSums[item.index] += item.rank;
      if (funded.has(item.index)) counts[item.index]++;
    }
  }
  return items.map((_, i) => ({ index: i, pFunded: counts[i] / runs, meanRank: rankSums[i] / runs }));
}

/** Items whose funding is a coin flip. These are the ones worth a better estimate. */
export function contested(sim, low = 0.2, high = 0.8) {
  return sim.filter((s) => s.pFunded > low && s.pFunded < high).map((s) => s.index);
}

// CSV ---------------------------------------------------------------------

const HEADERS = ["name", "reach", "impact", "confidence", "effort"];

export function toCsv(items) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [HEADERS.join(","), ...items.map((it) => HEADERS.map((h) => esc(it[h])).join(","))].join("\n") + "\n";
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()));
  if (!nonEmpty.length) throw new Error("The file is empty.");
  const head = nonEmpty[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(HEADERS.map((h) => [h, head.indexOf(h)]));
  const missing = HEADERS.filter((h) => col[h] < 0);
  if (missing.length) throw new Error(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  return nonEmpty.slice(1).map((r, n) => {
    const item = { name: (r[col.name] || "").trim() || `Item ${n + 1}` };
    for (const h of HEADERS.slice(1)) {
      let raw = (r[col[h]] || "").trim();
      const pct = raw.endsWith("%");
      const v = Number(pct ? raw.slice(0, -1) : raw);
      if (!Number.isFinite(v) || v < 0) throw new Error(`Row ${n + 2}: ${h} must be a non-negative number, got "${raw}".`);
      item[h] = pct || (h === "confidence" && v > 1) ? v / 100 : v;
    }
    return item;
  });
}

// Sharing -----------------------------------------------------------------

export function encodeState(state) {
  const json = JSON.stringify({ c: state.capacity, i: state.items.map((it) => [it.name, it.reach, it.impact, it.confidence, it.effort]) });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(hash) {
  try {
    const b64 = String(hash).replace(/^#/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!b64) return null;
    const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
    const items = data.i.map(([name, reach, impact, confidence, effort]) => ({ name: String(name), reach: +reach, impact: +impact, confidence: +confidence, effort: +effort }));
    if (!(data.c > 0) || items.some((it) => [it.reach, it.impact, it.confidence, it.effort].some((v) => !Number.isFinite(v)))) return null;
    return { capacity: +data.c, items };
  } catch {
    return null;
  }
}

export function toMarkdown(state, sim) {
  const p = plan(state.items, state.capacity);
  const lines = [
    `## Quarter plan (${fmt(p.used)} of ${fmt(state.capacity)} person-months)`,
    "",
    "| Rank | Initiative | RICE | Effort | Funded | Chance funded |",
    "|---|---|---:|---:|---|---:|",
  ];
  for (const r of p.ranked) {
    const chance = sim ? `${Math.round(sim[r.index].pFunded * 100)}%` : "";
    lines.push(`| ${r.rank} | ${r.name.replace(/\|/g, "\\|")} | ${fmt(r.score)} | ${fmt(r.effort)} | ${r.funded ? "Yes" : "No"} | ${chance} |`);
  }
  return lines.join("\n") + "\n";
}

export function fmt(n) {
  if (n >= 100) return Math.round(n).toLocaleString("en-US");
  return String(Math.round(n * 10) / 10);
}
