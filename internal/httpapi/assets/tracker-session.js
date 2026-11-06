function trackerStorage(name) {
  const memory = new Map();
  return {
    get(key) { try { return window[name].getItem(key) ?? memory.get(key) ?? null; } catch (_) { return memory.get(key) ?? null; } },
    set(key, value) { memory.set(key, value); try { window[name].setItem(key, value); } catch (_) {} }
  };
}

function trackerSession(storage, key, uuid, safeURL) {
  const storageKey = `clickshield:session:${key}`, timeout = 30 * 60 * 1000;
  let state;
  try { state = JSON.parse(storage.get(storageKey)); } catch (_) {}
  const fresh = () => ({id:uuid(), created:Date.now(), last:Date.now(), pageIndex:0, landing:safeURL(location.href), referrer:safeURL(document.referrer)});
  if (!state?.id || Date.now() - Number(state.last || 0) >= timeout) state = fresh();
  state.pageIndex = Number(state.pageIndex || 0) + 1;
  state.last = Date.now();
  const save = () => storage.set(storageKey, JSON.stringify(state));
  save();
  return {
    get state() { return state; },
    expired: () => Date.now() - state.last >= timeout,
    touch() { state.last = Date.now(); save(); },
    nextPage() { state.pageIndex++; save(); },
    restart() { state = fresh(); state.pageIndex = 1; save(); },
    save
  };
}
