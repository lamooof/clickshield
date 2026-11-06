// Included inside the /tracker.js closure; no additional browser request needed.
function trackerTransport(url, uuid, onDecision) {
  const pending = [], encoder = new TextEncoder();
  let sending = null;
  const size = value => encoder.encode(value).length;
  const enqueue = (events, meta) => {
    let batch = null;
    for (const event of events) {
      if (!batch) batch = {...meta, batch_id: uuid(), events: []};
      batch.events.push(event);
      if (batch.events.length > 200 || (batch.events.length > 1 && size(JSON.stringify(batch)) > 48 * 1024)) {
        batch.events.pop(); pending.push(JSON.stringify(batch));
        batch = {...meta, batch_id: uuid(), events: [event]};
      }
    }
    if (batch) pending.push(JSON.stringify(batch));
  };
  const flush = (beacon = false) => {
    if (beacon) {
      let budget = 60000;
      for (const body of pending) {
        const bytes = size(body);
        if (bytes > budget || !navigator.sendBeacon?.(url, new Blob([body], {type:'text/plain;charset=UTF-8'}))) break;
        budget -= bytes;
      }
      return Promise.resolve(); // Retain batches: a beacon is queued, not acknowledged.
    }
    if (sending) return sending;
    sending = (async () => {
      while (pending.length) {
        const body = pending[0];
        try {
          const response = await fetch(url, {method:'POST', mode:'cors', credentials:'omit', headers:{'Content-Type':'text/plain;charset=UTF-8'}, body});
          if (!response.ok) return;
          const result = await response.json().catch(() => null);
          pending.shift();
          onDecision(result?.decision, JSON.parse(body).session_id);
        } catch (_) { return; } // Retry the exact bytes and batch ID.
      }
    })().finally(() => { sending = null; });
    return sending;
  };
  return {enqueue, flush};
}
