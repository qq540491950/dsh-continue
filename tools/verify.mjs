/**
 * 离线自检：**纯 Node、零依赖**，直接跑真实的 `lib/client.js`（不是复制品）。
 *
 * 用法：
 *   node tools/verify.mjs
 *
 * 覆盖五组：
 *   A 包清单契约（投递链路要读的那几项）
 *   B 宿主半边（零 import、可加载、空 apply 不抛）
 *   C 客户端模块协议（真跑 factory、真跑 apply、断言座位注册与注入的样式表）
 *   D 行为（迷你渲染器 + 假 DOM：状态判定、藏/还原官方主按钮、点击提交、错误边界、降级）
 *   E 反向验证（往源码里注入违规，确认上面的断言**真的**会报出来，然后还原）
 *
 * 设计纪律（见 AGENTS.md 第 4 节）：
 * - 断言不许「永远为真」；D 组每条都必须能被注入打破（E 组逐条证明）。
 * - 不许为了让断言变绿而放宽断言。
 * - 迷你渲染器只实现本插件用到的 React 子集；它测的是**真源码**，不是替身实现。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_PATH = path.join(ROOT, "lib", "client.js");
const HOST_PATH = path.join(ROOT, "lib", "index.js");
const MANIFEST_PATH = path.join(ROOT, "package.json");

//#region 假 DOM
/** 选择器匹配：只支持本插件与假 DOM 用到的那几种（tag / [attr] / tag[attr="v"]）。 */
function matchesSelector(node, selector) {
	const attrForm = /^([A-Za-z]*)\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
	if (attrForm !== null) {
		const [, tag, attr, value] = attrForm;
		if (tag !== "" && node.tagName !== tag.toUpperCase()) return false;
		if (Object.prototype.hasOwnProperty.call(node.attrs, attr) === false) return false;
		if (value !== undefined && String(node.attrs[attr]) !== value) return false;
		return true;
	}
	return node.tagName === selector.toUpperCase();
}

/** camelCase → kebab-case（dataset 映射用）。 */
function kebabCase(name) {
	return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * `dataset` 必须是「写到 data-* 属性上」的活映射——真实 DOM 就是这么工作的，
 * 而 `installStyles` 正是靠 `tag.dataset.pluginCss = …` 让 HMR 台账与
 * `document.querySelector('style[data-plugin-css=…]')` 找得到这张样式表。
 */
function createDataset(node) {
	return new Proxy(
		{},
		{
			set(_target, key, value) {
				node.attrs[`data-${kebabCase(String(key))}`] = String(value);
				return true;
			},
			get(_target, key) {
				return node.attrs[`data-${kebabCase(String(key))}`];
			},
			has(_target, key) {
				return `data-${kebabCase(String(key))}` in node.attrs;
			},
			deleteProperty(_target, key) {
				delete node.attrs[`data-${kebabCase(String(key))}`];
				return true;
			},
		},
	);
}

/** 一个够用的假 DOM 节点。 */
function fakeNode(tagName, attrs) {
	const node = {
		tagName: tagName.toUpperCase(),
		attrs: { ...(attrs ?? {}) },
		style: {},
		children: [],
		parentElement: null,
		textContent: "",
		get parentNode() {
			return this.parentElement;
		},
		getAttribute(name) {
			return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
		},
		setAttribute(name, value) {
			this.attrs[name] = String(value);
		},
		removeAttribute(name) {
			delete this.attrs[name];
		},
		appendChild(child) {
			if (child.parentElement !== null) child.parentElement.removeChild(child);
			child.parentElement = this;
			this.children.push(child);
			return child;
		},
		removeChild(child) {
			const index = this.children.indexOf(child);
			if (index >= 0) this.children.splice(index, 1);
			child.parentElement = null;
			return child;
		},
		contains(other) {
			for (let cursor = other; cursor !== null && cursor !== undefined; cursor = cursor.parentElement) {
				if (cursor === this) return true;
			}
			return false;
		},
		closest(selector) {
			for (let cursor = this; cursor !== null; cursor = cursor.parentElement) {
				if (matchesSelector(cursor, selector)) return cursor;
			}
			return null;
		},
		matches(selector) {
			return matchesSelector(this, selector);
		},
		querySelectorAll(selector) {
			const out = [];
			const walk = (current) => {
				for (const child of current.children) {
					if (matchesSelector(child, selector)) out.push(child);
					walk(child);
				}
			};
			walk(this);
			return out;
		},
	};
	node.dataset = createDataset(node);
	return node;
}

/** 一个够用的假 document（installStyles 只用到 head / createElement / querySelector）。 */
function fakeDocument() {
	const head = fakeNode("head");
	const body = fakeNode("body");
	return {
		head,
		body,
		createElement(tagName) {
			return fakeNode(tagName);
		},
		querySelector(selector) {
			return head.querySelectorAll(selector)[0] ?? body.querySelectorAll(selector)[0] ?? null;
		},
		querySelectorAll(selector) {
			return [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)];
		},
	};
}
//#endregion

//#region 迷你 React + 迷你渲染器
/**
 * 只实现本插件用到的 React 子集：`createElement` / `useState` / `useRef` / `useEffect` /
 * `Component`（含 `getDerivedStateFromError` 错误边界协议）。
 *
 * 组件实例按「树位置」复用（Hook 才有地方存），宿主节点每次渲染重建（够用且简单）。
 */
function createMiniReact() {
	const state = { current: null, dirty: false, effectQueue: [] };
	let rootElement = null;
	let rootInstance = null;
	let lastNode;
	let onCommit = null;

	/** 基类：只支持 state + setState。 */
	function Component(props) {
		this.props = props;
		this.state = {};
	}
	Component.prototype.setState = function setState(patch) {
		const next = typeof patch === "function" ? patch(this.state, this.props) : patch;
		this.state = { ...this.state, ...next };
		state.dirty = true;
	};

	function createElement(type, props, ...children) {
		const flat = [];
		const push = (child) => {
			if (child === null || child === undefined || child === false || child === true) return;
			if (Array.isArray(child)) {
				for (const item of child) push(item);
				return;
			}
			flat.push(child);
		};
		for (const child of children) push(child);
		const merged = { ...(props ?? {}) };
		merged.children = flat.length === 1 ? flat[0] : flat;
		return { type, props: merged, children: flat };
	}

	function useState(initial) {
		const instance = state.current;
		const index = instance.hookIndex;
		instance.hookIndex += 1;
		if (instance.hooks[index] === undefined) {
			const hook = { value: typeof initial === "function" ? initial() : initial };
			hook.set = (next) => {
				const value = typeof next === "function" ? next(hook.value) : next;
				if (Object.is(value, hook.value)) return;
				hook.value = value;
				state.dirty = true;
			};
			instance.hooks[index] = hook;
		}
		return [instance.hooks[index].value, instance.hooks[index].set];
	}

	function useRef(initial) {
		const instance = state.current;
		const index = instance.hookIndex;
		instance.hookIndex += 1;
		if (instance.hooks[index] === undefined) instance.hooks[index] = { current: initial };
		return instance.hooks[index];
	}

	function useEffect(create, deps) {
		const instance = state.current;
		const index = instance.hookIndex;
		instance.hookIndex += 1;
		const previous = instance.hooks[index];
		const changed =
			previous === undefined ||
			deps === undefined ||
			previous.deps === undefined ||
			deps.length !== previous.deps.length ||
			deps.some((dep, at) => Object.is(dep, previous.deps[at]) === false);
		const hook = previous ?? { deps: undefined, cleanup: undefined, create: undefined };
		hook.deps = deps;
		hook.create = create;
		instance.hooks[index] = hook;
		if (changed) state.effectQueue.push(hook);
	}

	/** 宿主元素的 props → 假节点（只做本插件用到的那几种）。 */
	function applyProps(node, props) {
		for (const [key, value] of Object.entries(props)) {
			if (key === "children") continue;
			if (key === "ref") {
				if (typeof value === "function") value(node);
				else if (value !== null && value !== undefined) value.current = node;
				continue;
			}
			if (key === "style") {
				Object.assign(node.style, value ?? {});
				continue;
			}
			if (key.startsWith("on") && typeof value === "function") {
				node.handlers = node.handlers ?? {};
				node.handlers[key] = value;
				continue;
			}
			node.attrs[key] = value === true ? "true" : value;
		}
	}

	function renderVNode(previous, vnode) {
		if (vnode === null || vnode === undefined || vnode === false || vnode === true) {
			if (previous !== null && previous !== undefined) dispose(previous);
			return { instance: null, node: null };
		}
		if (typeof vnode === "string" || typeof vnode === "number") {
			return { instance: null, node: { text: String(vnode) } };
		}
		const type = vnode.type;
		// 类型变了 = React 卸载旧实例（跑它的 cleanup）再挂新的；同一类型才复用 Hook 槽。
		const reusable = previous !== null && previous !== undefined && previous.type === type;
		if (reusable === false && previous !== null && previous !== undefined) dispose(previous);
		const instance = reusable ? previous : { type, hooks: [], children: [] };

		// 宿主元素
		if (typeof type === "string") {
			const node = fakeNode(type);
			applyProps(node, vnode.props);
			const rendered = vnode.children.map((child, index) => renderVNode(instance.children[index], child));
			// 存的是**子实例**（不是 {instance,node} 包装）——存错会让下一轮全部重新挂载、Hook 状态清零。
			instance.children = rendered.map((child) => child.instance);
			for (const child of rendered) if (child.node !== null) node.appendChild(child.node);
			return { instance, node };
		}

		// 类组件（错误边界）
		if (type.prototype !== undefined && typeof type.prototype.render === "function") {
			const component = instance.component ?? new type(vnode.props);
			instance.component = component;
			component.props = vnode.props;
			let rendered;
			try {
				rendered = renderVNode(instance.children[0], component.render());
			} catch (error) {
				if (typeof type.getDerivedStateFromError !== "function") throw error;
				component.state = { ...component.state, ...type.getDerivedStateFromError(error) };
				if (typeof component.componentDidCatch === "function") component.componentDidCatch(error);
				rendered = renderVNode(instance.children[0], component.render());
			}
			instance.children = [rendered.instance];
			return { instance, node: rendered.node };
		}

		// 函数组件
		const outer = state.current;
		state.current = instance;
		instance.hookIndex = 0;
		let out;
		try {
			out = type(vnode.props);
		} finally {
			state.current = outer;
		}
		const rendered = renderVNode(instance.children[0], out);
		instance.children = [rendered.instance];
		return { instance, node: rendered.node };
	}

	/** 提交阶段：先跑旧 cleanup，再跑新 effect。 */
	function commitEffects() {
		const queue = state.effectQueue;
		state.effectQueue = [];
		for (const hook of queue) {
			if (typeof hook.cleanup === "function") hook.cleanup();
			hook.cleanup = hook.create();
		}
	}

	/** 卸载整棵树：自底向上跑 cleanup。 */
	function dispose(instance) {
		if (instance === null || instance === undefined) return;
		for (const child of instance.children ?? []) dispose(child);
		for (const hook of instance.hooks ?? []) {
			if (typeof hook.cleanup === "function") hook.cleanup();
			hook.cleanup = undefined;
		}
	}

	function pass() {
		state.effectQueue = [];
		const rendered = renderVNode(rootInstance, rootElement);
		rootInstance = rendered.instance;
		lastNode = rendered.node;
		// 真实 React 的顺序：先把节点插进 DOM（commit），再跑 passive effect。
		// 这一步必须在 commitEffects 之前——组件里的 effect 会顺着 parentElement 往上找 composer 卡片。
		if (typeof onCommit === "function") onCommit(rendered.node);
		commitEffects();
		return rendered.node;
	}

	return {
		react: { createElement, useState, useRef, useEffect, Component },
		/** 每次渲染把根节点交给外部（插进 fixture 的 activity 格）——在 effect 之前调用。 */
		setOnCommit(callback) {
			onCommit = callback;
		},
		/** 换根元素（外部 props 源变了时重建 vnode；实例仍按类型复用）。 */
		setElement(element) {
			rootElement = element;
		},
		/** 首次挂载，返回根宿主节点。 */
		mount(element) {
			rootElement = element;
			rootInstance = null;
			state.dirty = false;
			return pass();
		},
		/** 跑完 setState 攒下的重渲染（最多 20 轮，防死循环）；返回最新的根节点。 */
		flush() {
			let guard = 0;
			while (state.dirty && guard < 20) {
				state.dirty = false;
				pass();
				guard += 1;
			}
			return lastNode;
		},
		/** 强制重渲染一次（外部改了 props 源时用）。 */
		forceRender() {
			state.dirty = true;
			return this.flush();
		},
		/** 整树卸载（跑 cleanup）。 */
		unmount() {
			dispose(rootInstance);
			rootInstance = null;
			state.dirty = false;
		},
	};
}
//#endregion

//#region 加载真实 bundle
/** 把真实的 `lib/client.js` 装进 vm，用假 `window.__ModuleLoader__` 抓注册项。 */
function loadBundle(source, options = {}) {
	const document = fakeDocument();
	const timers = { seq: 0, pending: new Map() };
	const observers = [];
	const required = [];
	const loggedErrors = [];
	let captured = null;
	const mini = createMiniReact();
	// 沙箱里的 console.error 收进数组：一来断言「边界确实上报了」，二来不把自检输出刷成一片红。
	const sandboxConsole = {
		log: () => {},
		info: () => {},
		warn: () => {},
		debug: () => {},
		error: (...args) => {
			loggedErrors.push(args);
		},
	};
	const sandbox = {
		document,
		console: sandboxConsole,
		setTimeout: (fn, ms) => {
			const id = (timers.seq += 1);
			timers.pending.set(id, { fn, ms });
			return id;
		},
		clearTimeout: (id) => {
			timers.pending.delete(id);
		},
		window: {
			__ModuleLoader__: {
				load(definition) {
					captured = definition;
				},
			},
		},
	};
	if (options.noObserver !== true) {
		sandbox.MutationObserver = class FakeMutationObserver {
			constructor(callback) {
				this.callback = callback;
				this.disconnected = false;
				observers.push(this);
			}
			observe() {}
			disconnect() {
				this.disconnected = true;
			}
			/** 手动触发一次（模拟 React 重新挂载了官方主按钮）。 */
			fire() {
				this.callback([]);
			}
		};
	}
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "lib/client.js" });
	if (captured === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
	const moduleExports = captured.factory((specifier) => {
		required.push(specifier);
		if (specifier === "react") return mini.react;
		throw new Error(`测试替身没有提供模块 "${specifier}"`);
	});
	return {
		definition: captured,
		exports: moduleExports,
		required,
		document,
		renderer: mini,
		observers,
		loggedErrors,
		h: mini.react.createElement,
		/** 跑掉所有待触发的定时器（测 busy 超时用）。 */
		fireTimers() {
			const pending = [...timers.pending.values()];
			timers.pending.clear();
			for (const timer of pending) timer.fn();
		},
		pendingTimers: () => timers.pending.size,
	};
}

/** 用假 ctx 跑真实 `apply`，收集注册项。 */
function applyPlugin(bundle, options = {}) {
	const ctx = {
		injectKeys: [],
		registrations: [],
		dictionaries: [],
		effects: [],
		effect(create, label) {
			ctx.effects.push(label);
			const dispose = create();
			return () => {
				if (typeof dispose === "function") dispose();
			};
		},
		locale: {
			register(namespace, dicts) {
				ctx.dictionaries.push({ namespace, dicts });
				return () => {};
			},
		},
		slots: {
			inject(key, callback) {
				ctx.injectKeys.push(key);
				if (options.deferInject !== true) callback();
				return () => {};
			},
			register(registration, component) {
				ctx.registrations.push({ registration, component });
				return () => {};
			},
		},
	};
	bundle.exports.apply(ctx);
	return ctx;
}
//#endregion

//#region 座位场景
/** 造一个 composer 卡片：`.trailing` 里 [standardControls, activity, 官方主按钮]。 */
function createFixture() {
	const card = fakeNode("div", { "data-composer-card": "true" });
	const row = fakeNode("div");
	const tools = fakeNode("div");
	const trailing = fakeNode("div");
	const standardControls = fakeNode("div");
	const activity = fakeNode("div");
	const official = fakeNode("button", { class: "official-primary", "aria-label": "发送消息" });
	card.appendChild(row);
	row.appendChild(tools);
	row.appendChild(trailing);
	trailing.appendChild(standardControls);
	trailing.appendChild(activity);
	trailing.appendChild(official);
	return { card, row, tools, trailing, standardControls, activity, official };
}

/** 造一份 Chat target 快照（只带 timeline）。`reason === "none"` 表示还没有结束的轮次。 */
function chatSnapshot(reason) {
	if (reason === "none") return { timeline: { turnOrder: [], turns: new Map() } };
	return {
		timeline: {
			turnOrder: [1],
			turns: new Map([[1, { status: "closed", end: { data: { reason: { kind: reason } } } }]]),
		},
	};
}

/**
 * 渲染一次「继续」座位：真加载 bundle → 真跑 apply → 真渲染注册出来的组件。
 * @param source - client.js 源码。
 * @param scenario - 初始状态；之后用 `harness.set({...})` 改。
 */
function mountSeat(source, scenario = {}) {
	const bundle = loadBundle(source, { noObserver: scenario.noObserver === true });
	const ctx = applyPlugin(bundle);
	const entry = ctx.registrations[0];
	if (entry === undefined) throw new Error("apply 没有注册任何座位条目");
	const fixture = createFixture();
	const calls = [];
	const state = {
		sessionId: "s1",
		running: scenario.running === true,
		locked: scenario.locked === true,
		pendingInteraction: scenario.pendingInteraction === true,
		draft: scenario.draft ?? "",
		attachments: scenario.attachments ?? 0,
		phase: scenario.phase ?? "plain",
		reason: scenario.reason ?? "completed",
	};
	const chatMode = scenario.chat ?? "ok";
	const props = {
		locked: scenario.locked === true,
		// `t` 显式传 undefined 时才走兜底（不能用 `scenario.t === undefined` 判断，那和「没传」分不开）。
		t: "t" in scenario ? scenario.t : (key) => `T:${key}`,
		useSession: (selector) => selector({ running: state.running === true }),
		useSessionStatus: (selector) =>
			selector(
				new Map([
					[
						"s1",
						{
							running: state.running === true,
							pendingInteraction: state.pendingInteraction === true ? {} : undefined,
						},
					],
				]),
			),
		useInput: (selector) =>
			selector({
				draft: state.draft,
				attachmentIds: new Array(state.attachments).fill("att"),
				phase: state.phase,
			}),
		useChat: (selector) => {
			if (chatMode === "throwing") throw new Error("chat hook 不可用");
			return selector(chatSnapshot(state.reason));
		},
	};
	if (chatMode === "missing") delete props.useChat;
	// sessionId 必须跟着 state 走（换会话的用例要能改它）。
	Object.defineProperty(props, "sessionId", {
		enumerable: true,
		get: () => state.sessionId,
	});
	if (scenario.noInputActions !== true) {
		props.inputActions = {
			setDraft: (text) => calls.push(["setDraft", text]),
			submit: () => calls.push(["submit"]),
		};
	}

	const attach = (node) => {
		for (const child of [...fixture.activity.children]) fixture.activity.removeChild(child);
		if (node !== null && node !== undefined) fixture.activity.appendChild(node);
	};
	// 关键顺序：节点必须在 effect 之前进 DOM，否则组件顺着 parentElement 找不到卡片。
	bundle.renderer.setOnCommit(attach);
	bundle.renderer.mount(bundle.h(entry.component, props));

	return {
		bundle,
		ctx,
		entry,
		fixture,
		calls,
		state,
		props,
		/** 当前渲染出来的「继续」按钮，或 null。 */
		button() {
			return fixture.activity.querySelectorAll("button")[0] ?? null;
		},
		officialHidden() {
			return fixture.official.style.display === "none";
		},
		/** 跑完 setState 攒下的重渲染（onCommit 会负责重新挂载）。 */
		flush() {
			bundle.renderer.flush();
		},
		/** 改状态并强制重渲染（重建 vnode：props 是元素创建时快照的，改了状态必须重建）。 */
		set(patch) {
			Object.assign(state, patch);
			bundle.renderer.setElement(bundle.h(entry.component, props));
			bundle.renderer.forceRender();
		},
		unmount() {
			bundle.renderer.unmount();
		},
	};
}
//#endregion

//#region 断言工具
/** 一次套件运行的失败收集器。 */
function createReporter() {
	const failures = [];
	let passed = 0;
	return {
		ok(group, label, condition, detail) {
			if (condition === true) {
				passed += 1;
				return true;
			}
			failures.push(`[${group}] ${label}${detail === undefined ? "" : ` — ${detail}`}`);
			return false;
		},
		failures,
		get passed() {
			return passed;
		},
	};
}
//#endregion

//#region 套件
/**
 * 跑完整套断言。
 * @param sources - `{client, host}` 两份源码（E 组会喂被注入过的版本）。
 * @param manifest - package.json 解析结果。
 * @returns `{ failures, passed }`。
 */
async function runSuite(sources, manifest) {
	const source = sources.client;
	const hostSource = sources.host;
	const report = createReporter();
	const ok = report.ok.bind(report);
	const packageName = manifest.name;
	const bundleIdMatch = /id:\s*"([^"]+)"/.exec(source);

	// ---- A 包清单契约 ----
	ok("A", "name 是非作用域裸包名", /^[^/@:]+$/.test(packageName ?? ""), `实际 ${JSON.stringify(packageName)}`);
	ok("A", 'exports["./client"] 指向 lib/client.js', manifest.exports?.["./client"] === "./lib/client.js");
	ok("A", 'exports["./package.json"] 已声明', manifest.exports?.["./package.json"] === "./package.json");
	ok("A", 'dsh.client.platform === "web"', manifest.dsh?.client?.platform === "web");
	ok("A", "main 指向宿主半边", manifest.main === "lib/index.js");
	ok("A", "bundle id 等于包名", bundleIdMatch !== null && bundleIdMatch[1] === packageName);
	ok("A", "零运行时依赖（没有 dependencies）", manifest.dependencies === undefined);
	ok("A", "manifest 引用的文件都存在", fs.existsSync(path.join(ROOT, manifest.exports["."])) && fs.existsSync(CLIENT_PATH));

	// ---- B 宿主半边 ----
	ok("B", "宿主半边零 import / 零 require", /(^|\n)\s*(import\s|const\s+.*require\()/.test(hostSource) === false);
	// 用 data: URL 就地求值（E 组注入过的版本也要能被求值，不能只 import 磁盘文件）。
	const hostModule = await import(`data:text/javascript;base64,${Buffer.from(hostSource, "utf8").toString("base64")}`);
	ok("B", "宿主半边导出 apply 函数", typeof hostModule.apply === "function");
	let hostThrew = false;
	try {
		hostModule.apply();
	} catch {
		hostThrew = true;
	}
	ok("B", "空 apply 不抛", hostThrew === false);

	// ---- C 客户端模块协议 ----
	const probe = loadBundle(source);
	ok("C", "id 等于包名", probe.definition.id === packageName, `实际 ${String(probe.definition.id)}`);
	ok("C", "factory 是函数", typeof probe.definition.factory === "function");
	ok(
		"C",
		"require 面只有 react（不 require 官方 Client 包）",
		probe.required.length === 1 && probe.required[0] === "react",
		`实际 ${JSON.stringify(probe.required)}`,
	);
	ok(
		"C",
		"静态注入面是 slots + locale",
		Array.isArray(probe.exports.inject) &&
			probe.exports.inject.length === 2 &&
			probe.exports.inject[0] === "slots" &&
			probe.exports.inject[1] === "locale",
		`实际 ${JSON.stringify(probe.exports.inject)}`,
	);
	const applied = applyPlugin(probe);
	ok("C", "座位注入走 slots.inject", applied.injectKeys.length === 1 && applied.injectKeys[0] === "conversation.input.activity");
	ok("C", "只注册一个座位条目", applied.registrations.length === 1);
	const registration = applied.registrations[0]?.registration;
	ok("C", "注册到 conversation.input.activity", registration?.name === "conversation.input.activity");
	ok("C", "priority 必须是 -1（同 priority 会抛错）", registration?.priority === -1, `实际 ${JSON.stringify(registration?.priority)}`);
	ok("C", "注册声明 locale 命名空间", registration?.locale === "dsh-continue");
	ok("C", "注册的组件是函数", typeof applied.registrations[0]?.component === "function");
	const dicts = applied.dictionaries[0];
	ok("C", "注册了 dsh-continue 词典", dicts?.namespace === "dsh-continue");
	const zhKeys = Object.keys(dicts?.dicts?.zh ?? {}).sort();
	const enKeys = Object.keys(dicts?.dicts?.en ?? {}).sort();
	ok("C", "词典 zh / en 都有内容", zhKeys.length > 0);
	ok("C", "词典 zh / en key 集合一致", JSON.stringify(zhKeys) === JSON.stringify(enKeys));
	ok("C", "词典覆盖三种结束原因 + 兜底", zhKeys.includes("action.continue.stopped") && zhKeys.includes("action.continue.failed") && zhKeys.includes("action.continue.truncated") && zhKeys.includes("action.continue"));
	const styleTags = probe.document.head.querySelectorAll('style[data-plugin-css="dsh-continue/ContinueButton.css"]');
	ok("C", "注入了一张样式表", styleTags.length === 1, `实际 ${styleTags.length}`);
	const cssText = styleTags[0]?.textContent ?? "";
	ok("C", "样式表带 data-plugin 标记", styleTags[0]?.getAttribute("data-plugin") === "dsh-continue");
	ok(
		"C",
		"样式抄官方主按钮（品牌填充 / 34px / hover / disabled）",
		cssText.includes("--dsw-alias-button-info-fill") &&
			cssText.includes("--dsw-alias-button-info-hover") &&
			cssText.includes("width:34px") &&
			cssText.includes("height:34px") &&
			cssText.includes(":hover") &&
			cssText.includes(":disabled"),
	);
	ok("C", "样式表不含裸主题色以外的硬编码色（只允许官方那一个 #fff）", (cssText.match(/#[0-9a-fA-F]{3,8}/g) ?? []).every((hex) => hex.toLowerCase() === "#fff"));
	// 幂等：再跑一次 apply，不应再插一张
	applyPlugin(probe);
	ok("C", "重复 apply 不会重复注入样式表", probe.document.head.querySelectorAll("style").length === 1);
	// 座位尚未声明时不许直接 register
	const deferred = applyPlugin(loadBundle(source), { deferInject: true });
	ok("C", "座位未声明时不注册（走 slots.inject 等待）", deferred.registrations.length === 0 && deferred.injectKeys.length === 1);

	// ---- D 行为 ----
	const visible = (reason, extra) => {
		const seat = mountSeat(source, { reason, ...extra });
		return { seat, shown: seat.button() !== null, hidden: seat.officialHidden() };
	};

	for (const reason of ["completed", "none"]) {
		const probeSeat = visible(reason);
		ok("D", `正常结束（${reason}）不接管主按钮`, probeSeat.shown === false && probeSeat.hidden === false);
		probeSeat.seat.unmount();
	}
	for (const reason of ["aborted", "error", "max-tokens"]) {
		const probeSeat = visible(reason);
		ok("D", `异常结束（${reason}）渲染继续按钮并藏起官方主按钮`, probeSeat.shown === true && probeSeat.hidden === true);
		probeSeat.seat.unmount();
	}
	const runningSeat = visible("aborted", { running: true });
	ok("D", "运行中不接管主按钮", runningSeat.shown === false && runningSeat.hidden === false);
	runningSeat.seat.unmount();
	const draftSeat = visible("aborted", { draft: "我自己的话" });
	ok("D", "草稿非空时让位给发送键", draftSeat.shown === false && draftSeat.hidden === false);
	draftSeat.seat.unmount();
	const attachSeat = visible("aborted", { attachments: 1 });
	ok("D", "有附件时让位给发送键", attachSeat.shown === false && attachSeat.hidden === false);
	attachSeat.seat.unmount();
	const phaseSeat = visible("aborted", { phase: "submitting" });
	ok("D", "输入机非 plain 相位时不接管", phaseSeat.shown === false && phaseSeat.hidden === false);
	phaseSeat.seat.unmount();
	const lockedSeat = visible("aborted", { locked: true });
	ok("D", "composer 被锁时不接管", lockedSeat.shown === false && lockedSeat.hidden === false);
	lockedSeat.seat.unmount();
	const pendingSeat = visible("aborted", { pendingInteraction: true });
	ok("D", "有待处理交互时不接管", pendingSeat.shown === false && pendingSeat.hidden === false);
	pendingSeat.seat.unmount();
	const blankSeat = visible("aborted", { draft: "   " });
	ok("D", "纯空白草稿视为空", blankSeat.shown === true);
	blankSeat.seat.unmount();

	// 点击 → 提交「继续」
	const clickSeat = mountSeat(source, { reason: "aborted" });
	const clickButton = clickSeat.button();
	ok("D", "继续按钮是 button 且带 data 标记", clickButton?.tagName === "BUTTON" && clickButton?.getAttribute("data-dsh-continue") === "primary");
	ok("D", "继续按钮的 aria-label 走 locale 文案", clickButton?.getAttribute("aria-label") === "T:action.continue.stopped", String(clickButton?.getAttribute("aria-label")));
	ok("D", "继续按钮的 title 与 aria-label 一致", clickButton?.getAttribute("title") === clickButton?.getAttribute("aria-label"));
	const icon = clickButton?.children[0];
	ok("D", "图标是 16×16 的 svg", icon?.tagName === "SVG" && icon?.getAttribute("viewBox") === "0 0 16 16");
	ok("D", "图标含两条 currentColor 描边路径（照抄官方 artwork）", icon?.children.length === 2 && icon.children.every((node) => node.getAttribute("stroke") === "currentColor"));
	clickButton?.handlers?.onClick?.();
	ok(
		"D",
		"点击后先 setDraft(\"继续\") 再 submit()",
		JSON.stringify(clickSeat.calls) === JSON.stringify([["setDraft", "继续"], ["submit"]]),
		JSON.stringify(clickSeat.calls),
	);
	clickSeat.flush();
	ok("D", "提交中按钮自己禁用（防连点排两条）", clickSeat.button()?.getAttribute("disabled") === "true");
	ok("D", "提交中官方主按钮仍被藏起", clickSeat.officialHidden() === true);
	clickSeat.bundle.fireTimers();
	clickSeat.flush();
	ok("D", "busy 超时后自动解除", clickSeat.button()?.getAttribute("disabled") === false);
	clickSeat.set({ running: true });
	ok("D", "会话开始跑之后：继续按钮消失、官方主按钮回来", clickSeat.button() === null && clickSeat.officialHidden() === false);
	clickSeat.unmount();

	// 卸载还原
	const unmountSeat = mountSeat(source, { reason: "error" });
	ok("D", "卸载前官方主按钮是藏着的", unmountSeat.officialHidden() === true);
	unmountSeat.unmount();
	ok("D", "卸载后官方主按钮还原", unmountSeat.officialHidden() === false);

	// 官方按钮被 React 换成新节点 → 观察者重新藏
	const swapSeat = mountSeat(source, { reason: "error" });
	ok("D", "观察者已挂上", swapSeat.bundle.observers.length === 1);
	const replacement = fakeNode("button", { class: "official-primary", "aria-label": "发送消息" });
	swapSeat.fixture.trailing.removeChild(swapSeat.fixture.official);
	swapSeat.fixture.trailing.appendChild(replacement);
	swapSeat.fixture.official = replacement;
	swapSeat.bundle.observers[0].fire();
	ok("D", "官方主按钮被换节点后观察者重新藏起", replacement.style.display === "none");
	swapSeat.unmount();

	// 换会话 → effect 依赖 sessionId，必须重新解析卡片并重挂观察者
	const switchSeat = mountSeat(source, { reason: "error" });
	ok("D", "换会话前观察者数量为 1", switchSeat.bundle.observers.length === 1);
	switchSeat.set({ sessionId: "s2" });
	ok("D", "换会话后旧观察者已断开", switchSeat.bundle.observers[0].disconnected === true);
	ok("D", "换会话后重新挂了观察者", switchSeat.bundle.observers.length === 2);
	ok("D", "换会话后官方主按钮仍然被藏起", switchSeat.officialHidden() === true);
	switchSeat.unmount();
	ok("D", "换会话后卸载仍能还原", switchSeat.officialHidden() === false);

	// 没有 MutationObserver 时的降级
	const noObserverSeat = mountSeat(source, { reason: "error", noObserver: true });
	ok("D", "环境没有 MutationObserver 时仍能藏起官方主按钮", noObserverSeat.officialHidden() === true);
	noObserverSeat.unmount();

	// 可用性 / 容错
	const noChatSeat = mountSeat(source, { reason: "error", chat: "missing" });
	ok("D", "useChat 缺失时渲染 null 且不抛", noChatSeat.button() === null && noChatSeat.officialHidden() === false);
	noChatSeat.unmount();
	let chatThrowPropagated = false;
	let chatThrowSeat = null;
	try {
		chatThrowSeat = mountSeat(source, { reason: "error", chat: "throwing" });
	} catch {
		chatThrowPropagated = true;
	}
	ok("D", "useChat 抛错被座位内边界兜住（不冒泡）", chatThrowPropagated === false);
	ok("D", "边界兜住后不渲染按钮、也不动官方主按钮", chatThrowSeat?.button() === null && chatThrowSeat?.officialHidden() === false);
	ok("D", "边界把失败原因上报到控制台（只一条）", chatThrowSeat?.bundle.loggedErrors.length === 1);
	chatThrowSeat?.unmount();
	const noActionsSeat = mountSeat(source, { reason: "error", noInputActions: true });
	let clickThrew = false;
	try {
		noActionsSeat.button()?.handlers?.onClick?.();
	} catch {
		clickThrew = true;
	}
	ok("D", "inputActions 缺失时点击不抛", clickThrew === false && noActionsSeat.calls.length === 0);
	noActionsSeat.unmount();
	const noTSeat = mountSeat(source, { reason: "error", t: undefined });
	ok("D", "t 缺失时退回中文兜底文案", noTSeat.button()?.getAttribute("aria-label") === "继续任务", String(noTSeat.button()?.getAttribute("aria-label")));
	noTSeat.unmount();
	const fallbackSeat = mountSeat(source, { reason: "error", t: () => "" });
	ok("D", "t 返回空串时退回中文兜底文案", fallbackSeat.button()?.getAttribute("aria-label") === "继续任务");
	fallbackSeat.unmount();

	return { failures: report.failures, passed: report.passed };
}
//#endregion

//#region 反向验证
/**
 * 往源码里注入违规，确认断言**真的**会报出来，然后还原。
 *
 * 两个自欺陷阱（AGENTS.md 第 4.3 节）必须避开：
 * 1. 锚点必须**恰好出现一次**，否则该用例无效（不能记成「没报出」）；
 * 2. 注入可能让套件**崩掉**（而不是报 FAIL）——那也必须单独判为用例无效。
 */
const MUTATIONS = [
	{ label: "座位 priority 改回 0", file: "client", from: "priority: -1,", to: "priority: 0,", expect: "[C] priority 必须是 -1" },
	{ label: "去掉 aborted 触发条件", file: "client", from: 'const RESUME_REASONS = ["aborted", "error", "max-tokens"];', to: 'const RESUME_REASONS = ["error", "max-tokens"];', expect: "异常结束（aborted）" },
	{ label: "草稿非空也照样接管", file: "client", from: "if (state.empty !== true) return false;", to: "if (state.empty === null) return false;", expect: "草稿非空时让位给发送键" },
	{ label: "运行中也接管", file: "client", from: "if (state.running === true) return false;", to: "if (state.running === null) return false;", expect: "运行中不接管主按钮" },
	{ label: "继续文本改成别的词", file: "client", from: 'const CONTINUE_TEXT = "继续";', to: 'const CONTINUE_TEXT = "go on";', expect: 'setDraft("继续")' },
	{ label: "点击只 setDraft 不 submit", file: "client", from: "\t\t\t\t\tinputActions.submit();", to: "\t\t\t\t\tvoid inputActions.submit;", expect: "再 submit()" },
	{ label: "去掉座位内错误边界", file: "client", from: "return h(SeatBoundary, null, h(ContinuePrimary, props));", to: "return h(ContinuePrimary, props);", expect: "useChat 抛错被座位内边界兜住" },
	{ label: "观察者不再重新藏按钮", file: "client", from: "const observer = new MutationObserver(hide);", to: "const observer = new MutationObserver(() => {});", expect: "官方主按钮被换节点后观察者重新藏起" },
	{ label: "换会话时不重挂观察者", file: "client", from: "}, [active, sessionId]);", to: "}, [active]);", expect: "换会话后重新挂了观察者" },
	{ label: "卸载不还原官方主按钮", file: "client", from: "\t\t\t\t\trestoreHidden();\n\t\t\t\t};", to: "\t\t\t\t\tvoid restoreHidden;\n\t\t\t\t};", expect: "卸载后官方主按钮还原" },
	{ label: "把正常结束也算成异常", file: "client", from: 'const RESUME_REASONS = ["aborted", "error", "max-tokens"];', to: 'const RESUME_REASONS = ["aborted", "error", "max-tokens", "completed"];', expect: "正常结束（completed）不接管主按钮" },
	{ label: "静态注入面漏掉 locale", file: "client", from: 'exports.inject = ["slots", "locale"];', to: 'exports.inject = ["slots"];', expect: "静态注入面是 slots + locale" },
	{ label: "bundle id 与包名不一致", file: "client", from: 'id: "dsh-continue",', to: 'id: "dsh-continue-typo",', expect: "id 等于包名" },
	{ label: "宿主半边引入 import", file: "host", from: "/** 空实现：只作为投递链路的接线柱。 */", to: 'import "node:fs";\n\n/** 空实现：只作为投递链路的接线柱。 */', expect: "宿主半边零 import" },
];

/** 跑反向验证，返回逐条结果。 */
async function runMutations(sources, manifest) {
	const results = [];
	for (const mutation of MUTATIONS) {
		const original = sources[mutation.file];
		const occurrences = original.split(mutation.from).length - 1;
		if (occurrences !== 1) {
			results.push({ label: mutation.label, status: "invalid", detail: `锚点出现 ${occurrences} 次（必须恰好 1 次）` });
			continue;
		}
		const mutated = { ...sources, [mutation.file]: original.replace(mutation.from, mutation.to) };
		let outcome;
		try {
			outcome = await runSuite(mutated, manifest);
		} catch (error) {
			results.push({ label: mutation.label, status: "invalid", detail: `注入后套件崩了：${error.message}` });
			continue;
		}
		const hit = outcome.failures.filter((failure) => failure.includes(mutation.expect));
		results.push({
			label: mutation.label,
			status: hit.length > 0 ? "caught" : "missed",
			detail: hit.length > 0 ? hit[0] : `没有报出包含「${mutation.expect}」的失败（共 ${outcome.failures.length} 条）`,
		});
	}
	return results;
}
//#endregion

//#region 入口
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const sources = { client: fs.readFileSync(CLIENT_PATH, "utf8"), host: fs.readFileSync(HOST_PATH, "utf8") };
const suite = await runSuite(sources, manifest);
const mutations = await runMutations(sources, manifest);

console.log("=".repeat(72));
console.log(`dsh-continue 自检：${suite.passed} 条断言通过，${suite.failures.length} 条失败`);
console.log("=".repeat(72));
for (const failure of suite.failures) console.log(`  x ${failure}`);
if (suite.failures.length === 0) console.log("  （正向断言全部通过）");

console.log("");
console.log("-".repeat(72));
console.log("反向验证（注入违规 → 断言必须报出 → 已还原）");
console.log("-".repeat(72));
let mutationFailures = 0;
for (const result of mutations) {
	const mark = result.status === "caught" ? "✓" : "x";
	if (result.status !== "caught") mutationFailures += 1;
	console.log(`  ${mark} ${result.label} —— ${result.detail}`);
}

console.log("");
const total = suite.failures.length + mutationFailures;
if (total === 0) {
	console.log(`全部通过 ✓（${suite.passed} 条断言 + ${mutations.length} 条反向验证）`);
	process.exit(0);
}
console.log(`失败 ${total} 项：正向 ${suite.failures.length} 条，反向 ${mutationFailures} 条`);
process.exit(1);
//#endregion
