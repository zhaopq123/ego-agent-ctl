const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attached = new Set();

async function pickTab(q) {
  q = q || {};
  const tabs = await chrome.tabs.query({});
  if (q.tabId) return tabs.find((t) => t.id === q.tabId) || null;
  if (q.urlIncludes) {
    const hits = tabs.filter((t) => (t.url || "").indexOf(q.urlIncludes) >= 0);
    hits.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return hits[0] || null;
  }
  const me = await chrome.tabs.getCurrent();
  const self = me ? me.id : null;
  const cands = tabs.filter((t) => t.id !== self && /^(https?|file|chrome-extension)/.test(t.url || ""));
  cands.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return cands[0] || null;
}

function sendOnce(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(resp);
    });
  });
}

async function send(tabId, msg) {
  try {
    return await sendOnce(tabId, msg);
  } catch (e) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (!/^(http|https|file):/.test(url)) {
      throw new Error("该页面不能注入内容脚本：" + url);
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return sendOnce(tabId, msg);
  }
}

async function call(cmd, args, q) {
  const tab = await pickTab(q);
  if (!tab) return { ok: false, error: "E_NO_TAB", message: "没有可用目标标签页" };
  const r = await send(tab.id, Object.assign({ cmd }, args || {}));
  return Object.assign({ tabId: tab.id, tabUrl: tab.url }, r);
}

async function waitFor(expect, q, timeout) {
  const limit = timeout || 5000;
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < limit) {
    n++;
    const r = await call("verify", { expect }, q);
    if (r && r.ok) return Object.assign({ waitedMs: Date.now() - start, polls: n }, r);
    await sleep(150);
  }
  return { ok: false, error: "E_TIMEOUT", message: "等待超时（" + limit + "ms）", polls: n };
}

async function run(steps, q) {
  const results = [];
  for (const step of steps || []) {
    const op = step.op;
    let r;
    if (op === "snapshot") r = await call("snapshot", { opts: step.opts }, q);
    else if (op === "click") r = await window.egoCtl.click(step.id, q);
    else if (op === "type") r = await call("type", { id: step.id, text: step.text, opts: step.opts }, q);
    else if (op === "scrollTo") r = await call("scrollTo", { id: step.id, opts: step.opts }, q);
    else if (op === "drag") r = await call("drag", { from: step.from, to: step.to, opts: step.opts }, q);
    else if (op === "verify") r = await call("verify", { expect: step.expect }, q);
    else if (op === "waitFor") r = await waitFor(step.expect, q, step.timeout);
    else r = { ok: false, error: "E_BAD_STEP", message: "未知步骤 " + op };
    results.push({ op, ok: r && r.ok, error: r && r.error, message: r && r.message });
    if (r && !r.ok && !step.optional) return { ok: false, stoppedAt: results.length - 1, results };
  }
  return { ok: results.every((r) => r.ok), results };
}

async function shot(q) {
  const tab = await pickTab(q);
  if (!tab) return { ok: false, error: "E_NO_TAB" };
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return { ok: true, tabId: tab.id, dataUrl, note: "截图仅作兜底/视觉核验；定位以 snapshot 的 id 为准" };
}

async function cdp(tabId, method, params) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function hoverPoint(tabId, x, y) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x, y: y, button: "none" });
}

async function probeHover(tabId) {
  const c = await send(tabId, { cmd: "hoverCandidates" });
  if (!c || !c.ok || !c.list || !c.list.length) return { list: [], err: (c && (c.message || c.error)) || null, cands: 0 };
  const st0 = await send(tabId, { cmd: "states" });
  let base = new Map(st0.list || []);
  const res = [];
  let err = null;
  for (const cand of c.list) {
    try {
      await hoverPoint(tabId, cand.x, cand.y);
    } catch (e) {
      err = String((e && e.message) || e);
      break;
    }
    await sleep(320);
    const now = new Map((await send(tabId, { cmd: "states" })).list || []);
    const shown = [];
    now.forEach((st, id) => { if (st === "visible" && base.get(id) !== "visible") shown.push(id); });
    if (shown.length) res.push({ trigger: cand.id, shows: shown.slice(0, 6) });
    base = now;
  }
  try { await hoverPoint(tabId, 1, 1); } catch (e) { /* ignore */ }
  return { list: res, err: err, cands: c.list.length };
}

async function hoverById(tabId, id) {
  const r = await send(tabId, { cmd: "rect", id });
  if (!r || !r.ok) return false;
  await hoverPoint(tabId, r.x, r.y);
  return true;
}

async function ensureErrorTap(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => {
        if (window.__EGO_ERRORS_TAP__) return true;
        window.__EGO_ERRORS_TAP__ = true;
        window.__EGO_ERRORS__ = [];
        window.addEventListener("error", (e) => {
          window.__EGO_ERRORS__.push({ type: "error", message: String(e.message || "error"), source: String(e.filename || ""), line: e.lineno || 0, ts: Date.now() });
          if (window.__EGO_ERRORS__.length > 20) window.__EGO_ERRORS__.shift();
        }, true);
        window.addEventListener("unhandledrejection", (e) => {
          const r = e && e.reason;
          window.__EGO_ERRORS__.push({ type: "rejection", message: String((r && r.message) || r || "unknown"), ts: Date.now() });
          if (window.__EGO_ERRORS__.length > 20) window.__EGO_ERRORS__.shift();
        });
        return true;
      }
    });
  } catch (e) { /* ignore */ }
}

async function readErrors(tabId) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => (window.__EGO_ERRORS__ || []).slice(-10)
    });
    return (out && out[0] && out[0].result) || [];
  } catch (e) { return []; }
}

window.egoCtl = {
  tabs: async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
  activate: async (tabId) => { await chrome.tabs.update(tabId, { active: true }); return { ok: true, tabId }; },
  snapshot: async (q) => {
    q = q || {};
    const tab = await pickTab(q);
    if (!tab) return { ok: false, error: "E_NO_TAB", message: "没有可用目标标签页" };
    let out = await send(tab.id, { cmd: "snapshot", opts: Object.assign({}, q, { probe: false }) });
    let hover = [];
    let err = null;
    if (q.probe) {
      const pr = await probeHover(tab.id);
      hover = pr.list || [];
      err = pr.err || null;
      if (hover.length) {
        await send(tab.id, { cmd: "setTriggers", list: hover });
        out = await send(tab.id, { cmd: "snapshot", opts: Object.assign({}, q, { probe: false, cache: false }) });
      }
      return Object.assign({ tabId: tab.id, tabUrl: tab.url, hover, probeDebug: { err, cands: pr.cands } }, out);
    }
    return Object.assign({ tabId: tab.id, tabUrl: tab.url, hover, probeDebug: { err } }, out);
  },
  click: async (id, q) => {
    const tab = await pickTab(q || {});
    if (!tab) return { ok: false, error: "E_NO_TAB", message: "没有可用目标标签页" };
    let r = await send(tab.id, { cmd: "click", id, opts: q || {} });
    if (!r.ok && r.error === "E_HIDDEN" && r.trigger) {
      await hoverById(tab.id, r.trigger);
      await sleep(250);
      r = await send(tab.id, { cmd: "click", id, opts: q || {} });
    }
    return Object.assign({ tabId: tab.id, tabUrl: tab.url }, r);
  },
  hover: async (id, q) => {
    const tab = await pickTab(q || {});
    if (!tab) return { ok: false, error: "E_NO_TAB" };
    const ok = await hoverById(tab.id, id);
    return { ok: ok, tabId: tab.id, hovered: id };
  },
  type: (id, text, q) => call("type", { id, text, opts: q }, q),
  press: (id, key, q) => call("press", { id, key, opts: q }, q),
  waitForIdle: (q) => call("idle", { opts: q }, q),
  scrollTo: (id, q) => call("scrollTo", { id, opts: q }, q),
  drag: (from, to, q) => call("drag", { from, to, opts: q }, q),
  verify: (expect, q) => call("verify", { expect }, q),
  diagnose: (id, q) => call("diagnose", { id }, q),
  pageErrors: async (q) => {
    const tab = await pickTab(q || {});
    if (!tab) return { ok: false, error: "E_NO_TAB" };
    await ensureErrorTap(tab.id);
    await sleep(120);
    return { ok: true, tabId: tab.id, errors: await readErrors(tab.id) };
  },
  trace: (q) => call("trace", {}, q),
  raw: (cmd, q) => call(cmd, {}, q),
  waitFor,
  run,
  shot
};
window.egoCtlReady = true;

document.querySelectorAll("[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const out = document.getElementById("out");
    try {
      const cmd = btn.dataset.cmd;
      const text = document.getElementById("text").value;
      let r;
      if (cmd === "snapshot") r = await window.egoCtl.snapshot({ probe: true });
      else if (cmd === "shot") r = await window.egoCtl.shot();
      else if (cmd === "tabs") r = await window.egoCtl.tabs();
      else if (cmd === "type") r = { ok: false, error: "E_UI_ONLY", message: "人手动时请用 egoCtl.type(id, text)" };
      else r = { ok: false, error: "E_UI_ONLY", message: "见 skill/SKILL.md 的调用方式" };
      out.textContent = typeof r === "string" ? r : JSON.stringify(r, null, 1).slice(0, 20000);
    } catch (e) {
      out.textContent = "ERR " + e;
    }
  });
});
