/**
 * 构建：`src/*.ts` → `lib/*.js`。
 *
 * 为什么不是 `tsc` 直接写 `lib/`：`dsh-client-hmr` 每 500ms 按 mtime/size 判版本，
 * 读到**写到一半**的 `lib/client.js` 会按「替换失败不回滚」处理，插件彻底消失
 * （AGENTS.md 2.4）。所以先编译到 `.build/`，校验通过后再**临时文件 + 原子替换**进 `lib/`。
 *
 * 用法：`npm run build`（`npm run verify` 会先跑一遍这个）。
 * 本文件由 Node 直接执行（原生类型剥离，不需要编译）：`node tools/build.ts`。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, ".build");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

/** 一条投递契约检查：`[说明, 判定函数]`。 */
type ArtifactCheck = [label: string, check: (text: string) => boolean];

/** 一个产物的落地契约：不过就不许写进 `lib/`。 */
interface Artifact {
	file: string;
	description: string;
	checks: ArtifactCheck[];
}

const ARTIFACTS: Artifact[] = [
	{
		file: "client.js",
		description: "浏览器半边（必须是 classic script）",
		checks: [
			["注册到 ModuleLoader", (text) => text.includes("window.__ModuleLoader__.load(")],
			["没有 import / export 语句", (text) => /(^|\n)\s*(import|export)\s/.test(text) === false],
			["没有 CJS / ESM 包装（__esModule）", (text) => text.includes("__esModule") === false],
			["id 与包名一致", (text) => text.includes('id: "dsh-continue"')],
		],
	},
	{
		file: "index.js",
		description: "宿主半边（ESM，零 import）",
		checks: [
			["导出 apply", (text) => /export function apply\s*\(/.test(text)],
			["没有 require", (text) => text.includes("require(") === false],
		],
	},
];

/** 先编译到 `.build/`：任何类型错误都在这一步失败，`lib/` 一个字节都不动。 */
function compile(): void {
	if (fs.existsSync(TSC) === false) {
		console.error(`找不到 TypeScript：${TSC}`);
		console.error("先装依赖：npm install");
		process.exit(2);
	}
	const result = spawnSync(process.execPath, [TSC, "-p", path.join(ROOT, "tsconfig.json")], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if (statusOf(result.status) !== 0) {
		console.error("");
		console.error("编译失败：lib/ 保持原样（不会写半截文件）。");
		process.exit(statusOf(result.status));
	}
}

/** `spawnSync` 的 status 可能是 null（被信号杀掉），统一成退出码。 */
function statusOf(status: number | null): number {
	return status === null ? 1 : status;
}

/** 原子替换：同目录临时文件 → rename，读者要么看到旧内容，要么看到新内容。 */
function writeAtomic(target: string, content: string): void {
	const temp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temp, content, "utf8");
	fs.renameSync(temp, target);
}

compile();

const failures: string[] = [];
for (const artifact of ARTIFACTS) {
	const source = path.join(OUT, artifact.file);
	if (fs.existsSync(source) === false) {
		failures.push(`${artifact.file}：tsc 没有产出（检查 tsconfig 的 rootDir / include）`);
		continue;
	}
	const text = fs.readFileSync(source, "utf8");
	for (const [label, check] of artifact.checks) {
		if (check(text) !== true) failures.push(`${artifact.file}：${label}`);
	}
	if (failures.length > 0) continue;
	const target = path.join(ROOT, "lib", artifact.file);
	writeAtomic(target, text);
	console.log(`  ✓ lib/${artifact.file}（${artifact.description}，${Buffer.byteLength(text, "utf8")} 字节）`);
}

if (failures.length > 0) {
	console.error("");
	for (const failure of failures) console.error(`  x ${failure}`);
	console.error(`构建失败：${failures.length} 项（lib/ 保持原样）`);
	process.exit(1);
}
console.log("构建完成 ✓");
