// 首次安装第 3 步：回读扩展状态，拿到 id
// 把本文件内容喂给 ego-browser nodejs
(async () => {
  const task = await taskSpace("ego-ctl-verify");
  const page = await task.page("p1");
  await page.goto("chrome://extensions");
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => new Promise((r) =>
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, r)));
  const mine = info.filter((e) => (e.path || "").indexOf("ego-agent-ctl") >= 0);
  console.log("EXT=" + JSON.stringify(mine.map((e) => ({
    id: e.id,
    state: e.state,
    manifestErrors: (e.manifestErrors || []).length,
    runtimeErrors: (e.runtimeErrors || []).length
  }))));
  if (mine[0]) console.log("PANEL=chrome-extension://" + mine[0].id + "/panel.html");
})();
