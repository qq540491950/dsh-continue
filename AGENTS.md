# AGENTS.md

给**在这个仓库里动手的 AI 与人**看的约束清单。动手前先读完第 2 节——那里的每一条都对应一次
真实的机制陷阱，相关代码看着"多余"但都不是。

## 1. 这是什么

DSH 桌面端（Web GUI）的**纯客户端**插件：composer 的主操作按钮在「上一轮异常结束 / 被手动停止 /
输出被截断」且草稿为空时，变成**「继续」按钮**（同一位置、同尺寸），点一下就把「继续」替你发出去。

### 文件职责

| 文件 | 职责 | 改它的风险 |
|---|---|---|
| `lib/client.js` | 浏览器半边：全部 UI 与交互，`window.__ModuleLoader__` 懒 CJS bundle | **高**——第 2 节四条硬规则里三条都在这里 |
| `lib/index.js` | 宿主半边：空 `apply`，只作为 Loader 的接线柱 | 低，但**不许删**：删了 `dsh-client-modules` 从该条目向上找不到 `package.json`，客户端 bundle 就不再投递 |
| `package.json` | 包清单契约（第 4 节） | 中——改错就整体不加载 |
| `tools/verify.mjs` | 离线自检：纯 Node、零依赖，用 `node:vm` 跑**真实的** `lib/client.js`（含迷你渲染器 + 假 DOM） | 低；改它必须同步改断言，**不许为了让它变绿而放宽断言** |
| `tools/asar.mjs` | 开发工具：从 `app.asar` 里只读取官方源码（`list` / `read` / `grep`） | 低；不是插件的一部分，不参与投递 |
| `README.md` | 面向使用者的介绍与使用说明 | 低 |
| `AGENTS.md` | 本文件（工程约束） | 低 |

## 2. 四条硬规则（每条都对应一次真实机制陷阱）

### 2.1 遮蔽型座位的条目一抛错就被退役

`single` / `keyed` / `list` 这类座位在 DSH 里有一条硬规则：**条目抛出的错误被外层边界捕获后，
该条目被退役**（`reportEntryError(..., { abdicate: true })`）。退役是"每个注册条目一次性"的：
**要等页面刷新或 bundle 重新发布才恢复**。

本插件占的是 `conversation.input.activity`（`single`），所以纪律是：

- **`SeatBoundary` 必须包住座位子树**，失败降级成「什么都不渲染」（官方发送键留在原位，
  功能静默失效，但界面绝不缺一块）。verify 的 D 组用「`useChat` 抛错」钉住这条。
- **可用性判断不许和 Hook 调用写在同一个组件里**：`useChat` 由 `dsh-client-ui-chat` 通过
  `ctx.uiSession.provide({hooks: ["chat"]})` 提供，可能比本条目晚挂载。标准 props 从"没有
  `useChat`"变成"有"，如果判断写在 `ContinuePrimary` 里，同一个组件实例的 Hook 数量会变化，
  React 直接报 `Rendered more hooks than during the previous render`。所以
  **`ContinueSeat` 只做 `typeof props.useChat !== "function"` 判断、不调用任何 Hook**，
  两种情况渲染的是不同的组件类型，React 正常卸载 / 挂载。

### 2.2 「同一个位置换成继续按钮」只能靠藏官方按钮（**唯一一处碰官方 DOM 的地方**）

官方 composer 的主操作按钮**没有对应座位**——`conversation.input.right` 在它左边、
`conversation.input.activity` 在它右边，都不包含它本身（活台账 `Slots.listSubTree` 可复核）。
所以本插件用两个动作合成同一个观感：

1. 往**官方声明的空座位** `conversation.input.activity` 注册自己的按钮。这个座位就在主按钮
   左边一位，而 `.trailing` 是 `margin-left:auto` 的右对齐 flex——**主按钮被藏起来之后，
   我们的按钮正好落在主按钮那一格**。座位本身是官方提供的扩展点，`replaceRisk` 名义上是
   `shadows-shipped-ui`，但**当前无人占用**（注册前用活台账确认）。
2. 只在继续态把官方主按钮 `style.display = "none"`，并在状态一变 / 卸载时还原。

因此这几条必须守住（verify 的 C / D 组逐条钉住）：

- **官方主按钮 = `.trailing` 的最后一个直接子 `button`**（Tooltip 用 `cloneElement`，
  不额外包一层 DOM）。先按结构找，找不到再退回"卡片里最后一个 button"，两条路都要排除自己。
- **藏起来必须能还原**：`restoreHidden()` 在 effect cleanup 与卸载时都跑；只在 `active` 为真
  时藏。正常结束（`completed`）**一个像素都不许动**。
- **React 换掉那个 button 节点时要重新藏**：`MutationObserver` 观察卡片（`childList` +
  `subtree`），回调里重新解析 `rootRef.current`（不要闭包捕获旧节点）。没有
  `MutationObserver` 时降级成"只藏一次"，不许抛。
- **`hide()` 里解析的 `own` 必须来自 `rootRef.current`**，不能是 effect 建立时捕获的节点。

### 2.3 Cordis 的 Service 方法以**调用方上下文**求值

本插件只调自己的注入面（`ctx.slots` / `ctx.locale`），**不调用别的插件 Service 的方法**，
所以没有 `dsh-effort-picker` 那种"注入清单必须覆盖官方代码经 `this.ctx` 碰到的每一项服务"的问题。
但**状态全部走座位标准 props**（`useSession` / `useSessionStatus` / `useInput` / `useChat` /
`inputActions` / `sessionId` / `locked` / `t`），一个都不自己找服务。想加新的状态源时：
先 `cordis_inspect_query(platform: client, provider: Slots, method: listSubTree, root: "conversation.input.activity")`
看 `standardProps` 里有没有，有就用，没有就想清楚代价（第 2.2 节就是这么来的）。

### 2.4 HMR 可能读到半截文件

`dsh-client-hmr` 每 500ms 按 mtime/ctime/size 判版本。文件写到一半时被读到，按失败策略
「替换失败不回滚」，插件会彻底消失（界面里继续按钮没了，官方按钮原样）。

**写 `lib/client.js` 一定要写临时文件再原子替换**，不要就地截断写入。恢复办法：重新保存一次
`lib/client.js`（内容不变也行，mtime/size 变了宿主就会发新 rev），或 `Ctrl+R` 刷新页面。

## 3. 不能改的东西（不变量）

| 不变量 | 为什么 | 谁在守 |
|---|---|---|
| bundle `id` 必须等于 `package.json` 的 `name` | `dsh-client-modules` 用它做模块身份 | verify A / C |
| `exports["./client"]` / `exports["./package.json"]` / `dsh.client.platform: "web"` | 投递链路的读取契约 | verify A |
| 座位注册必须留 `priority: -1` | `single` 座位**同 priority 直接抛错**（`single slot "…" already has a registration at priority 0`）；一旦官方或别的插件也占这一格，注册期抛错会让整个插件激活失败。`-1` 的语义是"最低者渲染" | verify C |
| 座位注册必须走 `slots.inject("conversation.input.activity", …)` | 座位未声明时直接 `register` 会抛 `slot "…" is not declared`；`slots.inject` 负责等声明 | verify C |
| `SeatBoundary` 必须包住座位子树 | 2.1 | verify D |
| `ContinueSeat` 里不许调用任何 Hook | 2.1 | verify D |
| `require` 只能取平台种子模块；本插件**只允许 `react`** | 种子表固化在 shell 里；官方 practices 还要求**不 require 官方 Client 包**（`ui-primitives` 等改版无通知），所以图标是照抄 artwork 自带的 svg | verify C |
| 宿主半边零 `import` / 零 `require`、导出 `apply` | 它只当接线柱；多引入依赖就多一个失败面 | verify B |
| 视觉与尺寸**写进注入的样式表**，不写 inline | inline 的 `background` 优先级高于 `:hover`，写 inline 就永远没有悬停反馈；`installStyles()` 带 `data-plugin` / `data-plugin-css` 标记（HMR 台账），并用 `ctx.effect` 管清理 | verify C |
| 主按钮样式逐条抄官方 `.primary`（34×34 / `--dsw-alias-button-info-fill` / `translateY(-2px)`），`color:#fff` 也照抄 | 尺寸不一致换按钮时会跳；底色是饱和的品牌填充色，两种主题下都需要纯白前景——这里**不是**"硬编码主题色" | verify C（裸色只允许这一个 `#fff`） |
| 继续文本只认一个常量 `CONTINUE_TEXT`，默认「继续」 | 与官方 `message.maxTokens.hint`（"发送「继续」可让模型接着输出"）同一个词；改词只改这一处 | verify D |
| 触发条件 = `RESUME_REASONS`（`aborted` / `error` / `max-tokens`）+ 空闲 + 空草稿 + 无附件 + `phase === "plain"` + 未锁 + 无待处理交互 | 任何一条不满足都必须回到官方行为——**这是本插件的安全边界** | verify D |
| 点击必须 `setDraft(CONTINUE_TEXT)` 然后 `submit()`，同步连做 | `setDraft` 走 Lexical 的 discrete update（同步提交），紧接着的 `submit()` 才读得到这句话；万一将来变异步，最坏结果是草稿里留着「继续」+ 官方发送键复活，用户点一下即可 | verify D |
| 提交后自己 `disabled`，`running` 翻起或超时（8s）才解除 | 乐观提交期间 `running` 还没翻，没有闸门就会连点排两条「继续」 | verify D |
| 文案走 `ctx.locale.register(NS, {zh, en})`，两份 key 集合一致 | 官方 practices 要求可见文案走 locale；`t` 缺失 / 返回空串时退回中文兜底 | verify C / D |
| 词典 key 覆盖三种原因 + 兜底 | 悬停提示要说清"为什么变成这样" | verify C |

**不要顺手做的重构**：不加依赖、不引入构建 / 打包工具、不把 `lib/client.js` 拆成多文件
（它必须是一个 classic script，不是 ESM）、不改有意的硬编码、不"美化"间距到与现状不一致
（diff 越小越好）。

## 4. 改动流程（做完算数才算完）

1. 改代码（`lib/client.js` 用临时文件 + 原子替换写）。
2. **跑自检**：

   ```powershell
   node tools/verify.mjs
   ```

3. **必须看到最后一行 `全部通过 ✓（N 条断言 + M 条反向验证）` 且退出码 0**。
   失败时会打印 `失败 N 项：` 并 `exit 1`。
4. 只有第 3 步过了才有资格说"改好了"。**禁止**在没跑自检、或自检失败的情况下汇报成功；
   也禁止用"看起来没问题"替代实际输出。
5. 新增断言必须**反向验证**：往 `MUTATIONS` 里加一条，故意注入违规，确认断言能**精确**
   报错。两个自欺陷阱必须避开：
   - 锚点必须**恰好出现一次**，否则该用例无效（脚本会打 `锚点出现 0 次`，不能记成"没报出"）；
   - 注入可能让套件**崩掉**而不是报 FAIL——那也必须单独判为**用例无效**。
6. 提交前跑编码检查：

   ```powershell
   node -e "const fs=require('fs');const b=fs.readFileSync('lib/client.js');const t=b.toString('utf8');console.log((b[0]===0xEF?'BOM!':'no-bom'),(t.includes(String.fromCharCode(0xFFFD))?'FFFD!':'clean'),'crlf='+(t.match(/\r\n/g)||[]).length)"
   ```

### 自检自身的坑（写 `tools/verify.mjs` 前必读）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| 迷你渲染器里**节点必须先进 DOM 再跑 effect** | 组件 effect 顺着 `parentElement` 找不到 composer 卡片 → 观察者一个都没挂上 | `renderer.setOnCommit(attach)`，`pass()` 里在 `commitEffects()` **之前**回调 |
| 子实例必须存**实例本身**，不是 `{instance, node}` 包装 | 第二轮渲染全部重新挂载、Hook 状态清零 → `setState` / effect cleanup 全部失效 | `instance.children = rendered.map((child) => child.instance)` |
| 假 DOM 的 `dataset` 必须是**活映射** | `tag.dataset.pluginCss = …` 只写了对象字段，`querySelector('style[data-plugin-css=…]')` 永远找不到 | 用 `Proxy` 把 `dataset.xY` 映射到 `data-x-y` 属性 |
| 宿主半边的断言不能只 `import` 磁盘文件 | 注入过的版本测不到 | 用 `data:text/javascript;base64,…` 就地求值 |
| 沙箱 `console` 要收进数组 | 13 条反向验证会把 stderr 刷成 149 行红字，真正的失败被埋掉 | `loggedErrors`，顺便断言"边界确实上报了一条" |
| 断言里带半真半假的「或」 | 等于没断言 | 拆成两条，或只留真判断 |
| 一条永远为真的断言 | 比没有更糟（虚假安全感） | 每条都要有一条能打破它的 `MUTATIONS` |

## 5. 出问题时怎么恢复

| 症状 | 原因 | 恢复 |
|---|---|---|
| 继续按钮整个没了，官方发送键正常 | 条目被退役（2.1 / 2.4） | 重新保存一次 `lib/client.js`（内容不变也行），或 `Ctrl+R` 刷新页面。不必重启 DSH |
| 官方发送键被藏了但继续按钮没出现 | 藏与渲染不同步（不该发生；`hide()` 与 `visible` 同一个 effect） | 刷新页面；并把 `localStorage` / 控制台里 `[dsh-continue]` 前缀的记录贴出来 |
| 想立刻回到官方控件 | — | 删掉 profile 里 `id: dsh-continue` 那个 insert 行，刷新页面 |
| 想看失败原因 | — | 控制台 `[dsh-continue]` 前缀（座位内边界只打一条，不刷屏） |

## 6. 只碰自己那一行

profile 是**用户的环境**，不是本仓库的一部分：
`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml`。在里面**只允许增删
`id: dsh-continue` 这一个 insert 行**——其它条目的配置（模型、推理强度、搜索 provider、MCP、
密钥）都不属于本任务范围，不要"顺手"改。补丁层里新增条目必须用 `insert:` 追加，
裸写 `- id: ...` 会被当成覆盖目标，id 不存在时 Loader 报 `entry not found` 并丢弃该条。

## 7. 本机事实（会漂移，别当契约）

- 仓库路径：`D:\project\dsh-plugins\dsh-continue`（profile 里的路径行依赖它）。
- profile 补丁：`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml`。
- Node：v24.14.1（自检只需标准库）。
- 官方源码在 `D:\Program Files\DeepSeek Harness\resources\app.asar` 里，用
  `node tools/asar.mjs read <asar 内路径>` 取；关键出处：
  - 主按钮与 `conversation.input.activity` 的渲染位置：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
    （`InputBar` 的 `.trailing` 子节点顺序、`renderSlot("conversation.input.activity", {locked, onActiveChange})`）；
  - `.primary` 样式与 `.trailing{margin-left:auto}`：同包 `InputBar.module.css` 的 css 常量；
  - `turn/end` 的 reason 取值（`completed`/`aborted`/`error`/`max-tokens`）：`@deepseek-ai/dsh-agent-loop/lib/index.js`；
  - Chat 时间线（`timeline.turnOrder` / `timeline.turns[].end.data.reason.kind`）：`@deepseek-ai/dsh-client-ui-chat/lib/client.js`；
  - `inputActions`（`setDraft` / `submit`）：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 的 `SessionInputShell.actions`；
  - 座位标准 props 与 `single` 座位同 priority 抛错：`@deepseek-ai/dsh-client-ui-slots/lib/index.js`、`@deepseek-ai/dsh-client-ui-renderer/lib/client.js`；
  - `IconPlayOutlineRegular` 的 artwork：`@deepseek-ai/dsh-client-ui-primitives/lib/index.js`。
- 目标座位：`conversation.input.activity`（`single`，`scope: "session"`，当前无人占用）。

## 8. Git 约定

- 分支 `main`；提交信息用中文 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:`），
  一行说清改了什么。
- **不要提交敏感信息**：profile 的 `cordis.patch.yml` 里有 API key（MCP / 搜索 provider），
  它**不在本仓库内**，永远不要把它、或它的片段、或任何 token 复制进本仓库。
- 提交信息写进 UTF-8 文件后用 `git commit -F` 传入，不要用 `-m` 直传中文。
- `.gitattributes` 强制 LF；不要引入 CRLF（混入会产生整文件 diff）。
- 沙箱下 `git push` 的 stderr 进度输出会被 PowerShell 当成错误记录并给出 `[exit code: 1]`，
  这是**假警报**——以 `git ls-remote` 与 `git status -sb` 为准。
