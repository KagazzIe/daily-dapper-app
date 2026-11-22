// The main page. In the extension it's the new tab page, the toolbar popup (?view=popup) and a full tab;
// on the phone it's the website's home page.

const $ = (id) => document.getElementById(id);
const VIEW = new URLSearchParams(location.search).get("view");
if (VIEW === "popup") document.documentElement.classList.add("popup");
if (!VIEW && !window.IS_WEB_APP) document.title = "New Tab";

let R = null; // routine doc
let C = null; // checks doc
let S = { ...SETTINGS_DEFAULTS }; // settings doc (reminder times)
// The new tab page shows the whole routine only when something is due; otherwise just a link to it.
const IS_NEWTAB = !VIEW && !window.IS_WEB_APP;
let quiet = null; // null until decided on the first render
let today = todayKey();
let selDate = today;
let weekStart = mondayOf(parseKey(today));
let editing = null;

const fmt = (d, o) => d.toLocaleDateString(undefined, o || { month: "short", day: "numeric" });
const dayChecks = (ds) => C.checks[ds];
const findProd = (id) => R.products.find((p) => p.id === id);

// ---------- Render ----------

function render() {
  if (!R || !C) return;
  const now = todayKey();
  if (now !== today) {
    // Rolled over to a new day while open.
    if (selDate === today) selDate = now;
    today = now;
    weekStart = mondayOf(parseKey(today));
  }
  updateQuiet();
  $("todayLbl").textContent = fmt(parseKey(today), { weekday: "long", month: "long", day: "numeric" });
  const streak = computeStreak(R, C, today);
  renderStreak(streak);
  renderQuiet();
  renderDay();
  renderWeek(streak);
  if (!editing) renderProds();
  renderWash();
  syncStatusText().then((t) => ($("sync").textContent = t));
}

// Minutes since the routine day began (4am), so times after midnight sort after the evening.
const dayMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (((h - DAY_START_HOUR) % 24) + 24) % 24 * 60 + m;
};
const nowDayMinutes = () => dayMinutes(`${new Date().getHours()}:${new Date().getMinutes()}`);
const clock = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

// Required steps left today that are due now: morning steps any time, evening and after-wash steps from the
// evening reminder time on.
function dueNow() {
  const st = dayStatus(R, dayChecks(today), today);
  const eveningStarted = nowDayMinutes() >= dayMinutes(S.pmTime);
  return { st, due: st.left.filter((x) => x.slot === "AM" || eveningStarted) };
}

// Decided when the page opens. Afterwards it only switches to the full routine (when the evening comes round),
// never away from it, so ticking off the last step here doesn't make the list vanish.
function updateQuiet() {
  if (!IS_NEWTAB) return;
  const { due } = dueNow();
  const next = quiet === null ? !due.length : quiet && !due.length;
  if (next === quiet) return;
  quiet = next;
  document.documentElement.classList.toggle("quiet", quiet);
}

function renderQuiet() {
  if (!quiet) return;
  const { st } = dueNow();
  const later = st.left.filter((x) => x.slot !== "AM");
  let msg;
  if (st.complete) msg = "✅ All done for today. Looking sharp.";
  else if (!st.required.length) msg = "Nothing on the routine today.";
  else msg = `✅ Nothing due right now. Evening routine at ${esc(clock(S.pmTime))}: ${plural(later.length, "step")}.`;
  $("quietCard").innerHTML = `<div class="quietmsg">${msg}</div>
    <a class="btn" href="app.html?view=full" id="showFull">Open Daily Dapper</a>`;
}

function renderStreak(s) {
  const head = s.current ? `🔥 ${plural(s.current, "day")}` : "No streak yet";
  const bits = [];
  if (!s.todayDone) bits.push(s.current ? "finish today to make it " + (s.current + 1) : "finish today to start one");
  if (s.best > s.current) bits.push(`best ${s.best}`);
  bits.push(s.graceLeft ? "grace day available this week" : "grace day used this week");
  $("streak").innerHTML = `${esc(head)}<small>${esc(bits.join(" · "))}</small>`;
}

function stepHtml(ds, x) {
  const link = safeUrl((x.p.links || [])[0]);
  return `<label class="step ${x.done ? "done" : ""}">
    <input type="checkbox" data-tg="${esc(x.key)}|${ds}" ${x.done ? "checked" : ""}>
    <div class="txt"><div class="nm">${esc(x.p.name)} ${x.kind === "opt" ? '<span class="tag t-opt">optional</span>' : ""}</div>
    ${x.p.note ? `<div class="nt">${esc(x.p.note)}</div>` : ""}</div>
    ${link ? `<a class="buy" href="${esc(link)}" target="_blank" rel="noopener" title="Reorder ${esc(x.p.name)}">Reorder ↗</a>` : ""}
  </label>`;
}

function renderDay() {
  const d = parseKey(selDate);
  const c = dayChecks(selDate) || {};
  const st = dayStatus(R, c, selDate);
  const req = st.required.length;
  const done = req - st.left.length;
  const title = selDate === today ? "Today" : fmt(d, { weekday: "long" });
  let h = `<div class="dayhead"><h2 style="margin:0">${title}</h2><span class="progress">${fmt(d)} · ${done}/${req} done</span></div>
    <div class="bar"><i style="width:${req ? (done / req) * 100 : 0}%"></i></div>`;
  if (st.complete) h += `<div class="alldone">✅ All done${selDate === today ? " for today. Looking sharp." : "."}</div>`;
  for (const s of SLOT_ORDER) {
    if (!st.steps[s].length) continue;
    h += `<div class="slot"><h3><span class="tag t-${s}">${s === "WASH" ? "Wash" : s}</span>${SLOTS[s]}</h3>`;
    h += st.steps[s].map((x) => stepHtml(selDate, x)).join("");
    h += "</div>";
  }
  if (!R.washDays.includes(dow(d))) {
    h += `<button class="washbtn" data-wash="${selDate}">${c._wash ? "Undo: I didn't wash my hair" : "🚿 I washed my hair today"}</button>`;
  }
  if (selDate !== today) h += ` <button class="ghost backtoday" data-sel="${today}">Back to today</button>`;
  $("dayCard").innerHTML = h;
}

function renderWeek(streak) {
  const days = [...Array(7)].map((_, i) => dateKey(addDays(weekStart, i)));
  $("weekLbl").textContent = `${fmt(weekStart)} – ${fmt(addDays(weekStart, 6))}`;
  const mark = { done: "✅", grace: "🌙", missed: "✗" };
  const rows = [];
  for (const s of SLOT_ORDER) {
    R.products.filter((p) => p.slots.includes(s)).sort((a, b) => (a.step || 0) - (b.step || 0)).forEach((p) => rows.push({ p, s }));
  }
  let h = "<tr><th></th>" + days.map((ds, i) =>
    `<th class="dh ${ds === selDate ? "sel" : ""} ${ds === today ? "today" : ""}" data-sel="${ds}">${DAYS[i]}<b>${parseKey(ds).getDate()}</b><i>${mark[streak.days[ds]] || ""}</i></th>`
  ).join("") + "</tr>";
  for (const { p, s } of rows) {
    h += `<tr><td class="rl" title="${esc(p.name)}"><span class="tag t-${s}">${s === "WASH" ? "Wash" : s}</span>${esc(p.name)}</td>`;
    for (const ds of days) {
      const k = slotKind(R, dayChecks(ds), p, s, ds);
      const dn = !!dayChecks(ds)?.[checkKey(p, s)];
      if (!k && !dn) {
        h += '<td><span class="cell none"></span></td>';
        continue;
      }
      h += `<td><button class="cell ${k === "opt" ? "opt" : "sched"} ${dn ? "done" : ""}" data-tg="${esc(checkKey(p, s))}|${ds}" aria-label="${esc(p.name)} ${s} ${ds}">${dn ? "✓" : ""}</button></td>`;
    }
    h += "</tr>";
  }
  $("matrix").innerHTML = h;
}

const dayToggles = (arr, attr, opt) =>
  `<div class="dtoggles ${opt ? "opt" : ""}">${DAYS.map((d, i) => `<button type="button" class="${arr.includes(i) ? "on" : ""}" data-${attr}="${i}">${d}</button>`).join("")}</div>`;

function whenText(p) {
  return p.slots.map((s) => {
    if (s === "WASH") return "After washing";
    const dd = p.days.length === 7 ? "daily" : p.days.length ? p.days.map((i) => DAYS[i]).join(", ") : "no days set";
    const od = (p.optDays || []).length ? ` (+ ${p.optDays.map((i) => DAYS[i]).join(", ")} optional)` : "";
    return `${s} ${dd}${od}`;
  }).join(" · ");
}

function renderProds() {
  $("prods").innerHTML = [...R.products].sort((a, b) => SLOT_ORDER.indexOf(a.slots[0]) - SLOT_ORDER.indexOf(b.slots[0]) || (a.step || 0) - (b.step || 0)).map((p) => {
    const links = (p.links || []).map(safeUrl).filter(Boolean);
    let h = `<div class="card prod"><div><div class="nm">${esc(p.name)}</div><div class="when">${esc(whenText(p))}</div></div>
      <div class="actions">${links.length ? links.map((u, i) => `<a class="btn ${i ? "alt" : ""}" href="${esc(u)}" target="_blank" rel="noopener">Reorder${links.length > 1 ? " " + (i + 1) : ""} ↗</a>`).join("") : '<span class="meta">No reorder link yet</span>'}
      <button class="ghost" data-edit="${p.id}">${editing === p.id ? "Close" : "Edit"}</button></div>`;
    if (editing === p.id) h += editorHtml(p);
    return h + "</div>";
  }).join("");
}

function editorHtml(p) {
  return `<form class="editor" data-form="${p.id}">
    <label>Name<input type="text" name="pname" value="${esc(p.name)}"></label>
    <label>Reorder link<input type="url" name="l0" value="${esc((p.links || [])[0] || "")}" placeholder="https://…"></label>
    <label>Second link (optional)<input type="url" name="l1" value="${esc((p.links || [])[1] || "")}" placeholder="https://…"></label>
    <div class="row">
      <label class="chk"><input type="checkbox" name="sAM" ${p.slots.includes("AM") ? "checked" : ""}> Morning</label>
      <label class="chk"><input type="checkbox" name="sPM" ${p.slots.includes("PM") ? "checked" : ""}> Evening</label>
      <label class="chk"><input type="checkbox" name="sWASH" ${p.slots.includes("WASH") ? "checked" : ""}> After washing</label>
    </div>
    <div class="lbl2">Morning/evening days ${dayToggles(p.days, "eday")}</div>
    <div class="lbl2">Optional days (don't count for the streak) ${dayToggles(p.optDays || [], "oday", true)}</div>
    <label>Step order (lower comes first)<input type="number" name="step" value="${p.step || 0}" min="0" step="1"></label>
    <label>Note<input type="text" name="note" value="${esc(p.note || "")}"></label>
    <div class="actions"><button class="primary" type="submit">Save</button><button type="button" class="ghost" data-del="${p.id}" style="color:var(--bad)">Delete product</button></div>
  </form>`;
}

function renderWash() {
  $("washDays").innerHTML = DAYS.map((d, i) => `<button type="button" class="${R.washDays.includes(i) ? "on" : ""}" data-wday="${i}">${d}</button>`).join("");
}

// ---------- Actions ----------

const saveRoutine = (fn) => updateDoc("routine", (r) => fn(structuredClone(r)));

document.addEventListener("change", (e) => {
  const t = e.target.closest("input[data-tg]");
  if (!t) return;
  const [key, ds] = t.dataset.tg.split("|");
  setCheck(ds, key, t.checked);
});

document.addEventListener("click", (e) => {
  let t;
  if ((t = e.target.closest("button[data-tg]"))) {
    const [key, ds] = t.dataset.tg.split("|");
    setCheck(ds, key, !dayChecks(ds)?.[key]);
  } else if ((t = e.target.closest("[data-sel]"))) {
    selDate = t.dataset.sel;
    render();
  } else if ((t = e.target.closest("[data-wash]"))) {
    const ds = t.dataset.wash;
    setCheck(ds, "_wash", !dayChecks(ds)?._wash);
  } else if ((t = e.target.closest("[data-wday]"))) {
    const i = +t.dataset.wday;
    saveRoutine((r) => ({ ...r, washDays: r.washDays.includes(i) ? r.washDays.filter((x) => x !== i) : [...r.washDays, i].sort() }));
  } else if ((t = e.target.closest("[data-edit]"))) {
    editing = editing === t.dataset.edit ? null : t.dataset.edit;
    renderProds();
  } else if ((t = e.target.closest("[data-eday],[data-oday]"))) {
    e.preventDefault();
    t.classList.toggle("on");
  } else if ((t = e.target.closest("[data-del]"))) {
    const i = R.products.findIndex((p) => p.id === t.dataset.del);
    const p = R.products[i];
    editing = null;
    saveRoutine((r) => ({ ...r, products: r.products.filter((x) => x.id !== p.id) }));
    toast(`Deleted ${p.name}.`, () => saveRoutine((r) => ({ ...r, products: [...r.products.slice(0, i), p, ...r.products.slice(i)] })));
  } else if (e.target.id === "prevW" || e.target.id === "nextW") {
    weekStart = addDays(weekStart, e.target.id === "prevW" ? -7 : 7);
    render();
  } else if (e.target.id === "addProd") {
    const p = { id: uid(), name: "New product", slots: ["PM"], days: [], optDays: [], step: 5, links: [], note: "" };
    editing = p.id;
    saveRoutine((r) => ({ ...r, products: [...r.products, p] })).then(() => {
      renderProds();
      const f = document.querySelector(`[data-form="${p.id}"]`);
      if (f) {
        f.scrollIntoView({ behavior: "smooth", block: "center" });
        f.elements.pname.select();
      }
    });
  } else if (e.target.id === "settingsLink") {
    e.preventDefault();
    browser.runtime.openOptionsPage();
    if (VIEW === "popup") window.close();
  } else if (e.target.id === "openFull" && !window.IS_WEB_APP) {
    e.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL("app.html?view=full") });
    window.close();
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id === "search") {
    e.preventDefault();
    const text = e.target.elements.q.value.trim();
    if (text) browser.search.query({ text, disposition: "CURRENT_TAB" });
    return;
  }
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  const id = f.dataset.form;
  const slots = SLOT_ORDER.filter((s) => f.elements["s" + s].checked);
  const days = [...f.querySelectorAll("[data-eday].on")].map((b) => +b.dataset.eday);
  const edits = {
    name: f.elements.pname.value.trim() || "Untitled",
    links: [f.elements.l0.value.trim(), f.elements.l1.value.trim()].filter(Boolean),
    slots: slots.length ? slots : ["PM"],
    days,
    optDays: [...f.querySelectorAll("[data-oday].on")].map((b) => +b.dataset.oday).filter((i) => !days.includes(i)),
    step: +f.elements.step.value || 0,
    note: f.elements.note.value.trim(),
  };
  editing = null;
  saveRoutine((r) => ({ ...r, products: r.products.map((p) => (p.id === id ? { ...p, ...edits } : p)) })).then(renderProds);
});

let toastEl = null;
let toastTimer = null;
function toast(msg, undo) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.innerHTML = `<span>${esc(msg)}</span>`;
  if (undo) {
    const b = document.createElement("button");
    b.textContent = "Undo";
    b.onclick = () => {
      undo();
      toastEl.remove();
      toastEl = null;
    };
    toastEl.append(b);
  }
  document.body.append(toastEl);
  toastTimer = setTimeout(() => {
    toastEl?.remove();
    toastEl = null;
  }, 6000);
}

// ---------- Load and stay current ----------

async function load() {
  [R, C, S] = await Promise.all([getDoc("routine"), getDoc("checks"), getSettings()]);
  render();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("doc:routine" in changes || "doc:checks" in changes || "doc:settings" in changes) load();
  else if (Object.keys(changes).some((k) => k.startsWith("sync:"))) syncStatusText().then((t) => ($("sync").textContent = t));
});

load().then(() => {
  if (window.IS_WEB_APP) {
    // No background script on the phone: this page uploads its own changes and checks for new ones.
    const pusher = enablePushing(2000);
    const pull = () => syncDown().catch(() => {});
    pull();
    setInterval(() => document.visibilityState === "visible" && pull(), 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") pusher.pushNow();
      else pull();
    });
  } else {
    // The background script syncs every 10 minutes; opening a page asks for a fresh copy.
    browser.runtime.sendMessage({ type: "sync" }).catch(() => {});
  }
});
setInterval(render, 60 * 1000); // keeps "today" right across the 4am rollover, and brings up the evening routine
