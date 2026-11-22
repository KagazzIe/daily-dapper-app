const $ = (id) => document.getElementById(id);

const flash = (id, text, ms = 2500) => {
  $(id).textContent = text;
  if (ms) setTimeout(() => ($(id).textContent === text ? ($(id).textContent = "") : null), ms);
};

const TIME_KEYS = ["amTime", "pmTime", "nudgeTime"];

async function render() {
  const s = await getSettings();
  const local = await browser.storage.local.get(Object.keys(LOCAL_DEFAULTS));
  for (const k of ["githubRepo", "githubToken"]) if (document.activeElement !== $(k)) $(k).value = local[k] || "";
  for (const k of TIME_KEYS) if (document.activeElement !== $(k)) $(k).value = s[k];
  $("notifications").checked = !!s.notifications;
  $("nudge").checked = !!s.nudge;
  $("status").textContent = await syncStatusText();

  const [routine, checks] = await Promise.all([getDoc("routine"), getDoc("checks")]);
  const st = computeStreak(routine, checks);
  const counts = Object.values(st.days).reduce((a, v) => ({ ...a, [v]: (a[v] || 0) + 1 }), {});
  $("streakInfo").textContent =
    `Current: ${plural(st.current, "day")} · Best: ${plural(st.best, "day")} · ` +
    `Since ${fmtDay(routine.startDate)}: ${counts.done || 0} full, ${counts.grace || 0} grace, ${counts.missed || 0} missed.`;
}

const fmtDay = (ds) => parseKey(ds).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

$("connect").addEventListener("click", async () => {
  const cfg = {
    repo: $("githubRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""),
    token: $("githubToken").value.trim(),
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo) || !cfg.token) return flash("sync-msg", "Enter the repo as owner/name and a token.", 0);
  flash("sync-msg", "Connecting…", 0);
  try {
    const report = await connectGitHub(cfg);
    flash("sync-msg", `Connected ✓ ${report.join(", ")}`, 0);
  } catch (e) {
    flash("sync-msg", `Couldn't connect: ${e.message}`, 0);
  }
  render();
});

$("sync-now").addEventListener("click", async () => {
  flash("sync-msg", "Syncing…", 0);
  try {
    const ok = await syncDown();
    flash("sync-msg", ok ? "Synced ✓" : "Connect a repo first.");
  } catch (e) {
    flash("sync-msg", `Sync failed: ${e.message}`, 0);
  }
  render();
});

$("save").addEventListener("click", async () => {
  const edits = { notifications: $("notifications").checked, nudge: $("nudge").checked };
  for (const k of TIME_KEYS) edits[k] = /^\d\d:\d\d$/.test($(k).value) ? $(k).value : SETTINGS_DEFAULTS[k];
  await updateDoc("settings", (cur) => ({ ...SETTINGS_DEFAULTS, ...cur, ...edits }));
  // The phone website has no background script to upload it.
  if (window.IS_WEB_APP) syncDown().catch(() => {});
  flash("saved", "Saved ✓");
  render();
});

$("test").addEventListener("click", () => browser.runtime.sendMessage({ type: "test-notification" }));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("doc:") || k.startsWith("sync:"))) render();
});
render();
if (window.IS_WEB_APP) syncDown().catch(() => {});
