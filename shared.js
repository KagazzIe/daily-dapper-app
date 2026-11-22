// Shared between the background script, the extension pages and the phone website.
// Dates, the routine's defaults, schedule logic and the streak.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = { AM: "Morning", PM: "Evening", WASH: "After washing" };
const SLOT_ORDER = ["AM", "PM", "WASH"];

// The routine day rolls over at 4am local time, so a late PM routine still counts for the day before.
const DAY_START_HOUR = 4;

// Synced to the data repo (settings.json), so every device behaves the same.
const SETTINGS_DEFAULTS = {
  notifications: true,
  amTime: "08:00",
  pmTime: "21:30",
  nudge: true, // a second reminder if the evening steps still aren't done
  nudgeTime: "22:30",
};

// Secrets stay on each device and are never synced.
const LOCAL_DEFAULTS = { githubToken: "", githubRepo: "" };

// ---------- Dates ----------

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseKey(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const dow = (d) => (d.getDay() + 6) % 7; // Monday = 0
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const mondayOf = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -dow(d));

function studyDate() {
  const d = new Date();
  d.setHours(d.getHours() - DAY_START_HOUR);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
const todayKey = () => dateKey(studyDate());

// ---------- Routine ----------

function defaultRoutine() {
  const amz = (id) => `https://www.amazon.com/dp/${id}`;
  const all = [0, 1, 2, 3, 4, 5, 6];
  const P = (id, name, slots, days, step, links, note, optDays = []) => ({ id, name, slots, days, optDays, step, links, note });
  return {
    v: 1,
    startDate: todayKey(), // the streak counts from here
    washDays: [0, 2, 4],
    products: [
      P("toner", "Hydrating toner", ["AM", "PM"], all, 2, [amz("B0CSDWS3HJ")], "First step after cleansing, morning and night."),
      P("vitc", "Vitamin C serum", ["AM"], all, 3, [amz("B07PNCCLD2")], "Mornings only. Let it absorb before sunscreen."),
      P("spf", "Sunscreen", ["AM"], all, 9, [amz("B09JW55Y5K")], "Always the last morning step, especially while you use retinol."),
      P("mask", "Clay mask", ["PM"], [6], 1, [amz("B081FK6L1G")], "Use on clean skin, rinse, then continue the routine. Never on a retinol night.", [2]),
      P("retinol", "Retinol", ["PM"], [0, 3], 4, [amz("B07VWSN95S")], "Pea-sized amount, after toner. Skip if your skin is irritated."),
      P("hair1", "Hair volumizer (1)", ["WASH"], [], 1, [amz("B0CGSLVL8T")], ""),
      P("hair2", "Hair volumizer (2)", ["WASH"], [], 2, [amz("B0DK263J67")], ""),
      P("hairoil", "Hair oil", ["WASH"], [], 3, [amz("B07VR1NDSQ")], "A few drops, mostly on the ends."),
      P("beard", "Beard thickener", ["WASH"], [], 4, [amz("B0F51V5K56")], ""),
      P("beardoil", "Beard oil", ["WASH"], [], 5, [], ""),
    ],
  };
}

const checkKey = (p, slot) => `${p.id}:${slot}`;

// "req", "opt" or null. dayChecks is that day's check map (for the "_wash" flag).
function slotKind(routine, dayChecks, p, slot, ds) {
  const d = dow(parseKey(ds));
  if (slot === "WASH") return routine.washDays.includes(d) || dayChecks?._wash ? "req" : null;
  if (p.days.includes(d)) return "req";
  if ((p.optDays || []).includes(d)) return "opt";
  return null;
}

function stepsFor(routine, dayChecks, ds) {
  const out = { AM: [], PM: [], WASH: [] };
  for (const p of routine.products) {
    for (const s of p.slots) {
      const kind = slotKind(routine, dayChecks, p, s, ds);
      if (kind) out[s].push({ p, slot: s, kind, key: checkKey(p, s), done: !!dayChecks?.[checkKey(p, s)] });
    }
  }
  for (const a of Object.values(out)) a.sort((x, y) => (x.p.step || 0) - (y.p.step || 0));
  return out;
}

// Required steps and which are left. Optional steps (like the Wednesday mask) never count.
function dayStatus(routine, dayChecks, ds) {
  const st = stepsFor(routine, dayChecks, ds);
  const required = SLOT_ORDER.flatMap((s) => st[s]).filter((x) => x.kind === "req");
  const left = required.filter((x) => !x.done);
  return { steps: st, required, left, complete: required.length > 0 && left.length === 0 };
}

// Applies one check-off to the checks doc. Each day remembers whether it was complete ("_done") at the time,
// so later changes to the routine don't rewrite history.
// op: { day, key, value }, where key is "<productId>:<slot>" or "_wash".
function applyCheckOp(doc, op, routine) {
  const checks = { ...(doc?.checks || {}) };
  const day = { ...(checks[op.day] || {}) };
  if (op.value) day[op.key] = true;
  else delete day[op.key];
  delete day._done;
  if (dayStatus(routine, day, op.day).complete) day._done = true;
  if (Object.keys(day).length) checks[op.day] = day;
  else delete checks[op.day];
  return { ...doc, checks };
}

// ---------- Streak ----------
// A streak day is one where every required step was done. One missed day per Mon-Sun week is forgiven
// (a grace day: it doesn't break the streak or add to it); a second miss that week resets it.
// Today only counts once it's complete, and an unfinished today never breaks anything.
// A past day counts if it was complete when it was ticked ("_done") or is complete under today's routine.
// Returns the streak and each past day's result in `days` ("done", "grace" or "missed").
function computeStreak(routine, checksDoc, today = todayKey()) {
  const checks = checksDoc?.checks || {};
  const keys = Object.keys(checks).sort();
  let start = routine.startDate || today;
  if (keys.length && keys[0] < start) start = keys[0];
  let current = 0;
  let best = 0;
  const graceUsed = new Set();
  const days = {};
  for (let d = parseKey(start); dateKey(d) < today; d = addDays(d, 1)) {
    const k = dateKey(d);
    if (checks[k]?._done || dayStatus(routine, checks[k], k).complete) {
      best = Math.max(best, ++current);
      days[k] = "done";
    } else {
      const wk = dateKey(mondayOf(d));
      if (graceUsed.has(wk)) {
        current = 0;
        days[k] = "missed";
      } else {
        graceUsed.add(wk);
        days[k] = "grace";
      }
    }
  }
  const todayDone = dayStatus(routine, checks[today], today).complete;
  if (todayDone) {
    best = Math.max(best, ++current);
    days[today] = "done";
  }
  const thisWeek = dateKey(mondayOf(parseKey(today)));
  return { current, best, todayDone, graceLeft: !graceUsed.has(thisWeek), days };
}

// ---------- Misc ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const uid = () => Math.random().toString(36).slice(2, 9);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
