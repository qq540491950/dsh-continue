/**
 * 宿主半边（Host half）。
 *
 * 这里**故意什么都不做**：它是一个空 `apply`，存在的唯一理由是当
 * `@deepseek-ai/dsh-client-modules` 的投递链路的**接线柱**——
 *
 *   1. Loader 条目（profile 补丁里的 `id: dsh-continue` + 指向本文件的 `name`）被启用；
 *   2. `dsh-client-modules` 从该条目的模块位置**向上找最近的 package.json**；
 *   3. 读它的 `dsh.client.platform === "web"`，再从 `exports["./client"]` 定位浏览器 bundle；
 *   4. Host 在 `/plugins` 下发布该 bundle，浏览器侧才会执行 `lib/client.js`。
 *
 * 所以：**这个文件不能删**。删了第 2 步就找不到清单，客户端半边永远不会投递，
 * 界面上什么都不会发生（而且没有任何报错）。
 *
 * 另外两条纪律（见 AGENTS.md 第 2 节）：
 * - **零 import / 零 require**：本文件由 Loader 以 `file:///...` 绝对路径加载，
 *   裸模块说明符都在 app.asar 里，从磁盘路径解析不到。
 * - 需要宿主侧能力时（这里不需要）只用注入进来的 Service，且必须 `ctx.effect` 注册清理。
 */

/** 空实现：只作为投递链路的接线柱。 */
export function apply() {}
