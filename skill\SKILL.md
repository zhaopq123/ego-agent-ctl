---
name: ego-agent-ctl
description: 在 ego lite 里用结构化 Markdown 页面状态驱动浏览器：按元素 id 点击/输入/拖拽/滚动，动作后强制回读校验；截图只作兜底。需要 ego lite 已加载 ego-agent-ctl 扩展。
---

# ego-agent-ctl

## 什么时候用

- 要让 agent 操作 ego lite 里的网页（点按钮、填表、拖拽、翻页）
- 需要「做完确认真的成了」，不能接受“我以为成功了”

## 首次使用：agent 自己装（不用人点）

先按「前置检查」看扩展在不在。不在就按顺序跑这三步，**前提是 ego 窗口在当前登录桌面**（SSH/无桌面会话拿不到系统文件对话框）。

```powershell
# 1. 触发「加载已解压」，会弹出系统文件夹选择框
Get-Content -Raw "<扩展目录>\install\load.mjs" | ego-browser nodejs

# 2. 立刻（25 秒内）把路径填进那个框并确认
python "<扩展目录>\install\fill_dialog.py" "<扩展目录>" 25

# 3. 回读，拿到 id
Get-Content -Raw "<扩展目录>\install\verify.mjs" | ego-browser nodejs
```

第 3 步输出 `state: "ENABLED"` 且两个错误数都为 0 才算装好；然后照常用 `chrome-extension://<id>/panel.html`。

装一次就持久了，之后任何 agent 直接用，不用再装。

## 前置检查（一次）

1. `chrome://extensions` 里能看到 `ego agent ctl`，状态「已启用」
2. 记下扩展 id
3. 没有的话：开发者模式 → 加载已解压 → 选扩展目录

## 标准流程

```js
const ID = "<扩展 id>";
const t = await taskSpace("任务名");
const target = await t.page("p1");          // 真正要操作的页面
const ctl = await t.newPage();              // 控制台面板
await target.goto("https://目标站");
await ctl.goto("chrome-extension://" + ID + "/panel.html");

// 1) 拿状态：只看 markdown
const snap = await ctl.evaluate(() => egoCtl.snapshot({ probe: true, urlIncludes: "目标站域名" }));
console.log(snap.markdown);

// 2) 按 id 动作
await ctl.evaluate((id) => egoCtl.type(id, "关键词", { urlIncludes: "目标站域名" }), inputId);
await ctl.evaluate((id) => egoCtl.click(id, { urlIncludes: "目标站域名" }), submitId);

// 3) 回读
await ctl.evaluate(() => egoCtl.waitFor({ textIncludes: "已提交" }, { urlIncludes: "目标站域名" }, 5000));
```

## 三条规定

1. **只按 id 操作**。坐标只用来校验落点，不当点击依据。
2. **每个动作都看 `ok`**。返回 `ok:false` 就是没成功，别往下编。
3. **`state` 不是 `visible` 的先处理**：
   - `offscreen` → `scrollTo(id)`
   - `hidden:*` 且有 `trigger` → 先用 ego 真实鼠标悬停触发元素（见下），再 click
   - `obscured` → 返回里有 blocker，先关浮层
   - `disabled` → 停，别点

## 悬停菜单（CSS :hover / JS mouseenter）

扩展世界合成事件触发不了页面悬停，必须用 ego 的真实鼠标：

```js
const c = await ctl.evaluate(() => egoCtl.hoverCandidates({ urlIncludes: "目标站域名" }));
await target.mouse.move(c.list[0].x, c.list[0].y);
await target.waitForTimeout(300);
const s2 = await ctl.evaluate(() => egoCtl.snapshot({ cache: false, urlIncludes: "目标站域名" }));
```

悬停后子元素 `state` 变 `visible`，再 `click`。

## 按键与等待

```js
await ctl.evaluate((id) => egoCtl.press(id, "Enter", { urlIncludes: "目标站域名" }), inputId);
await ctl.evaluate(() => egoCtl.waitForIdle({ quiet: 500, timeout: 5000, urlIncludes: "目标站域名" }));
```

按键是合成的；**表单内按 Enter 会自动走 `form.requestSubmit()`**，能真正提交。非表单场景或站点要求可信键盘时，用 `target.keyboard.press("Enter")`。

## 拖拽

```js
await ctl.evaluate((p) => egoCtl.drag(p.from, p.to, { urlIncludes: "目标站域名" }), { from: srcId, to: dstId });
```

返回 `checks`：`moved_distance`（位移）和 `target_changed`（容器内容变化），两个都 true 才算成功。

## 连续动作链

```js
await ctl.evaluate((steps) => egoCtl.run(steps, { urlIncludes: "目标站域名" }), [
  { op: "type", id: qId, text: "关键词" },
  { op: "click", id: submitId },
  { op: "waitFor", expect: { textIncludes: "结果" }, timeout: 8000 }
]);
```

任一非 optional 步骤失败即停，`results` 里能看到停在哪一步。

## 失败后怎么闭环（别猜）

任何动作返回 `ok:false`，按这个顺序来：

```js
const d = await ctl.evaluate((id) => egoCtl.diagnose(id, Q), badId);   // 状态/遮挡者/祖先链/建议
const e = await ctl.evaluate(() => egoCtl.pageErrors(Q));               // 页面 JS 报错
const t = await ctl.evaluate(() => egoCtl.trace(Q));                    // 最近动作轨迹
```

`diagnose.suggestions` 直接给出下一步该做什么（悬停谁、滚哪里、关哪个浮层、换真实鼠标点哪个坐标）。照它做，不要重复盲点。

## 错误码解法

| 错误 | 下一步 |
|---|---|
| `E_STALE` | 重新 `snapshot` 拿新 id |
| `E_NOT_FOUND` | 名称变了，重新 snapshot |
| `E_HIDDEN` | 先真实鼠标悬停 `trigger` |
| `E_OBSCURED` | 看 `blocker`，关掉浮层再点 |
| `E_NO_EFFECT` | 先用返回的 `trustedHint:[x,y]` 走真实鼠标：`await target.mouse.click(x, y)`；仍无变化再换目标或确认是否要先登录 |
| `E_DRAG_UNVERIFIED` | 看 `checks` 哪项 false；可能要更长的 `settle` |
| `E_TIMEOUT` | 用 snapshot 看当前状态，别重复盲等；也调 `egoCtl.diagnose(id)` 看建议 |

## 截图兜底

只有 canvas / 纯图片 / 跨域 iframe 才用：

```js
const s = await ctl.evaluate((q) => egoCtl.shot(q), { urlIncludes: "目标站域名" });
// s.dataUrl 是 PNG base64，可写文件后人工/视觉核对
```
