import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE, contested, cutLine, decodeState, encodeState, median, mulberry32, parseCsv, plan,
  quadrants, rank, score, simulate, toCsv, toMarkdown,
} from "../src/rice.js";

const it = (name, reach, impact, confidence, effort) => ({ name, reach, impact, confidence, effort });

test("RICE is reach times impact times confidence over effort", () => {
  assert.equal(score(it("a", 1000, 2, 0.8, 4)), 400);
  assert.equal(score(it("zero effort", 1000, 2, 0.8, 0)), 0);
});

test("rank sorts by score and keeps input order on ties", () => {
  const r = rank([it("low", 10, 1, 1, 1), it("tie1", 100, 1, 1, 1), it("tie2", 200, 1, 1, 2)]);
  assert.deepEqual(r.map((x) => x.name), ["tie1", "tie2", "low"]);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3]);
});

test("cut line skips an item that does not fit and keeps filling", () => {
  const ranked = rank([it("a", 100, 1, 1, 4), it("big", 150, 1, 1, 6), it("c", 10, 1, 1, 2)]);
  const { funded, used } = cutLine(ranked, 7);
  // a (25/pm) fits, big (25/pm, tie, later) needs 6 and does not, c fits in the remaining 3.
  assert.deepEqual([...funded].sort(), [0, 2]);
  assert.equal(used, 6);
});

test("plan marks funded items on the sample", () => {
  const p = plan(SAMPLE.items, SAMPLE.capacity);
  assert.ok(p.used <= SAMPLE.capacity);
  assert.equal(p.ranked[0].name, "Onboarding checklist");
  assert.ok(p.ranked[0].funded);
  assert.equal(p.ranked.length, SAMPLE.items.length);
});

test("quadrants split at the medians", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const q = quadrants([it("qw", 1000, 1, 1, 1), it("bb", 1000, 1, 1, 9), it("fi", 10, 1, 1, 1), it("mp", 10, 1, 1, 9)]);
  assert.deepEqual(Object.fromEntries(q.items.map((x) => [x.name, x.quadrant])), { qw: "Quick win", bb: "Big bet", fi: "Fill-in", mp: "Money pit" });
});

test("the PRNG is deterministic", () => {
  const a = mulberry32(42), b = mulberry32(42);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("simulation is reproducible and gives sensible probabilities", () => {
  const s1 = simulate(SAMPLE.items, SAMPLE.capacity, { runs: 500, seed: 3 });
  const s2 = simulate(SAMPLE.items, SAMPLE.capacity, { runs: 500, seed: 3 });
  assert.deepEqual(s1, s2);
  assert.ok(s1.every((s) => s.pFunded >= 0 && s.pFunded <= 1 && s.meanRank >= 1 && s.meanRank <= SAMPLE.items.length));
});

test("a clear winner is always funded and a clear loser never is", () => {
  const items = [it("sure", 10000, 3, 1, 1), it("never", 1, 0.25, 0.5, 10), it("mid", 100, 1, 1, 1)];
  const s = simulate(items, 3, { runs: 300 });
  assert.equal(s[0].pFunded, 1);
  assert.equal(s[1].pFunded, 0);
});

test("low confidence means more spread in the simulated rank", () => {
  // Two identical items except confidence. Neither should be pinned at one rank.
  const items = [it("sure", 1000, 1, 1, 2), it("guess", 1250, 1, 0.8, 2), it("filler", 900, 1, 1, 2)];
  const s = simulate(items, 2, { runs: 2000 });
  assert.ok(contested(s).length >= 2);
});

test("CSV round-trips, including commas and quotes in names", () => {
  const items = [it('Say "hi", then go', 10, 1, 0.8, 2), it("Plain", 5, 0.5, 1, 1)];
  assert.deepEqual(parseCsv(toCsv(items)), items);
});

test("CSV accepts percent confidence, any column order, and CRLF", () => {
  const text = "Effort,Name,Confidence,Reach,Impact\r\n2,A,80%,100,1\r\n1,B,50,10,2\r\n";
  assert.deepEqual(parseCsv(text), [it("A", 100, 1, 0.8, 2), it("B", 10, 2, 0.5, 1)]);
});

test("CSV errors are specific", () => {
  assert.throws(() => parseCsv("name,reach\nA,1\n"), /Missing columns: impact, confidence, effort/);
  assert.throws(() => parseCsv("name,reach,impact,confidence,effort\nA,lots,1,1,1\n"), /Row 2: reach/);
  assert.throws(() => parseCsv("\n\n"), /empty/);
});

test("state round-trips through the URL and garbage is rejected", () => {
  const state = { capacity: 9.5, items: [it("Ünïcode ✓", 10, 1, 0.8, 2)] };
  assert.deepEqual(decodeState(`#${encodeState(state)}`), state);
  assert.equal(decodeState("#not-base64!!"), null);
  assert.equal(decodeState(""), null);
});

test("markdown export lists every item with funding and chance", () => {
  const sim = simulate(SAMPLE.items, SAMPLE.capacity, { runs: 200 });
  const md = toMarkdown(SAMPLE, sim);
  assert.match(md, /^## Quarter plan \(\d+(\.\d)? of 12 person-months\)/);
  assert.equal(md.trim().split("\n").length, 4 + SAMPLE.items.length);
  assert.match(md, /\| 1 \| Onboarding checklist \| 2,400 \| 1 \| Yes \| \d+% \|/);
});
