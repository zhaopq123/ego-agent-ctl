// 首次安装第 1 步：在 ego 里打开扩展页并触发「加载已解压」
// 用法：echo. | ego-browser nodejs   （把本文件内容喂进去，见 SKILL.md）
(async () => {
  const task = await taskSpace("ego-ctl-install");
  const page = await task.page("p1");
  await page.goto("chrome://extensions");
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => new Promise((resolve) => {
    try {
      chrome.developerPrivate.loadUnpacked({ failQuietly: true }, (info) => {
        resolve({ done: true, id: info && info.id });
      });
      setTimeout(() => resolve({ done: false, note: "picker-open" }), 600);
    } catch (e) { resolve({ thrown: String(e) }); }
  }));
  console.log("LOAD=" + JSON.stringify(r));
})();
