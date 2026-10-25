/**
 * 浏览器半边（Client half）——DSH 自带的「懒 CJS」模块协议。
 *
 * 源码是**本文件**（`src/client.ts`，TypeScript）；投递产物是 `lib/client.js`，
 * 由 `npm run build`（`tools/build.ts`，原子替换）生成。**不要手改 `lib/client.js`**。
 *
 * 契约（见 @deepseek-ai/dsh-client-modules）：
 *   1. 编译后必须仍是**单个 classic script**，不是 ESM；执行时只做一件事：
 *      向 `window.__ModuleLoader__` 注册一个 factory。
 *      所以本文件**没有 import / export**（有了就会被 tsc 当模块，产出 ESM 或 CJS 包装，
 *      两条路都会破坏模块协议）；需要类型时只用 `import type` 之外的本地声明。
 *   2. factory 在首次被 materialize 时执行，返回的 exports 就是模块导出。
 *   3. `id` 必须等于本包 package.json 的 `name`。
 *   4. `require` 只能取「平台种子模块」：react / react-dom / cordis /
 *      dsh-client-store / ui-slots / ui-primitives / ui-dockkit。
 *      本插件**只用 react**（见 AGENTS.md：不 require 官方 Client 包），
 *      所以也**不拆多文件**（相对 `require` 在浏览器里解析不了），类型就地写在下面。
 *
 * 本插件做什么
 * ------------
 * 官方 composer 的最后一个按钮是「主操作」：正常时是发送箭头（aria-label「发送消息」），
 * 运行中且草稿为空时是停止方块（aria-label「停止生成」）。它**没有对应座位**
 * （`conversation.input.right` 在它左边、`conversation.input.activity` 在它右边，
 * 都不包含它本身），所以本插件用两个动作合成同一个观感：
 *
 *   1. 往官方声明的空座位 `conversation.input.activity`（single，就在主按钮左边一位）
 *      注册一个自己的按钮——它渲染时**占的正是主按钮那一格**（`.trailing` 是
 *      `margin-left:auto` 的右对齐 flex，主按钮是它最后一个子元素）；
 *   2. 只在「上一轮异常结束 / 被手动停止」且草稿为空时，把官方主按钮
 *      `style.display = "none"` 藏起来，于是用户看到的就是**同一个位置的按钮变成了「继续」**。
 *
 * 点一下发生什么
 * --------------
 * 「继续」= 用官方同一套提交机制把一句话发出去：`inputActions.setDraft("继续")` +
 * `inputActions.submit()`。这不是本插件发明的语义——官方在输出被截断时的提示原文就是
 * 「回答被截断……发送「继续」可让模型接着输出」（`dsh-client-ui-chat` 的
 * `message.maxTokens.hint`），本插件只是把那句话替用户打了。
 *
 * 三条硬规则（每条都对应一次真实故障，见 AGENTS.md 第 2 节）
 * ---------------------------------------------------------
 * A. **座位条目一抛错就被退役**：single/list 这类遮蔽型座位，条目抛出的错误被外层边界
 *    捕获后 `reportEntryError(..., { abdicate: true })`，条目从界面上消失且**不会自己回来**。
 *    所以本插件在座位内部包了一层 {@link SeatBoundary}，失败降级成「什么都不渲染」，
 *    绝不冒泡到外层。
 * B. **Cordis 的 Service 方法以调用方上下文求值**：本插件只调 `ctx.slots` / `ctx.locale`
 *    这两个自己的注入面，不调用别的插件 Service 的方法，所以没有这条的注入清单问题；
 *    但**标准 Hook 的可用性必须在渲染期判断**（`useChat` 由 ui-chat 提供，可能比本条目晚
 *    挂载）——见 {@link ContinueSeat}：可用性判断放在**不调用任何 Hook** 的外层组件里，
 *    否则「props 从缺到有」会让同一个组件实例的 Hook 数量变化，React 直接报错。
 * C. **HMR 可能读到半截文件**：`dsh-client-hmr` 按 mtime/size 判版本，就地截断写入时被读到
 *    会按「替换失败不回滚」处理，插件彻底消失。所以改代码只改 `src/client.ts`，产物由
 *    `tools/build.ts` 写临时文件再原子替换——**永远不要手写 `lib/client.js`**。
 */
window.__ModuleLoader__.load({
    id: "dsh-continue",
    factory: (require) => {
        //#endregion
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        const react = require("react");
        const h = react.createElement;
        /** 包名 = bundle id = 座位条目的注册来源。 */
        const PKG = "dsh-continue";
        /** 文案命名空间（`ctx.locale.register` 的 key，同时写进座位注册的 `locale`）。 */
        const NS = "dsh-continue";
        /**
         * 点「继续」时替用户发出去的那句话。
         *
         * 刻意与官方 `message.maxTokens.hint`（「发送「继续」可让模型接着输出」）用同一个词：
         * 中文语境下「继续」是模型最不容易误解的续写指令。要改词只改这一处。
         */
        const CONTINUE_TEXT = "继续";
        /**
         * 触发「继续」的 turn/end 原因（`turn.end.data.reason.kind`）：
         * - `aborted`：用户按了停止 / Esc Esc（手动停止）
         * - `error`：本轮异常结束（LLM 报错等）
         * - `max-tokens`：输出被截断，官方提示就是让用户发「继续」
         * 正常结束是 `completed`，**不在**这张表里（那时主按钮保持发送箭头）。
         */
        const RESUME_REASONS = ["aborted", "error", "max-tokens"];
        /**
         * 点了「继续」之后，按钮最多自己禁用多久。
         *
         * 乐观提交会让 `running` 稍后才翻成 true；没有这个闸门时，连点两下会排两条「继续」。
         * 真正的解除条件是 `running === true`（或草稿被非空还原，那时按钮本来就该让位给发送键）。
         */
        const BUSY_TIMEOUT_MS = 8000;
        /** 注入的样式表标识（HMR 台账按 data-plugin / data-plugin-css 记账）。 */
        const STYLE_ID = `${PKG}/ContinueButton.css`;
        //#region 文案
        /** 简体中文词典（key 集合的事实来源）。 */
        const zh = {
            "action.continue": "继续任务",
            "action.continue.stopped": "已停止生成 · 点击继续",
            "action.continue.failed": "上一轮出错 · 点击继续",
            "action.continue.truncated": "回答被截断 · 点击继续",
        };
        /** 英文词典，逐 key 对齐中文。 */
        const en = {
            "action.continue": "Continue task",
            "action.continue.stopped": "Stopped · click to continue",
            "action.continue.failed": "The last turn failed · click to continue",
            "action.continue.truncated": "The reply was cut off · click to continue",
        };
        //#endregion
        //#region 样式
        /**
         * 主按钮的样式**逐条抄自官方** `InputBar.module.css` 的 `.primary`
         * （`dsh-client-ui-conversation`），只改了类名前缀：
         *
         * ```css
         * .primary{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;
         *          cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;
         *          width:34px;height:34px;transition:background-color .1s;display:grid;
         *          transform:translateY(-2px)}
         * .primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
         * .primary:disabled{opacity:.4;cursor:default}
         * ```
         *
         * 两处刻意的例外（AGENTS.md 第 3 节钉住）：
         * - `color:#fff` 是**照抄官方**的：底色是饱和的品牌填充色，两种主题下都需要纯白前景；
         *   这里不是「硬编码主题色」，换成 token 反而会与官方按钮不一致。
         * - 尺寸必须与官方一致（34×34 + translateY(-2px)），否则按钮换位时会跳一下。
         */
        const css = [
            `.dsh-continue-primary{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;display:grid;transform:translateY(-2px)}`,
            `.dsh-continue-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}`,
            `.dsh-continue-primary:disabled{opacity:.4;cursor:default}`,
        ].join("");
        /**
         * 注入样式表；返回移除函数。
         *
         * 用样式表而不是 inline style 的原因只有一个：**inline 的 `background` 优先级高于
         * `:hover`**，写 inline 就永远没有悬停反馈。`data-plugin` / `data-plugin-css` 是
         * `dsh-client-modules` 的 HMR 记账标记，照官方插件的写法带上，避免被 `claimStyles`
         * 误记到别的插件名下。
         */
        function installStyles() {
            const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`);
            if (existing !== null)
                return () => { };
            const tag = document.createElement("style");
            tag.dataset.plugin = PKG;
            tag.dataset.pluginCss = STYLE_ID;
            tag.textContent = css;
            document.head.appendChild(tag);
            return () => {
                if (tag.parentNode !== null)
                    tag.parentNode.removeChild(tag);
            };
        }
        //#endregion
        //#region 状态判定（纯函数：不碰 React / DOM，离线自检直接断言这几个）
        /**
         * 取「最新一轮」的结束原因；没有已结束的轮次时返回 `null`。
         *
         * 数据面是 Chat target 快照的 `timeline`：
         * `{ turnOrder: number[], turns: Map<number, {status, start, end}> }`，
         * 其中 `end.data.reason.kind` 就是 `completed` / `aborted` / `error` / `max-tokens`
         * （来源：`dsh-agent-loop` 的 `turn/end` 写入 + `dsh-client-ui-conversation` 的
         * 时间线组装）。官方自己判「停止/失败的一轮」也是读这同一个字段
         * （`dsh-client-ui-chat` 的 `turnProcessAlwaysOpen`）。
         *
         * 只认 `status === "closed"`：轮次还在跑时 `reason` 还不存在，此时绝不能出「继续」。
         * @param chat - Chat target 快照（可能尚未就绪）。
         * @returns 结束原因字符串，或 null。
         */
        function lastTurnReason(chat) {
            const timeline = chat === null || chat === undefined ? undefined : chat.timeline;
            if (timeline === null || timeline === undefined)
                return null;
            const order = timeline.turnOrder;
            if (!Array.isArray(order) || order.length === 0)
                return null;
            const turns = timeline.turns;
            if (turns === null || turns === undefined || typeof turns.get !== "function")
                return null;
            const turn = turns.get(order[order.length - 1]);
            if (turn === null || turn === undefined || turn.status !== "closed")
                return null;
            const end = turn.end;
            const reason = end === null || end === undefined ? undefined : end.data?.reason;
            const kind = reason === null || reason === undefined ? undefined : reason.kind;
            return typeof kind === "string" ? kind : null;
        }
        /**
         * 该不该把主按钮换成「继续」。
         *
         * 全部输入都是原始值，任何一条不满足都回到官方行为——**这是本插件的安全边界**：
         * 用户自己打了字、正在跑、有附件、被别的浮层接管时，一个像素都不动。
         * @param state - `{locked, running, pendingInteraction, phase, empty, reason}`。
         * @returns 是否接管主按钮。
         */
        function shouldContinue(state) {
            if (state.locked === true)
                return false;
            if (state.running === true)
                return false;
            if (state.pendingInteraction === true)
                return false;
            // 输入机只在 plain 相位接受普通提交；adjudicating/submitting/claimed 都让位。
            if (state.phase !== "plain")
                return false;
            // 草稿或附件非空 = 用户有自己的话要说，发送键必须留在原位。
            if (state.empty !== true)
                return false;
            return state.reason !== null && RESUME_REASONS.indexOf(state.reason) >= 0;
        }
        /** 结束原因 → 提示文案 key。 */
        function hintKey(reason) {
            if (reason === "aborted")
                return "action.continue.stopped";
            if (reason === "error")
                return "action.continue.failed";
            if (reason === "max-tokens")
                return "action.continue.truncated";
            return "action.continue";
        }
        /**
         * 取一条本地化文案；`t` 缺失或 key 未命中时退回中文兜底。
         * @param t - 座位注入的翻译函数。
         * @param key - 文案 key。
         * @param fallback - 兜底文本。
         * @returns 展示文本。
         */
        function message(t, key, fallback) {
            if (typeof t !== "function")
                return fallback;
            const text = t(key);
            return typeof text === "string" && text !== "" ? text : fallback;
        }
        //#endregion
        //#region DOM
        /**
         * 找到官方主操作按钮（发送 / 停止）。
         *
         * 官方 JSX 结构（`InputBar`，`dsh-client-ui-conversation`）：
         *
         * ```html
         * <div class="…trailing">            <!-- flex; margin-left:auto（右对齐） -->
         *   <div class="…standardControls">…</div>
         *   <div class="…activity">          <!-- ← 我们注册的座位在这里面 -->
         *     <button data-dsh-continue>…</button>
         *   </div>
         *   <!-- 运行中才有：<Tooltip><button class="…primary">停止</button></Tooltip> -->
         *   <Tooltip><button class="…primary">发送</button></Tooltip>
         * </div>
         * ```
         *
         * 主按钮是 `.trailing` 的**最后一个直接子 button**（Tooltip 用 cloneElement，
         * 不额外包一层 DOM）。先按这个结构找；找不到再退回「卡片里最后一个 button」，
         * 两条路都排除我们自己。
         * @param card - composer 卡片（`[data-composer-card]`）。
         * @param own - 本插件自己的按钮根节点。
         * @returns 官方主按钮，或 null。
         */
        function officialSubmitButton(card, own) {
            const activity = own.parentElement;
            const trailing = activity === null ? null : activity.parentElement;
            if (trailing !== null) {
                const direct = [];
                for (const child of trailing.children) {
                    // `children` 是 Element 集合；官方主按钮一定是 <button>，这里只是把类型收窄回 HTMLElement。
                    if (child.tagName === "BUTTON" && own.contains(child) === false)
                        direct.push(child);
                }
                if (direct.length > 0)
                    return direct[direct.length - 1];
            }
            const all = [];
            for (const candidate of card.querySelectorAll("button")) {
                if (own.contains(candidate) === false)
                    all.push(candidate);
            }
            return all.length === 0 ? null : all[all.length - 1];
        }
        //#endregion
        //#region 图标
        /**
         * 「继续」图标：圆里一个播放三角。
         *
         * 路径**照抄官方** `IconPlayOutlineRegular`（`dsh-client-ui-primitives`）的 artwork，
         * 只把 `strokeWidth` 定为官方 medium 档（1.3）——比 regular 的 1 在 16px 下更清楚，
         * 也贴近官方发送箭头的视觉重量。**刻意不 require `ui-primitives`**：官方 practices
         * 明确要求自备控件（那个包是私有实现，改版无通知）。
         * @returns 16×16 的 svg 元素。
         */
        function ContinueIcon() {
            return h("svg", {
                viewBox: "0 0 16 16",
                width: 16,
                height: 16,
                fill: "none",
                strokeWidth: 1.3,
                "aria-hidden": true,
            }, h("path", {
                d: "M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z",
                stroke: "currentColor",
            }), h("path", {
                d: "M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z",
                stroke: "currentColor",
            }));
        }
        //#endregion
        //#region 座位组件
        /**
         * 座位内部的错误边界——**这不是可选项**（硬规则 A）。
         *
         * single 座位的条目一旦抛错就被 DSH 退役（`reportEntryError(..., { abdicate: true })`），
         * 而且**要等页面刷新才会回来**。座位内部先兜住，失败降级成「什么都不渲染」：
         * 官方发送键还在原位，功能静默失效，但界面绝不缺一块。
         */
        class SeatBoundary extends react.Component {
            /** @param props - `children` 就是座位子树。 */
            constructor(props) {
                super(props);
                this.state = { failed: false };
            }
            /** React 边界协议：把抛出的错误转成状态。 */
            static getDerivedStateFromError() {
                return { failed: true };
            }
            /** 只打一条控制台记录，不弹任何 UI。 */
            componentDidCatch(error) {
                console.error(`[${PKG}] 座位渲染失败：`, error);
            }
            /** 正常时渲染子树；失败时渲染 null（官方主按钮留在原位）。 */
            render() {
                return this.state.failed ? null : this.props.children;
            }
        }
        /**
         * 「继续」按钮本体。
         *
         * 全部标准 Hook 都在这里**无条件**调用：本组件只在 `useChat` 可用时被挂载
         * （见 {@link ContinueSeat}），所以 Hook 数量在整个生命周期里恒定。
         * @param props - 座位标准 props：`useSession` / `useChat` / `useInput` /
         *   `useSessionStatus` / `inputActions` / `sessionId` / `locked` / `t`。
         */
        function ContinuePrimary(props) {
            const { useSession, useChat, useInput, useSessionStatus, inputActions, sessionId, locked, t } = props;
            // 状态源与官方主按钮**同一个**：`useSession((s) => s.running)`。
            const running = useSession((session) => session?.running === true) === true;
            // 待处理的交互（提问 / 审批）优先，别抢它的位置。
            const pendingInteraction = useSessionStatus((statuses) => sessionId === undefined ? false : statuses.get(sessionId)?.pendingInteraction !== undefined) === true;
            // 三个原始值选择器：草稿空、无附件、输入相位。选择器只回传原始值，
            // 打字时不会因为对象身份变化而白渲染。
            const draftEmpty = useInput((state) => state.draft.trim() === "") === true;
            const attachmentFree = useInput((state) => state.attachmentIds.length === 0) === true;
            const phase = useInput((state) => state.phase);
            // 最新一轮的结束原因（aborted / error / max-tokens / completed / null）。
            const reason = useChat((snapshot) => lastTurnReason(snapshot));
            const [busy, setBusy] = react.useState(false);
            const rootRef = react.useRef(null);
            const hiddenRef = react.useRef(null);
            const active = shouldContinue({
                locked: locked === true,
                running,
                pendingInteraction,
                phase,
                empty: draftEmpty && attachmentFree,
                reason,
            });
            /** 把官方主按钮放回来（幂等）。 */
            const restoreHidden = () => {
                const target = hiddenRef.current;
                hiddenRef.current = null;
                if (target !== null && target !== undefined)
                    target.style.display = "";
            };
            // 乐观提交期间自己闸一下：`running` 翻起来（或超时）就解除。
            react.useEffect(() => {
                if (!busy)
                    return undefined;
                if (running) {
                    setBusy(false);
                    return undefined;
                }
                const timer = setTimeout(() => setBusy(false), BUSY_TIMEOUT_MS);
                return () => clearTimeout(timer);
            }, [busy, running]);
            // 藏起官方主按钮：只在 `active` 为真时生效，卸载 / 状态一变立刻还原。
            // MutationObserver 兜住「React 重新挂载了那个 button」的情况（换会话、布局重排）。
            //
            // 依赖里带上 sessionId：常驻 composer 在切换会话时可能复用同一批 DOM 节点，
            // 那时 `active` 可能仍是 true、effect 不会重跑，闭包里的 card 就可能指向旧卡片。
            // 多跑一次的代价是零（幂等），少跑一次的代价是按钮藏在了别的会话上。
            react.useEffect(() => {
                if (!active)
                    return undefined;
                const own = rootRef.current;
                const card = own === null ? null : own.closest("[data-composer-card]");
                if (card === null)
                    return undefined;
                const hide = () => {
                    // 每次都重新解析：React 可能已经把这个节点换掉了。
                    const current = rootRef.current;
                    if (current === null)
                        return;
                    const target = officialSubmitButton(card, current);
                    if (target === null)
                        return;
                    hiddenRef.current = target;
                    target.style.display = "none";
                };
                hide();
                if (typeof MutationObserver !== "function")
                    return restoreHidden;
                const observer = new MutationObserver(hide);
                observer.observe(card, { childList: true, subtree: true });
                return () => {
                    observer.disconnect();
                    restoreHidden();
                };
            }, [active, sessionId]);
            if (!active)
                return null;
            const label = message(t, hintKey(reason), "继续任务");
            const onClick = () => {
                if (busy)
                    return;
                if (typeof inputActions?.setDraft !== "function")
                    return;
                if (typeof inputActions.submit !== "function")
                    return;
                setBusy(true);
                try {
                    // 两步都必须同步连做：`setDraft` 走 Lexical 的 discrete update（同步提交），
                    // 所以紧接着的 `submit()` 读到的就是这句「继续」。
                    // 万一将来它变成异步，最坏结果是草稿里留着「继续」+ 官方发送键复活，用户点一下即可。
                    inputActions.setDraft(CONTINUE_TEXT);
                    inputActions.submit();
                }
                catch (error) {
                    setBusy(false);
                    console.error(`[${PKG}] 继续失败：`, error);
                }
            };
            return h("button", {
                ref: rootRef,
                type: "button",
                className: "dsh-continue-primary",
                "data-dsh-continue": "primary",
                "aria-label": label,
                title: label,
                disabled: busy,
                // 与官方主按钮的 `keepFocus` 同一个意图：点按钮不把焦点从编辑器抢走。
                onMouseDown: (event) => event.preventDefault(),
                onClick,
            }, h(ContinueIcon, null));
        }
        /**
         * 座位入口：**只做可用性判断，不调用任何 Hook**。
         *
         * `useChat` 由 `dsh-client-ui-chat` 通过 `ctx.uiSession.provide({hooks: ["chat"]})` 提供。
         * 如果它比本条目晚挂载，标准 props 会从「没有 useChat」变成「有」——同一个组件实例
         * 的 Hook 数量就会变化，React 会直接报 "Rendered more hooks than during the previous render"。
         * 把判断放在这个不调用 Hook 的外层组件里，两种情况下渲染的是**不同的组件类型**，
         * React 会正常卸载/挂载，而不是在同一实例上换 Hook 数量。
         * @param props - 座位标准 props。
         * @returns 可用时渲染边界 + 按钮，否则 null。
         */
        function ContinueSeat(props) {
            if (typeof props.useChat !== "function")
                return null;
            return h(SeatBoundary, null, h(ContinuePrimary, props));
        }
        //#endregion
        //#region 插件体
        /**
         * 客户端插件体：占用官方声明的空座位 `conversation.input.activity`。
         * @param ctx - 客户端根上下文（`exports.inject` 已声明 slots / locale）。
         */
        function apply(ctx) {
            ctx.effect(() => installStyles(), `${PKG}: stylesheet`);
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PKG}: dictionaries`);
            // 该座位由 composer 的 `conversation.composer.bar` 条目声明（single，当前无人占用）。
            //
            // 用 priority -1 而不是默认 0：single 座位**同 priority 直接抛错**
            // （`ui-slots`：`single slot "…" already has a registration at priority 0`），
            // 一旦官方（或别的插件）哪天也占这一格，注册期抛错会让整个插件激活失败。
            // -1 的语义是「最低者渲染」，正好让我们稳定接管这一格；要交还只需在插件页里关掉本包。
            ctx.slots.inject("conversation.input.activity", () => ctx.slots.register({
                name: "conversation.input.activity",
                priority: -1,
                locale: NS,
            }, ContinueSeat));
        }
        /** 静态注入面：只用这两个客户端服务。 */
        exports.inject = ["slots", "locale"];
        exports.apply = apply;
        return module.exports;
    },
});
