/**
 * profile 补丁的**只读**校验（不写任何东西）：用官方同一个 `yaml` 解析器解析，
 * 并与备份逐条比对，证明本次改动**只是追加了 dsh-continue 那一个条目**。
 *
 * 用法：
 *   node tools/check-patch.mjs [补丁路径] [备份路径]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PATCH = process.argv[2] ?? "C:\\Users\\admin\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const BACKUP = process.argv[3];
const YAML_DIR = process.env.DSH_YAML_DIR ?? path.join(process.env.TEMP ?? "", "dsh-yaml");
const YAML_ENTRY = path.join(YAML_DIR, "dist", "index.js");

if (fs.existsSync(YAML_ENTRY) === false) {
	console.error(`找不到官方 yaml 解析器：${YAML_ENTRY}`);
	console.error("先解包：node --input-type=module -e \"…\"（见 AGENTS.md 第 7 节）");
	process.exit(2);
}
const YAML = await import(pathToFileURL(YAML_ENTRY).href);

const failures = [];
const text = fs.readFileSync(PATCH, "utf8");
let document;
try {
	document = YAML.parseDocument(text, { merge: true });
	if (document.errors.length > 0) for (const error of document.errors) failures.push(`YAML 解析错误：${error.message}`);
} catch (error) {
	failures.push(`YAML 抛错：${error.message}`);
}
const parsed = document?.toJS?.() ?? null;
if (Array.isArray(parsed) === false) failures.push("顶层不是序列（补丁层必须是数组）");

/** 把补丁里的条目摊平成 `{id, name}` 列表，便于逐条比对。 */
function flattenEntries(list) {
	const out = [];
	for (const entry of list ?? []) {
		if (entry === null || typeof entry !== "object") continue;
		if (Array.isArray(entry.insert)) {
			for (const inserted of entry.insert) out.push({ id: inserted?.id, name: inserted?.name });
			continue;
		}
		out.push({ id: entry.id, name: entry.name });
	}
	return out;
}

const entries = flattenEntries(parsed);
const ours = entries.filter((entry) => entry.id === "dsh-continue");
if (ours.length !== 1) failures.push(`dsh-continue 条目数量应为 1，实际 ${ours.length}`);
else {
	const expected = "file:///D:/project/dsh-plugins/dsh-continue/lib/index.js";
	if (ours[0].name !== expected) failures.push(`dsh-continue 的 name 应为 ${expected}，实际 ${String(ours[0].name)}`);
	const realPath = path.join("D:\\project\\dsh-plugins\\dsh-continue\\lib\\index.js");
	if (fs.existsSync(realPath) === false) failures.push(`路径行指向的文件不存在：${realPath}`);
}

if (BACKUP !== undefined) {
	const before = flattenEntries(YAML.parse(fs.readFileSync(BACKUP, "utf8")));
	const beforeKeys = before.map((entry) => `${entry.id}|${entry.name ?? ""}`);
	const afterKeys = entries.map((entry) => `${entry.id}|${entry.name ?? ""}`);
	const added = afterKeys.filter((key) => beforeKeys.includes(key) === false);
	const removed = beforeKeys.filter((key) => afterKeys.includes(key) === false);
	if (added.length !== 1 || added[0] !== `dsh-continue|file:///D:/project/dsh-plugins/dsh-continue/lib/index.js`) {
		failures.push(`相对备份新增的条目应为 dsh-continue 一条，实际 ${JSON.stringify(added)}`);
	}
	if (removed.length > 0) failures.push(`相对备份删掉了条目（不该发生）：${JSON.stringify(removed)}`);
	// 顺序也必须保持：备份里的条目序列必须是新序列的前缀
	const prefixOk = beforeKeys.every((key, index) => afterKeys[index] === key);
	if (prefixOk === false) failures.push("备份里的条目序列不是新序列的前缀（顺序被改动了）");
	console.log(`备份 ${before.length} 条 → 现在 ${entries.length} 条（新增 ${added.length}，删除 ${removed.length}）`);
}

console.log(`补丁：${PATCH}`);
console.log(`条目总数：${entries.length}`);
if (failures.length === 0) {
	console.log("补丁校验通过 ✓");
	process.exit(0);
}
for (const failure of failures) console.error(`  x ${failure}`);
console.error(`补丁校验失败：${failures.length} 项`);
process.exit(1);
