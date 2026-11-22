// Lets the extension's pages run as an ordinary website (the phone version on GitHub Pages).
// Replaces the few Firefox extension APIs they use with web equivalents. Loaded before shared.js.

window.IS_WEB_APP = true;

(() => {
  const PREFIX = "dd:";
  const listeners = [];
  const read = (key) => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const keysOf = (keys) => {
    if (keys == null) return Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
    return typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  };
  const emit = (changes) => {
    if (Object.keys(changes).length) for (const fn of listeners) fn(changes, "local");
  };

  window.browser = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keysOf(keys)) {
            const v = read(k);
            if (v !== undefined) out[k] = v;
          }
          return out;
        },
        async set(items) {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: read(k), newValue: v };
            localStorage.setItem(PREFIX + k, JSON.stringify(v));
          }
          emit(changes);
        },
        async remove(keys) {
          const changes = {};
          for (const k of keysOf(keys)) {
            changes[k] = { oldValue: read(k) };
            localStorage.removeItem(PREFIX + k);
          }
          emit(changes);
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      openOptionsPage() {
        location.href = "options.html";
      },
    },
    tabs: {
      async create({ url }) {
        window.open(url, "_blank", "noopener");
      },
    },
  };

  document.documentElement.classList.add("web-app");
})();
