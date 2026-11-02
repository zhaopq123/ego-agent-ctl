# ego agent ctl

给 Agent 用的 ego lite 控制层：**眼睛**（一次调用拿到结构化页面状态）+ **手**（按 id 执行动作并强制回读校验）。

设计前提：**Agent 只看 Markdown 决策，不看图猜坐标**。截图只作兜底与事后视觉核验。

## 装法

1. ego lite 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选本目录
3. 扩展 id 记下来，面板地址是 `chrome-extension://<id>/panel.html`

## 为什么要有这个面板页

扩展页有 `chrome.tabs` / `chrome.scripting` 权限，普通网页没有。Agent 把面板页当一个「控制台」打开，在里面调用 `window.egoCtl.*`，由它转给目标页的 content script。

## Agent 调用方式（ego-browser CLI）

```js
const ID = "<扩展 id>";
const t = await taskSpace("任务名");
const target = await t.page("p1");
const ctl = await t.newPage();
await target.goto("https://example.com");
await ctl.goto("chrome-extension://" + ID + "/panel.html");

const snap = await ctl.evaluate(() => egoCtl.snapshot({ probe: true, urlIncludes: "example.com" }));
console.log(snap.markdown);          // 直接读这份表做决策
const btn = snap.elements.find(e => e.name.includes("提交"));
await ctl.evaluate((id) => egoCtl.click(id, { urlIncludes: "example.com" }), btn.id);
```

## API

| 方法 | 作用 | 关键返回 |
|---|---|---|
| `snapshot(q)` | 一次拿全页面结构化状态，输出 Markdown 表 | `markdown` / `elements[]` / `groups` / `next` |
| `click(id, q)` | 按 id 点击，坐标仅用于命中校验；失败自动滚动/重定位，最多 3 次 | `ok` / `hit` / `before` / `after` / `checks` |
| `type(id, text, q)` | 写入输入框并回读 | `ok` / `value` / `checks` |
| `scrollTo(id, q)` | 滚到元素并断言进入视口 | `ok` / `rect` |
| `drag(fromId, toId, q)` | 拖拽，分步移动；目标可传 id、`css:#dst` 或 `{x,y}` | `ok` / `delta` / `before` / `after` / `checks` |
| `press(id, key, q)` | 发按键并校验页面有无变化；Enter 在表单内会自动 `requestSubmit()` | `ok` / `point` / `checks` |
| `waitForIdle(q)` | 等 DOM 稳定一段时间，不靠固定秒数 | `ok` / `waitedMs` |
| `waitFor(expect, q, ms)` | 轮询断言，不靠死等 | `ok` / `polls` |
| `diagnose(id, q)` | 失败原因诊断：状态、遮挡者、祖先链、下一步建议、最近轨迹 | `state` / `blocker` / `suggestions` / `trace` |
| `pageErrors(q)` | 页面 JS 报错（error + promise rejection，主世界捕获） | `errors[]` |
| `trace(q)` | 最近 20 条动作记录 | `trace[]` |
| `run(steps[], q)` | 连续动作链，失败即停 | `ok` / `results` |
| `hoverCandidates(q)` | 列出疑似悬停触发容器（带坐标） | `list[]` |
| `tabs()` / `activate(id)` | 标签页列表 / 切换 | — |
| `shot(q)` | 可视区截图（兜底） | `dataUrl` |

## 元素表字段（固定，Agent 按这个决策）

`id | role | name | state | edit | viewport x,y,w,h | doc x,y | trigger`

- `state`：`visible` / `obscured` / `offscreen` / `hidden:display` / `hidden:visibility` / `hidden:opacity` / `hidden:aria` / `hidden:zero-size` / `disabled`
- `role`：常见角色 + `pseudo-button`（`div/span` 靠 `cursor:pointer` 认出来的假按钮）
- 表尾 `truncated: yes` 表示还有元素没列出来；`regions` 列跨域 iframe 区域（带 `center` 坐标，可用 ego 真实鼠标点）
- 点击失败且返回 `E_NO_EFFECT` 时带 `trustedHint:[x,y]`，可用 ego 真实鼠标按该坐标重试
- 表单内 `press(id,"Enter")` 会自动调用 `form.requestSubmit()`，不需要可信键盘
- `trigger`：该元素是「悬停谁之后才出现」的，值就是触发元素的 id
- 覆盖：主文档、同源 iframe、open shadow DOM；隐藏元素也扫，不只扫可见的

## 错误码

`E_NOT_FOUND` / `E_STALE`（元素已脱离 DOM，需重新 snapshot）/ `E_HIDDEN` / `E_OBSCURED`（带 blocker 文本）/ `E_DISABLED` / `E_NOT_EDITABLE` / `E_NO_EFFECT`（动作后 URL 与 DOM 都没变）/ `E_DRAG_UNVERIFIED` / `E_READBACK` / `E_NO_TAB` / `E_TIMEOUT`

**没有任何「以为成功」的静默路径**：没观察到变化就返回失败。

## 已知边界（实测过，不是猜的）

1. **CSS `:hover` 菜单**：扩展世界合成的事件不会触发页面 `:hover`，也不触发页面 JS 的 `mouseenter` 监听。所以这类元素必须由 ego 提供的真实鼠标去悬停：
   ```js
   const c = await ctl.evaluate(() => egoCtl.hoverCandidates({ urlIncludes: "example.com" }));
   await target.mouse.move(c.list[0].x, c.list[0].y);   // ego 的真实输入
   // 再 snapshot，元素变 visible；随后 egoCtl.click 即可
   ```
   实测：真实鼠标悬停 → 元素 `visible` → `click` 成功。
2. **chrome.debugger 被 ego 占用**：ego 自身对受控标签页挂了调试器，扩展再 attach 会报 `Another debugger is already attached`。所以本插件不走 CDP 输入。
3. **跨域 iframe** 读不到内部 DOM，只能给区域标记，回退截图。
4. **chrome:// 页面**不能注入，需另开普通页。

## 实测结果（2026-11-02，本机 ego lite 0.6.2.5）

| 步骤 | 结果 |
|---|---|
| 打开页面 → snapshot（7 个元素，含 2 个隐藏、1 个屏外、iframe、shadow） | 通过 |
| 输入 + 点击提交 + 回读变化 | 通过 |
| 真实鼠标悬停 → 隐藏按钮 visible → 点击 | 通过 |
| scrollTo 屏外元素 → 点击 | 通过 |
| 拖拽卡片进投放区，容器内容变化 + 位移校验 | 通过 |
| iframe 内按钮点击与回读 | 通过 |
| shadow DOM 内按钮点击与回读 | 通过 |
| 截图兜底（67 KB PNG） | 通过 |
| 标签页列表 / 切换 | 通过 |
