// Shared state lives as JSON files in a private GitHub repo, so it follows you between the computer and the phone.
// storage.local keeps a cached copy of each file ("doc:<name>"), so everything works offline.
//
// - routine.json and settings.json are saved whole (last write wins); they rarely change.
// - checks.json is updated from a queue of check-offs ("sync:ops"), replayed on top of the latest copy
//   in the repo, so ticking steps on the phone and the computer around the same time never loses either.
//
// Pages only write to storage. Whoever called enablePushing() uploads: the background script in the
// extension, the page itself on the phone website.

const DATA_DIR = "data";

const DOCS = {
  routine: { path: `${DATA_DIR}/routine.json`, init: defaultRoutine },
  checks: { path: `${DATA_DIR}/checks.json`, init: () => ({ checks: {} }) },
  settings: { path: `${DATA_DIR}/settings.json`, init: () => ({ ...SETTINGS_DEFAULTS }) },
};

const DATA_REPO_README = `# Daily Dapper data

Synced state for the Daily Dapper Firefox extension and its phone website. They read and write these files;
edit them by hand only if you know what you're changing.

| File | Contents |
|---|---|
| \`routine.json\` | Products, which days and slots (AM / PM / after washing) they belong to, reorder links, hair-wash days |
| \`checks.json\` | What was checked off each day. \`_wash\` marks an extra hair-wash day; \`_done\` marks a complete day (the streak counts these) |
| \`settings.json\` | Reminder times |
`;

async function githubConfig() {
  const { githubToken, githubRepo } = await browser.storage.local.get(["githubToken", "githubRepo"]);
  return githubToken && githubRepo ? { token: githubToken, repo: githubRepo } : null;
}

async function getDoc(name) {
  const key = `doc:${name}`;
  const st = await browser.storage.local.get(key);
  if (st[key] != null) return st[key];
  const init = DOCS[name].init();
  await setLocalDoc(name, init); // so startDate doesn't move every time it's read
  return init;
}

const setLocalDoc = (name, data) => browser.storage.local.set({ [`doc:${name}`]: data });

async function getSettings() {
  return { ...SETTINGS_DEFAULTS, ...(await getDoc("settings")) };
}

async function setDirty(name, dirty) {
  const { "sync:dirty": list = [] } = await browser.storage.local.get("sync:dirty");
  const next = dirty ? [...new Set([...list, name])] : list.filter((n) => n !== name);
  await browser.storage.local.set({ "sync:dirty": next });
}

async function setSyncError(message) {
  await browser.storage.local.set({ "sync:error": message || null, ...(message ? {} : { "sync:last": Date.now() }) });
}

// ---------- Changes ----------

// Saves a whole doc (routine or settings). fn gets the current copy and returns the new one.
async function updateDoc(name, fn) {
  const next = fn(await getDoc(name));
  await setLocalDoc(name, next);
  if (await githubConfig()) await setDirty(name, true);
  return next;
}

// Ticks or unticks one step (key "<productId>:<slot>") or the extra wash-day flag (key "_wash").
async function setCheck(day, key, value) {
  const op = { id: uid(), day, key, value };
  const [checks, routine] = await Promise.all([getDoc("checks"), getDoc("routine")]);
  const next = applyCheckOp(checks, op, routine);
  const items = { "doc:checks": next };
  if (await githubConfig()) {
    const { "sync:ops": ops = [] } = await browser.storage.local.get("sync:ops");
    items["sync:ops"] = [...ops, op];
  }
  await browser.storage.local.set(items);
  return next;
}

// ---------- Sync ----------

function opsMessage(ops) {
  const days = [...new Set(ops.map((o) => o.day))].sort();
  const on = ops.filter((o) => o.value).length;
  return `Check off ${on}/${ops.length} step${ops.length === 1 ? "" : "s"} (${days.join(", ")})`;
}

// Uploads whole docs changed on this device, then replays queued check-offs on the repo's copy.
async function flushPending(cfg) {
  const st = await browser.storage.local.get(["sync:dirty", "sync:ops"]);
  for (const name of st["sync:dirty"] || []) {
    const local = await getDoc(name);
    await ghUpdateJson(cfg, DOCS[name].path, () => local, `Update ${name}`);
    await setDirty(name, false);
  }
  const ops = st["sync:ops"] || [];
  if (!ops.length) return;
  const routine = await getDoc("routine");
  const replay = (doc, list) => list.reduce((d, op) => applyCheckOp(d, op, routine), doc);
  const next = await ghUpdateJson(cfg, DOCS.checks.path, (remote) => replay(remote ?? DOCS.checks.init(), ops), opsMessage(ops));
  // Check-offs made while uploading stay queued, on top of the new copy.
  const sent = new Set(ops.map((o) => o.id));
  const { "sync:ops": now = [] } = await browser.storage.local.get("sync:ops");
  const rest = now.filter((o) => !sent.has(o.id));
  await browser.storage.local.set({ "doc:checks": replay(next, rest), "sync:ops": rest });
}

let syncing = null;

// Uploads local changes, then downloads the latest docs. Returns false if GitHub isn't set up.
function syncDown() {
  // One sync at a time; a call during a sync waits for it and then runs again.
  const run = async () => {
    const cfg = await githubConfig();
    if (!cfg) return false;
    try {
      await flushPending(cfg);
      const { "sync:dirty": dirty = [], "sync:ops": ops = [] } = await browser.storage.local.get(["sync:dirty", "sync:ops"]);
      await Promise.all(
        Object.keys(DOCS)
          .filter((n) => !dirty.includes(n))
          .map(async (n) => {
            const r = await ghReadJson(cfg, DOCS[n].path);
            if (!r) return;
            if (n === "checks" && ops.length) return; // queued check-offs go up first, next time
            await setLocalDoc(n, r.data);
          })
      );
      await setSyncError(null);
      return true;
    } catch (e) {
      await setSyncError(e.message);
      throw e;
    }
  };
  syncing = (syncing || Promise.resolve()).catch(() => {}).then(run);
  return syncing;
}

// Uploads local changes a few seconds after they're made (batched, so a run of check-offs is one commit).
function enablePushing(delayMs) {
  let timer = null;
  const push = () => {
    clearTimeout(timer);
    timer = null;
    syncDown().catch(() => {});
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const grew = (k) => (changes[k]?.newValue?.length || 0) > (changes[k]?.oldValue?.length || 0);
    if (grew("sync:ops") || grew("sync:dirty")) {
      clearTimeout(timer);
      timer = setTimeout(push, delayMs);
    }
  });
  return { pushNow: () => timer && push() };
}

// First connection on a device: adopt what's in the repo, or seed the repo from this device.
async function connectGitHub(cfg) {
  await ghCheckRepo(cfg);
  const { githubRepo: prevRepo } = await browser.storage.local.get("githubRepo");
  if (prevRepo && prevRepo.toLowerCase() === cfg.repo.toLowerCase()) {
    // Same repo, new token: upload what this device saved while sync was failing.
    await browser.storage.local.set({ githubToken: cfg.token, githubRepo: cfg.repo });
    await syncDown();
    return ["New token saved; changes made while sync was failing were uploaded"];
  }
  await browser.storage.local.set({ githubToken: cfg.token, githubRepo: cfg.repo, "sync:dirty": [], "sync:ops": [] });
  const report = [];
  for (const [name, doc] of Object.entries(DOCS)) {
    const remote = await ghReadJson(cfg, doc.path);
    if (remote) {
      await setLocalDoc(name, remote.data);
      report.push(`${doc.path}: downloaded`);
    } else {
      await ghWriteJson(cfg, doc.path, await getDoc(name), null, `Add ${doc.path}`);
      report.push(`${doc.path}: uploaded from this device`);
    }
  }
  const readmePath = `${DATA_DIR}/README.md`;
  const readme = await gh(cfg, "GET", `contents/${readmePath}`);
  if (!readme || base64ToUtf8(readme.content || "") !== DATA_REPO_README) {
    await ghWriteText(cfg, readmePath, DATA_REPO_README, readme?.sha, "Describe the data files");
  }
  await setSyncError(null);
  return report;
}

async function syncStatusText() {
  const cfg = await githubConfig();
  if (!cfg) return "Saved on this device only";
  const st = await browser.storage.local.get(["sync:error", "sync:last", "sync:ops", "sync:dirty"]);
  if (st["sync:error"]) return `Sync problem: ${st["sync:error"]}`;
  if ((st["sync:ops"] || []).length || (st["sync:dirty"] || []).length) return "Saving…";
  return st["sync:last"] ? `Synced ${new Date(st["sync:last"]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Sync set up";
}
