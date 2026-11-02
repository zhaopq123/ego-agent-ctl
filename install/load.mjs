(async () => {
  const task = await taskSpace("ego-ctl-install");
  const page = await task.page("p1");
  await page.goto("chrome://extensions");
  await page.waitForTimeout(2000);

  const probe = () => page.evaluate(() => {
    const m = document.querySelector("extensions-manager");
    if (!m || !m.shadowRoot) return { noManager: true };
    const t = m.shadowRoot.querySelector("extensions-toolbar");
    if (!t || !t.shadowRoot) return { noToolbar: true };
    const dev = t.shadowRoot.querySelector("#devMode");
    const b = t.shadowRoot.querySelector("#loadUnpacked");
    const rb = b ? b.getBoundingClientRect() : null;
    const rd = dev ? dev.getBoundingClientRect() : null;
    return {
      devPressed: dev ? dev.getAttribute("aria-pressed") || dev.checked || "" : null,
      devVisible: !!(rd && rd.width > 0),
      hasButton: !!b,
      btnW: rb ? Math.round(rb.width) : -1,
      btnH: rb ? Math.round(rb.height) : -1,
      x: rb ? Math.round(rb.left + rb.width / 2) : -1,
      y: rb ? Math.round(rb.top + rb.height / 2) : -1
    };
  });

  let s = await probe();
  console.log("STATE1=" + JSON.stringify(s));

  if (!s.hasButton || s.btnW <= 0) {
    await page.evaluate(() => {
      const m = document.querySelector("extensions-manager");
      const t = m && m.shadowRoot && m.shadowRoot.querySelector("extensions-toolbar");
      const dev = t && t.shadowRoot && t.shadowRoot.querySelector("#devMode");
      if (dev) dev.click();
      return !!dev;
    });
    await page.waitForTimeout(1200);
    s = await probe();
    console.log("STATE2=" + JSON.stringify(s));
  }

  if (s.btnW > 0) {
    await page.mouse.click(s.x, s.y);
    console.log("CLICKED " + s.x + "," + s.y);
  } else {
    console.log("BUTTON_NOT_LAID_OUT " + JSON.stringify(s));
  }
  await page.waitForTimeout(1000);
})();
