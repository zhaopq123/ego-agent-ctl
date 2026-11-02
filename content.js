(() => {
  if (window.__EGO_CTL__) return;
  window.__EGO_CTL__ = true;

  const S = { epoch: 0, seq: 0, cache: null };
  const map = new Map();
  const triggers = new Map(); // element id -> trigger id that reveals it
  const TRACE = [];

  const bump = (records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.attributeName === "data-ego-id") continue;
      S.epoch++;
      return;
    }
  };

  new MutationObserver(bump).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true
  });

  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const OBSERVED = new WeakSet();
  function watch(root) {
    if (!root || OBSERVED.has(root)) return;
    OBSERVED.add(root);
    try {
      new MutationObserver(bump).observe(root, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
    } catch (e) { /* ignore */ }
  }

  let rootsCache = { epoch: -1, list: null, opaque: [] };

  function roots() {
    if (rootsCache.epoch === S.epoch && rootsCache.list) return rootsCache.list;
    const out = [{ root: document, label: "main", dx: 0, dy: 0 }];
    const opaque = [];
    const visit = (root, label, dx, dy, depth) => {
      if (depth > 2) return;
      let nodes;
      try { nodes = root.querySelectorAll("*"); } catch (e) { return; }
      for (const el of nodes) {
        if (el.shadowRoot && el.tagName.indexOf("-") >= 0) {
          watch(el.shadowRoot);
          out.push({ root: el.shadowRoot, label: label + "/shadow:" + el.tagName.toLowerCase(), dx, dy });
          visit(el.shadowRoot, label + "/shadow:" + el.tagName.toLowerCase(), dx, dy, depth + 1);
        }
        if (el.tagName === "IFRAME") {
          try {
            const d = el.contentDocument;
            if (d) {
              watch(d);
              const r = el.getBoundingClientRect();
              out.push({ root: d, label: label + "/iframe:" + (el.name || el.id || "?"), dx: dx + r.left, dy: dy + r.top });
              visit(d, label + "/iframe:" + (el.name || el.id || "?"), dx + r.left, dy + r.top, depth + 1);
            }
          } catch (e) {
            const r2 = el.getBoundingClientRect();
            opaque.push({
              label: label + "/iframe:" + (el.name || el.id || "cross-origin"),
              rect: [Math.round(r2.left + dx), Math.round(r2.top + dy), Math.round(r2.width), Math.round(r2.height)],
              center: [Math.round(r2.left + dx + r2.width / 2), Math.round(r2.top + dy + r2.height / 2)],
              hint: "读不到内部 DOM；要操作请用 ego 真实鼠标点 center 坐标，或整块截图人工核对"
            });
          }
        }
      }
    };
    visit(document, "main", 0, 0, 0);
    rootsCache = { epoch: S.epoch, list: out, opaque: opaque };
    return out;
  }

  function idOf(el) {
    if (!el.__egoId) {
      el.__egoId = "e" + (++S.seq);
      map.set(el.__egoId, el);
    }
    return el.__egoId;
  }

  function roleOf(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button") return "button";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset"].indexOf(ty) >= 0) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      return "input";
    }
    if (t === "textarea") return "textarea";
    if (t === "select") return "select";
    if (el.isContentEditable) return "editable";
    return "element";
  }

  function nameOf(el) {
    const cand = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      norm(el.innerText) ? norm(el.innerText).slice(0, 80) : "",
      el.getAttribute("title"),
      el.getAttribute("alt"),
      el.tagName === "INPUT" && el.value ? norm(el.value).slice(0, 80) : ""
    ];
    for (const c of cand) if (c && norm(c)) return norm(c);
    return "";
  }

  function isEditable(el) {
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (el.tagName === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      return !el.disabled && !el.readOnly &&
        ["button", "submit", "reset", "checkbox", "radio", "file", "range", "color"].indexOf(ty) < 0;
    }
    return false;
  }

  function inView(r) {
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function obscuredBy(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    let top = null;
    try { top = document.elementFromPoint(x, y); } catch (e) { return null; }
    if (!top) return null;
    if (top === el || el.contains(top)) return null;
    const elRoot = el.getRootNode && el.getRootNode();
    if (elRoot && elRoot !== document && top.getRootNode && top.getRootNode() === elRoot) return null;
    const host = top.getRootNode && top.getRootNode().host;
    if (host && (host === el || el.contains(host))) return null;
    if (top.tagName === "IFRAME" || el.ownerDocument !== document) return null;
    if (elRoot && elRoot !== document && elRoot.host) return null;
    return top;
  }

  function visState(el) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return "disabled";
    if (st.display === "none") return "hidden:display";
    if (st.visibility === "hidden") return "hidden:visibility";
    if (Number(st.opacity) === 0) return "hidden:opacity";
    const aria = el.closest('[aria-hidden="true"]');
    if (aria) return "hidden:aria";
    if (r.width < 2 || r.height < 2) return "hidden:zero-size";
    if (!inView(r)) return "offscreen";
    if (obscuredBy(el)) return "obscured";
    return "visible";
  }

  const SEL = 'a,button,input,select,textarea,[role],[contenteditable="true"],[onclick],[tabindex],[aria-haspopup],[draggable="true"],[droppable],[data-dropzone]';

  function scanRoot(entry) {
    const out = [];
    let nodes;
    try { nodes = entry.root.querySelectorAll(SEL); } catch (e) { return out; }
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      const id = idOf(el);
      try { el.setAttribute("data-ego-id", id); } catch (e) { /* ignore */ }
      const name = nameOf(el);
      const rect = [
        Math.round(r.left + entry.dx), Math.round(r.top + entry.dy),
        Math.round(r.width), Math.round(r.height)
      ];
      out.push({
        id,
        root: entry.label,
        role: roleOf(el),
        name,
        tag: el.tagName.toLowerCase(),
        state: visState(el),
        rect,
        doc: [Math.round(r.left + scrollX), Math.round(r.top + scrollY)],
        enabled: !el.disabled,
        editable: isEditable(el),
        value: isEditable(el) ? norm(el.value != null ? el.value : el.innerText).slice(0, 40) : "",
        trigger: triggers.get(id) || null,
        danger: /删除|移除|清空|下架|delete|remove|clear/i.test(name),
        submit: /提交|发布|发送|保存|确定|搜索|submit|save|send|publish|search|ok/i.test(name)
      });
    }
    return out;
  }

  function scanPseudo(limit) {
    const out = [];
    let scanned = 0;
    for (const el of document.querySelectorAll("div,span,li,td")) {
      if (++scanned > 4000) break;
      if (el.__egoId) continue;
      const cs = getComputedStyle(el);
      if (cs.cursor !== "pointer") continue;
      if (el.querySelector("a,button,input,select,textarea,[role],[tabindex],[onclick]")) continue;
      const name = nameOf(el);
      if (!name || name.length > 60) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const id = idOf(el);
      try { el.setAttribute("data-ego-id", id); } catch (e) { /* ignore */ }
      out.push({
        id: id, root: "main", role: "pseudo-button", name: name, tag: el.tagName.toLowerCase(),
        state: visState(el),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        doc: [Math.round(r.left + scrollX), Math.round(r.top + scrollY)],
        enabled: true, editable: false, value: "",
        trigger: triggers.get(id) || null, heuristic: true,
        danger: /删除|移除|清空|下架|delete|remove|clear/i.test(name),
        submit: /提交|发布|发送|保存|确定|搜索|submit|save|send|publish|search|ok/i.test(name)
      });
      if (out.length >= (limit || 24)) break;
    }
    return out;
  }

  function scanAll() {
    const out = [];
    const seen = new Set();
    for (const entry of roots()) {
      for (const e of scanRoot(entry)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }
    for (const e of scanPseudo(24)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }

  const HOVER_HINT = /hover|dropdown|menu|popover|tooltip|more|actions|trigger/i;

  async function probeHover() {
    const found = [];
    const entries = roots().slice(0, 4);
    const cands = [];
    for (const entry of entries) {
      let nodes;
      try { nodes = entry.root.querySelectorAll("[aria-haspopup],*") } catch (e) { continue; }
      for (const el of nodes) {
        if (cands.length >= 6) break;
        const cls = (el.className && String(el.className)) || "";
        const st = getComputedStyle(el);
        if (!HOVER_HINT.test(cls) && el.getAttribute("aria-haspopup") == null) continue;
        if (st.display === "none" || st.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        cands.push({ el, entry });
      }
    }
    S.lastCands = cands.map((c) => nameOf(c.el).slice(0, 30) || c.el.id || c.el.tagName);
    for (const c of cands) {
      const before = new Map(scanRoot(c.entry).map((e) => [e.id, e.state]));
      const r = c.el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
      try { c.el.dispatchEvent(new PointerEvent("pointerover", opts)); } catch (e) { /* ignore */ }
      try { c.el.dispatchEvent(new MouseEvent("mouseover", opts)); } catch (e) { /* ignore */ }
      try { c.el.dispatchEvent(new MouseEvent("mouseenter", opts)); } catch (e) { /* ignore */ }
      await sleep(180);
      const after = scanRoot(c.entry);
      const btn = c.entry.root.getElementById ? c.entry.root.getElementById("revealed") : null;
      S.lastDbg = {
        tag: c.el.tagName, id: c.el.id, cls: String(c.el.className),
        btnDisplay: btn ? getComputedStyle(btn).display : "n/a"
      };
      S.lastDiff = after.filter((e) => before.get(e.id) !== e.state)
        .map((e) => [e.id, String(e.name).slice(0, 20), before.get(e.id), e.state]);
      const fresh = after.filter((e) => e.state === "visible" && (!before.has(e.id) || before.get(e.id) !== e.state));
      if (fresh.length) {
        const tid = idOf(c.el);
        fresh.forEach((e) => triggers.set(e.id, tid));
        found.push({ trigger: tid, triggerName: nameOf(c.el).slice(0, 40), shows: fresh.slice(0, 6).map((e) => e.id) });
      }
      try { c.el.dispatchEvent(new MouseEvent("mouseout", opts)); } catch (e) { /* ignore */ }
      try { c.el.dispatchEvent(new MouseEvent("mouseleave", opts)); } catch (e) { /* ignore */ }
      await sleep(80);
    }
    return found;
  }

  function mdTable(list) {
    const head = "| id | role | name | state | edit | viewport x,y,w,h | doc x,y | trigger |";
    const sep = "|---|---|---|---|---|---|---|---|";
    const rows = list.map((e) => "| " + [
      e.id, e.role, String(e.name).replace(/\|/g, "\\|"), e.state,
      e.editable ? "Y" : "-", e.rect.join(","), e.doc.join(","), e.trigger || ""
    ].join(" | ") + " |");
    return [head, sep].concat(rows).join("\n");
  }

  function nextActions(els) {
    const out = [];
    const trig = els.find((e) => e.trigger && e.state !== "visible");
    if (trig) out.push("先 hover " + trig.trigger + " 再 click " + trig.id);
    const ok = els.filter((e) => e.state === "visible");
    const input = ok.find((e) => e.editable);
    if (input) out.push("type " + input.id + " \"文本\" —— 填入「" + input.name + "」并回读");
    const btn = ok.find((e) => e.role === "button" && e.submit);
    if (btn) out.push("click " + btn.id + " —— 点击「" + btn.name + "」后再 snapshot 校验");
    const link = ok.find((e) => e.role === "link");
    if (link) out.push("click " + link.id + " —— 打开「" + link.name + "」");
    const hidden = els.filter((e) => e.state.indexOf("hidden") === 0 && e.trigger).slice(0, 2);
    hidden.forEach((e) => out.push("先 hover " + e.trigger + " 再 click " + e.id));
    const off = els.find((e) => e.state === "offscreen");
    if (off) out.push("scrollTo " + off.id + " —— 元素在视口外，滚到它再点");
    if (!out.length) out.push("snapshot —— 没有可操作元素，确认页面是否加载完成");
    return out.slice(0, 5);
  }

  async function snapshot(opts) {
    opts = opts || {};
    const key = [location.href, S.epoch, Math.round(scrollY), innerWidth, innerHeight].join("|");
    if (opts.cache !== false && !opts.probe && S.cache && S.cache.key === key) {
      return Object.assign({}, S.cache.data, { cacheHit: true });
    }
    let hover = [];
    if (opts.probe) hover = await probeHover();
    const els = scanAll();
    const groups = {
      visible: els.filter((e) => e.state === "visible"),
      obscured: els.filter((e) => e.state === "obscured"),
      offscreen: els.filter((e) => e.state === "offscreen"),
      hidden: els.filter((e) => e.state.indexOf("hidden") === 0),
      disabled: els.filter((e) => e.state === "disabled")
    };
    const caps = { visible: 40, obscured: 15, offscreen: 20, hidden: 20, disabled: 10 };
    let shown = 0;
    for (const k of Object.keys(caps)) shown += Math.min(groups[k].length, caps[k]);
    const truncated = els.length > shown;
    const regions = rootsCache.opaque || [];
    const parts = [
      "# " + document.title,
      "",
      "url: " + location.href,
      "viewport: " + innerWidth + "x" + innerHeight + "  scroll: " + Math.round(scrollX) + "," + Math.round(scrollY) + "  dpr: " + (window.devicePixelRatio || 1),
      "epoch: " + S.epoch + "  elements: " + els.length + "  shown: " + shown + "  truncated: " + (truncated ? "yes" : "no") + "  cache: miss",
      ""
    ];
    if (groups.visible.length) parts.push("## 可见（可直接点）", mdTable(groups.visible.slice(0, caps.visible)), "");
    if (groups.obscured.length) parts.push("## 被遮挡（先关浮层或滚动）", mdTable(groups.obscured.slice(0, caps.obscured)), "");
    if (groups.offscreen.length) parts.push("## 屏外（先 scrollTo id）", mdTable(groups.offscreen.slice(0, caps.offscreen)), "");
    if (groups.hidden.length) parts.push("## 隐藏（需 hover 触发）", mdTable(groups.hidden.slice(0, caps.hidden)), "");
    if (groups.disabled.length) parts.push("## 禁用", mdTable(groups.disabled.slice(0, caps.disabled)), "");
    if (regions.length) {
      parts.push("## 跨域 iframe（读不到内部，只能截图兜底）",
        regions.map((r) => "- " + r.label + " rect=" + r.rect.join(",") + " center=" + r.center.join(",")).join("\n"), "");
    }
    if (hover.length) {
      parts.push("## 悬停探测", hover.map((h) => "- hover " + h.trigger + "（" + h.triggerName + "）→ " + h.shows.join(", ")).join("\n"), "");
    }
    parts.push("next: " + nextActions(els).join(" / "));
    const data = {
      ok: true, url: location.href, title: document.title, epoch: S.epoch,
      viewport: [innerWidth, innerHeight], scroll: [Math.round(scrollX), Math.round(scrollY)],
      elements: els, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((e) => e.id)])),
      hover, next: nextActions(els), regions, truncated, markdown: parts.join("\n"), cacheHit: false
    };
    if (!opts.probe) S.cache = { key, data };
    return data;
  }

  function findEl(id) {
    if (!map.has(id)) return { error: "E_UNKNOWN_ID", message: "没有这个 id（" + id + "），先 snapshot" };
    const el = map.get(id);
    if (!el.isConnected) return { error: "E_STALE", message: "元素已脱离 DOM（" + id + "），先 snapshot" };
    return { el };
  }

  function resolveRef(ref) {
    if (typeof ref === "string" && ref.indexOf("css:") === 0) {
      const el = document.querySelector(ref.slice(4));
      if (!el) return { error: "E_NOT_FOUND", message: "选择器没匹配到：" + ref };
      return { el, id: idOf(el) };
    }
    if (ref && typeof ref === "object" && ref.x != null && ref.y != null) {
      const el = document.elementFromPoint(Number(ref.x), Number(ref.y));
      if (!el) return { error: "E_NOT_FOUND", message: "坐标处没有元素" };
      return { el, id: idOf(el), point: [Number(ref.x), Number(ref.y)] };
    }
    return findEl(ref);
  }

  async function locateFor(ref) {
    const f = resolveRef(ref);
    if (f.error) return f;
    const st = visState(f.el);
    if (st === "offscreen") {
      f.el.scrollIntoView({ block: "center", inline: "center" });
      await sleep(250);
    } else if (st.indexOf("hidden") === 0) {
      return { error: "E_HIDDEN", message: "元素处于 " + st + "，拖拽需要它可见" };
    } else if (st === "disabled") {
      return { error: "E_DISABLED", message: "元素被禁用" };
    }
    return f;
  }

  async function prepare(id) {
    const f = findEl(id);
    if (f.error) return f;
    const st = visState(f.el);
    if (st === "offscreen") {
      f.el.scrollIntoView({ block: "center", inline: "center" });
      await sleep(250);
    } else if (st.indexOf("hidden") === 0) {
      const tid = triggers.get(id);
      if (!tid) return { error: "E_HIDDEN", message: "元素处于 " + st + " 且没有已知触发源", trigger: null };
      const tf = findEl(tid);
      if (tf.error) return tf;
      const r = tf.el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const o = { bubbles: true, composed: true, clientX: x, clientY: y };
      try { tf.el.dispatchEvent(new PointerEvent("pointerover", o)); } catch (e) { /* ignore */ }
      try { tf.el.dispatchEvent(new MouseEvent("mouseover", o)); } catch (e) { /* ignore */ }
      await sleep(250);
    } else if (st === "obscured") {
      const blocker = obscuredBy(f.el);
      return { error: "E_OBSCURED", message: "目标被遮挡", blocker: blocker ? nameOf(blocker).slice(0, 40) : "" };
    } else if (st === "disabled") {
      return { error: "E_DISABLED", message: "元素被禁用" };
    }
    return f;
  }

  function hitTest(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const root = el.getRootNode && el.getRootNode();
    if (root && root !== document) return { x, y, hit: true, note: "shadow/iframe 根内元素，跳过点命中校验" };
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!(top && (top === el || el.contains(top) || (top.getRootNode && top.getRootNode().host === el))), top };
  }

  function fire(el, x, y) {
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const seq = [
      [PointerEvent, "pointerover"], [MouseEvent, "mouseover"], [PointerEvent, "pointerdown"],
      [MouseEvent, "mousedown"], [PointerEvent, "pointerup"], [MouseEvent, "mouseup"]
    ];
    for (const p of seq) { try { el.dispatchEvent(new p[0](p[1], base)); } catch (e) { /* ignore */ } }
  }

  function changeSig() {
    const parts = [location.href, document.title, S.epoch];
    for (const r of roots()) {
      try {
        const d = r.root;
        if (d && d.nodeType === 9) {
          parts.push(d.title || "");
          parts.push(norm(d.body ? d.body.innerText : "").slice(0, 300));
        } else if (d && d.nodeType === 11) {
          parts.push(norm(d.textContent || "").slice(0, 300));
        }
      } catch (e) { /* ignore */ }
    }
    return parts.join("|");
  }

  async function click(id, opts) {
    opts = opts || {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      const p = await prepare(id);
      if (p.error) return { ok: false, attempt, error: p.error, message: p.message, blocker: p.blocker };
      const el = p.el;
      const before = { url: location.href, sig: changeSig() };
      const h = hitTest(el);
      if (!h.hit && attempt < 3) {
        await sleep(200);
        if (attempt === 2) el.scrollIntoView({ block: "center" });
        continue;
      }
      fire(el, h.x, h.y);
      try { if (typeof el.click === "function") el.click(); } catch (e) { /* ignore */ }
      const deadline = Date.now() + (opts.timeout || 3000);
      while (Date.now() < deadline) {
        if (changeSig() !== before.sig) break;
        await sleep(100);
      }
      const after = { url: location.href, sig: changeSig() };
      const changed = after.sig !== before.sig;
      return {
        ok: changed, attempt, id, matched: nameOf(el).slice(0, 60), point: [h.x, h.y], hit: h.hit,
        trustedHint: [h.x, h.y],
        before, after, checks: [{ name: "url_or_dom_changed", pass: changed }],
        error: changed ? undefined : "E_NO_EFFECT",
        message: changed ? undefined : "点击后 URL 与 DOM 均无变化；若站点校验 isTrusted，请改用 ego 真实鼠标点击 trustedHint 坐标"
      };
    }
    return { ok: false, error: "E_HIT_MISS", message: "坐标三次都没命中目标元素" };
  }

  async function type(id, text, opts) {
    opts = opts || {};
    const p = await prepare(id);
    if (p.error) return { ok: false, error: p.error, message: p.message };
    const el = p.el;
    if (!isEditable(el)) return { ok: false, error: "E_NOT_EDITABLE", message: "该元素不可输入" };
    const value = text == null ? "" : String(text);
    el.focus();
    if (el.isContentEditable) { el.innerText = ""; document.execCommand("insertText", false, value); }
    else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(120);
    const now = el.isContentEditable ? el.innerText : el.value;
    const pass = norm(now) === norm(value);
    return { ok: pass, id, value: now, expected: value, checks: [{ name: "value_equals", pass }],
      error: pass ? undefined : "E_READBACK", message: pass ? undefined : "回读值与期望不一致" };
  }

  async function scrollTo(id, opts) {
    const f = findEl(id);
    if (f.error) return { ok: false, error: f.error, message: f.message };
    f.el.scrollIntoView({ block: (opts && opts.block) || "center", behavior: "auto" });
    const deadline = Date.now() + (opts && opts.timeout ? opts.timeout : 3000);
    let r = f.el.getBoundingClientRect();
    while (Date.now() < deadline && !inView(r)) {
      await sleep(100);
      r = f.el.getBoundingClientRect();
    }
    return { ok: inView(r), id, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      checks: [{ name: "in_view", pass: inView(r) }] };
  }

  function signature(el) {
    return { text: norm(el.innerText).slice(0, 150), count: el.children.length,
      children: Array.from(el.children).map((c) => norm(c.innerText || c.getAttribute("aria-label") || c.tagName)).slice(0, 20) };
  }

  function dragEv(type, x, y, dt) {
    try { return new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }); }
    catch (e) { const ev = new Event(type, { bubbles: true, cancelable: true }); ev.dataTransfer = dt; return ev; }
  }

  async function drag(from, to, opts) {
    opts = opts || {};
    const a = await locateFor(from);
    if (a.error) return { ok: false, error: a.error, message: "源：" + a.message };
    const b = await locateFor(to);
    if (b.error) return { ok: false, error: b.error, message: "目标：" + b.message };
    const src = a.el, dst = b.el;
    const sigBefore = signature(dst);
    const ra = src.getBoundingClientRect(), rb = dst.getBoundingClientRect();
    const p0 = [Math.round(ra.left + ra.width / 2), Math.round(ra.top + ra.height / 2)];
    const p1 = [Math.round(rb.left + rb.width / 2), Math.round(rb.top + rb.height / 2)];
    const steps = Math.max(4, Number(opts.steps || 12));
    const dt = new DataTransfer();
    src.dispatchEvent(dragEv("dragstart", p0[0], p0[1], dt));
    for (let i = 1; i <= steps; i++) {
      dst.dispatchEvent(dragEv("dragover", Math.round(p0[0] + (p1[0] - p0[0]) * i / steps), Math.round(p0[1] + (p1[1] - p0[1]) * i / steps), dt));
      await sleep(30);
    }
    dst.dispatchEvent(dragEv("drop", p1[0], p1[1], dt));
    src.dispatchEvent(dragEv("dragend", p1[0], p1[1], dt));
    await sleep(opts.settle || 400);
    if (JSON.stringify(sigBefore) === JSON.stringify(signature(dst))) {
      await prepare(from);
      const down = { bubbles: true, composed: true, clientX: p0[0], clientY: p0[1], button: 0 };
      try { src.dispatchEvent(new PointerEvent("pointerdown", down)); } catch (e) { /* ignore */ }
      for (let i = 1; i <= steps; i++) {
        try { document.elementFromPoint(Math.round(p0[0] + (p1[0]-p0[0])*i/steps), Math.round(p0[1] + (p1[1]-p0[1])*i/steps))?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: p0[0] + (p1[0]-p0[0])*i/steps, clientY: p0[1] + (p1[1]-p0[1])*i/steps })); } catch (e) { /* ignore */ }
        await sleep(25);
      }
      try { document.elementFromPoint(p1[0], p1[1])?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: p1[0], clientY: p1[1] })); } catch (e) { /* ignore */ }
      await sleep(300);
    }
    const sigAfter = signature(dst);
    const delta = [p1[0] - p0[0], p1[1] - p0[1]];
    const checks = [
      { name: "moved_distance", pass: Math.abs(delta[0]) > 2 || Math.abs(delta[1]) > 2, detail: delta },
      { name: "target_changed", pass: JSON.stringify(sigBefore) !== JSON.stringify(sigAfter), detail: { before: sigBefore.text, after: sigAfter.text } }
    ];
    const ok = checks.every((c) => c.pass);
    return { ok, from, to, points: { from: p0, to: p1 }, delta, checks, before: sigBefore, after: sigAfter,
      error: ok ? undefined : "E_DRAG_UNVERIFIED", message: ok ? undefined : "拖拽后目标容器未变化" };
  }

  async function verify(expect) {
    expect = expect || {};
    const checks = [];
    if (expect.urlIncludes != null) checks.push({ name: "url_includes", pass: location.href.indexOf(expect.urlIncludes) >= 0, detail: location.href });
    if (expect.valueEquals != null && expect.id) {
      const f = findEl(expect.id);
      const v = f.error ? null : (f.el.isContentEditable ? f.el.innerText : f.el.value);
      checks.push({ name: "value_equals", pass: norm(v) === norm(expect.valueEquals), detail: v });
    }
    if (expect.exists != null && expect.id) checks.push({ name: "exists", pass: !findEl(expect.id).error });
    if (expect.textIncludes != null) checks.push({ name: "text_includes", pass: norm(document.body.innerText).indexOf(expect.textIncludes) >= 0 });
    const ok = checks.length > 0 && checks.every((c) => c.pass);
    return { ok, checks, error: ok ? undefined : "E_VERIFY", message: ok ? undefined : "断言未通过" };
  }

  function diagnose(id) {
    const f = findEl(id);
    if (f.error) {
      return Object.assign({}, f, {
        suggestions: ["重新 snapshot 拿新 id（元素可能已被移除或页面已跳转）"],
        trace: TRACE.slice(-5)
      });
    }
    const el = f.el;
    const st = visState(el);
    const r = el.getBoundingClientRect();
    const blocker = obscuredBy(el);
    const ancestors = [];
    let p = el.parentElement;
    for (let i = 0; p && i < 5; i++) {
      ancestors.push(p.tagName.toLowerCase() + (p.id ? "#" + p.id : "") +
        (p.className ? "." + String(p.className).split(" ").slice(0, 2).join(".") : ""));
      p = p.parentElement;
    }
    const suggestions = [];
    if (st === "offscreen") {
      suggestions.push("egoCtl.scrollTo(\"" + id + "\") 后再 click");
    } else if (st.indexOf("hidden") === 0) {
      const t = triggers.get(id);
      suggestions.push(t
        ? "先用 ego 真实鼠标悬停 " + t + "（target.mouse.move 到它的 rect 中心），再 click " + id
        : "先跑 egoCtl.hoverCandidates() + target.mouse.move 找触发源，再 click " + id);
    } else if (st === "obscured") {
      const bname = blocker ? (nameOf(blocker).slice(0, 30) || (blocker.id ? "#" + blocker.id : blocker.tagName.toLowerCase())) : "?";
      suggestions.push("先关掉遮挡元素「" + bname + "」再点；或改用真实鼠标点目标中心");
    } else if (st === "disabled") {
      suggestions.push("元素当前禁用：等状态变化（egoCtl.waitForIdle）或换入口");
    } else {
      suggestions.push("可直接 click " + id + "；若无变化，用返回的 trustedHint 坐标走 target.mouse.click");
    }
    return {
      ok: true, id: id, state: st, role: roleOf(el), name: nameOf(el).slice(0, 60),
      editable: isEditable(el), enabled: !el.disabled,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      inShadow: !!(el.getRootNode() !== document),
      blocker: blocker ? { id: idOf(blocker), name: nameOf(blocker).slice(0, 40), tag: blocker.tagName.toLowerCase() } : null,
      ancestors: ancestors, suggestions: suggestions,
      trace: TRACE.slice(-5)
    };
  }

  const H = {
    ping: () => ({ ok: true, url: location.href, epoch: S.epoch }),
    snapshot: (m) => snapshot(m.opts),
    probe: async () => {
      try { return { ok: true, found: await probeHover(), cands: S.lastCands || [], diff: S.lastDiff || [], dbg: S.lastDbg || {} }; }
      catch (e) { return { ok: false, error: "E_PROBE", message: String((e && e.stack) || e).slice(0, 300), cands: S.lastCands || [] }; }
    },
    setTriggers: (m) => {
      let n = 0;
      (m.list || []).forEach((t) => {
        (t.shows || []).forEach((sid) => { triggers.set(sid, t.trigger); n++; });
      });
      return { ok: true, linked: n };
    },
    hoverCandidates: () => {
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        const cls = String(el.className == null ? "" : el.className);
        if (!HOVER_HINT.test(cls) && el.getAttribute("aria-haspopup") == null) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const id = idOf(el);
        try { el.setAttribute("data-ego-id", id); } catch (e) { /* ignore */ }
        out.push({ id, name: nameOf(el).slice(0, 40), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        if (out.length >= 6) break;
      }
      return { ok: true, list: out };
    },
    states: () => ({ ok: true, list: scanAll().map((e) => [e.id, e.state]) }),
    rect: (m) => {
      const f = findEl(m.id);
      if (f.error) return { ok: false, error: f.error, message: f.message };
      const r = f.el.getBoundingClientRect();
      return { ok: true, id: m.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    click: (m) => click(m.id, m.opts),
    press: async (m) => {
      const el = m.id ? (findEl(m.id).el || null) : document.activeElement;
      if (!el) return { ok: false, error: "E_NOT_FOUND", message: "找不到按键目标" };
      const key = m.key || "Enter";
      const code = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : 0;
      const before = changeSig();
      if (key === "Enter") {
        const form = el.form || (el.closest && el.closest("form"));
        if (form && typeof form.requestSubmit === "function") {
          try { form.requestSubmit(); } catch (e) { /* ignore */ }
        }
      }
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true
        }));
      }
      const deadline = Date.now() + (m.opts && m.opts.timeout ? m.opts.timeout : 2000);
      while (Date.now() < deadline && changeSig() === before) await sleep(100);
      const changed = changeSig() !== before;
      const rect = el.getBoundingClientRect();
      return { ok: changed, id: m.id || "active", key: key,
        point: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)],
        checks: [{ name: "url_or_dom_changed", pass: changed }],
        error: changed ? undefined : "E_NO_EFFECT",
        message: changed ? undefined : "按键后无变化；若站点要求可信键盘，用 ego 的 keyboard.press" };
    },
    type: (m) => type(m.id, m.text, m.opts),
    idle: async (m) => {
      const opts = m.opts || {};
      const quiet = Number(opts.quiet || 500);
      const limit = Number(opts.timeout || 5000);
      const start = Date.now();
      let sig = changeSig();
      let last = Date.now();
      while (Date.now() - start < limit) {
        await sleep(120);
        const now = changeSig();
        if (now !== sig) { sig = now; last = Date.now(); continue; }
        if (Date.now() - last >= quiet) {
          return { ok: true, waitedMs: Date.now() - start, quietMs: quiet, checks: [{ name: "dom_stable", pass: true }] };
        }
      }
      return { ok: false, error: "E_TIMEOUT", message: "页面在 " + limit + "ms 内没稳定", waitedMs: Date.now() - start };
    },
    scrollTo: (m) => scrollTo(m.id, m.opts),
    drag: (m) => drag(m.from, m.to, m.opts),
    verify: (m) => verify(m.expect),
    diagnose: (m) => diagnose(m.id),
    trace: () => ({ ok: true, trace: TRACE.slice(-20) })
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const fn = msg && H[msg.cmd];
    if (!fn) { reply({ ok: false, error: "E_UNKNOWN_CMD", message: "未知命令 " + (msg && msg.cmd) }); return false; }
    Promise.resolve()
      .then(() => fn(msg))
      .then((r) => {
        TRACE.push({ cmd: msg.cmd, ref: msg.id || msg.from || "", ok: !!(r && r.ok), error: (r && r.error) || null, ts: Date.now() });
        if (TRACE.length > 20) TRACE.shift();
        reply(r);
      })
      .catch((e) => reply({ ok: false, error: "E_EXCEPTION", message: String((e && e.message) || e) }));
    return true;
  });
})();
