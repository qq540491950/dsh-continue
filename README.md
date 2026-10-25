# dsh-continue

DSH 桌面端（Web GUI）的**纯客户端**插件：让 composer 的**发送按钮**在「上一轮没跑完」时
自动变成**「继续」按钮**——不用输入任何内容，点一下就把任务接着干下去。

- **自用维护，不发布到 npm**。`package.json` 里 `"private": true`，发布形态是 **GitHub tag**
  （`github:qq540491950/dsh-continue#vX.Y.Z`），装法见第 3 节。
- **TypeScript 源码 + 一行构建**：源码在 `src/`，`npm run build` 用 `tsc` 生成
  `lib/client.js` / `lib/index.js`（产物**入库**，因为没有安装期构建步骤）。
  运行时仍然**零依赖**：TypeScript 只在 `devDependencies`。
- 仓库里只有 Linux 风格 LF 换行（`.gitattributes` 强制），不要提交 CRLF。

---

## 1. 它长什么样

```
正常结束（completed）              异常结束 / 被手动停止 / 输出被截断
┌──────────────────────────┐       ┌──────────────────────────┐
│  ……输入框……              │       │  ……输入框……              │
│  [＋] [权限] [模型 ▾]   ↑ │       │  [＋] [权限] [模型 ▾]   ▶ │
└──────────────────────────┘       └──────────────────────────┘
                                        ↑ 同一个位置，同一个尺寸，图标变成「继续」
```

- **同一个位置、同一个尺寸**：继续按钮逐条照抄官方主按钮的样式（34×34、圆角胶囊、
  品牌填充、`translateY(-2px)`），所以换的时候不会跳一下。
- **只在真的该继续的时候出现**：会话没在跑、草稿是空的、没有附件、也没有待处理的提问 /
  审批，并且**最新一轮的结束原因是 `aborted` / `error` / `max-tokens`**。
- 其余一切情况**一个像素都不动**：正常结束（`completed`）还是发送箭头；你自己打了字、
  拖了附件，发送键留在原位；会话正在跑，主按钮还是停止方块。

鼠标悬停时按钮的 `title` / `aria-label` 会说清为什么变成这样：

| 上一轮怎么结束的 | 悬停提示（中文） |
|---|---|
| 你按了停止 / `Esc Esc` | 已停止生成 · 点击继续 |
| 本轮出错 | 上一轮出错 · 点击继续 |
| 输出被截断（max tokens） | 回答被截断 · 点击继续 |

## 2. 点一下到底发生了什么

**它替你在输入框里打了「继续」两个字，然后按发送。** 走的是官方同一套提交机制
（`inputActions.setDraft("继续")` + `inputActions.submit()`），所以排队 / 插话 / 命令裁决 /
乐观提交 / 失败还原这些行为与手打完全一致。

这不是本插件发明的暗号：官方在输出被截断时的提示原文就是
**「回答被截断……发送「继续」可让模型接着输出」**（`dsh-client-ui-chat` 的
`message.maxTokens.hint`）。本插件只是把那句话替你打了，顺手把按钮换成图标。

> 想换这个词：改 `src/client.ts` 里的 `CONTINUE_TEXT`（只有这一处），然后 `npm run build`。

## 3. 安装（作为插件安装，不手改 profile）

本仓库整包就是一个 **bundle 插件**：`package.json` 的 `dsh.bundle.patch` 指向
[cordis.patch.yml](cordis.patch.yml)，那一层里的 `insert` 行就是接线本身。安装时由 DSH 写
profile 的 `package.json` 依赖与 `dsh.profile.bundles`，卸载时随依赖一起消失——
**不用手改 profile 的 `cordis.patch.yml`，仓库搬家也不用改路径。**

1. 打开 DSH 桌面端（Web GUI），点左侧栏的 **「插件」**。
2. 点右上 **「添加插件」**（主按钮直接打开安装对话框；箭头里的「安装第三方插件」打开同一
   个框）。
3. 包名输入框里填 **GitHub spec**：

   ```
   github:qq540491950/dsh-continue#vX.Y.Z
   ```

   安装器认四种 spec：registry 包名、绝对路径、git 地址（`github:用户/仓库#tag`）、tarball。
   本包 `"private": true` 且未发布到 npm，所以用 GitHub tag（与 `dsh-effort-picker` 一致）。
4. 点 **「安装」**；装完的画面上再点 **「立即启用」**（直接关掉对话框等于「装好但停用」）。
5. 界面没变化就 `Ctrl+R` 刷新一次页面。

装完的台账：profile 的 `package.json` 多一条
`"dsh-continue": "github:qq540491950/dsh-continue#<commit>"`，`dsh.profile.bundles` 里多一项
`dsh-continue`；profile 的 `cordis.patch.yml` 一个字都没变。

- **宿主半边** `lib/index.js` 是空的 `apply`，只作为投递链路的接线柱：客户端 bundle 由
  `@deepseek-ai/dsh-client-modules` 从这个包 `package.json` 的 `exports["./client"]` 定位，
  再由 Host 在 `/plugins` 下发布。
- **卸载 / 回滚**：同一个插件页里把 `dsh-continue` 这个组合包**关掉**（或点卸载），刷新页面，
  官方发送键立刻原样回来。命令行等价物是 `dsh plugin --profile desktop remove dsh-continue`。
- **开发期**（改代码立刻看效果）：用**本仓库绝对路径**作为 spec 装一次
  （`D:\project\dsh-plugins\dsh-continue`，会装成 link）。之后改 `src/` → `npm run build` →
  刷新页面就是新代码，**不用重新安装**。发布给别人时一律用 GitHub tag。

## 4. 开发与自检

```powershell
npm install          # 只装 devDependency：typescript + @types/node
npm run check        # = typecheck（src + tools）+ build + verify
```

- **全部源码都是 TypeScript**：`src/*.ts`（插件本体）与 `tools/*.ts`（构建 / 自检 / asar 工具）。
  工具脚本由 Node **原生类型剥离**直接执行（`node tools/build.ts`、`node tools/verify.ts`），
  不需要 ts-node / esbuild；`tsconfig.tools.json` 用 `erasableSyntaxOnly` 守住这条。
- `npm run build`（`tools/build.ts`）：`src/*.ts` → `tsc` → `.build/` → 校验投递契约 →
  **临时文件 + 原子替换**进 `lib/*.js`（`dsh-client-hmr` 读到半截文件会让插件彻底消失，
  所以不许就地写）。
- `npm run typecheck`：`tsc -p tsconfig.json --noEmit`（`src/`）+ `tsc -p tsconfig.tools.json`（`tools/`）。
- `node tools/verify.ts` 是**零运行时依赖**的离线自检：用 `node:vm` 跑**真实的**
  `lib/client.js`（含迷你渲染器 + 假 DOM）。
- 期望输出最后一行是 `全部通过 ✓（85 条断言 + 23 条反向验证）`，退出码 0。
  覆盖包清单契约（含 TS 工程与产物是不是 classic script）、宿主半边、客户端模块协议、
  座位注册、样式表、状态判定、藏 / 还原官方主按钮、点击提交、错误边界与降级，最后再往源码与
  清单里注入 23 种违规**证明这些断言真的会报错**。
- **不要手改 `lib/*.js`**：它是产物，下次构建会被覆盖。

## 5. 已知边界（别当成 bug）

| 边界 | 说明 |
|---|---|
| 官方主按钮是用 `style.display="none"` 藏起来的 | composer 的**主操作按钮没有对应座位**（`conversation.input.right` 在它左边、`conversation.input.activity` 在它右边，都不包含它本身），所以「同一个位置换成继续按钮」只能靠：在 `activity` 座位渲染自己的按钮 + 把官方那个藏起来。**这不是理想做法**，是本插件唯一一处碰官方 DOM 的地方，代价与兜底见 `AGENTS.md` 第 2 节。 |
| 继续按钮只认「最新一轮」 | 读的是 Chat target 快照的 `timeline`（`turn.end.data.reason.kind`），与官方判「停止/失败的一轮」用的是同一个字段。 |
| 订阅 Chat target 有成本 | 为了读最新一轮的结束原因，座位会订阅 Chat 快照；即使你切到 Trajectory 视图，Chat target 也会保持激活。这是拿一点内存换「不看视图也能正确判断」。 |
| 输出被截断（max-tokens）也算「该继续」 | 官方在那里的提示就是让用户发「继续」，所以本插件一并接管。不想要就把它从 `RESUME_REASONS` 里删掉。 |
| 界面没有实测过 | 本机没有浏览器控制能力，只验证了包清单、真跑 factory / apply 的协议断言、迷你渲染器下的行为断言，以及**活台账**里的座位注册（`conversation.input.activity` 的 `occupants` 里能看到 `priority: -1` 的本插件条目）。**视觉效果（颜色、位置、悬停）与人眼点击未经确认。** |
| 不注册快捷键 | 只改按钮，不加键盘手势。 |
