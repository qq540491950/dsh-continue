/**
 * app.asar 只读读取器（离线自检 / 取证用，零依赖）。
 *
 * 用法（Node 原生类型剥离，直接跑 TS）：
 *   node tools/asar.ts list <substr>            # 列出路径包含 substr 的条目
 *   node tools/asar.ts read <path-in-asar>      # 打印该文件（UTF-8）
 *   node tools/asar.ts grep <substr> <pattern>  # 在路径含 substr 的文件里按正则搜索
 *
 * 头部布局（见 dsh-skill-manager/README.md §9）：
 *   [0..3]   UInt32LE = 4
 *   [4..7]   UInt32LE = size pickle 的值
 *   [8..11]  UInt32LE = header string pickle 的 payload = 4 + strLen
 *   [12..15] UInt32LE = strLen
 *   [16..]   JSON 目录，随后是数据区
 *   数据区偏移 = 16 + strLen
 */
import fs from "node:fs";

/** asar 目录树里的一个节点（文件节点才有 size / offset）。 */
interface AsarNode {
	files?: Record<string, AsarNode>;
	size?: number;
	offset?: string | number;
}

/** 展平后的一个文件条目。 */
interface AsarFile {
	path: string;
	size: number;
	offset: string | number;
}

/** 打开后的归档句柄。 */
interface AsarArchive {
	fd: number;
	header: AsarNode;
	dataStart: number;
}

const ARCHIVE = process.env.DSH_ASAR ?? "D:\\Program Files\\DeepSeek Harness\\resources\\app.asar";

/** 打开 asar，返回 `{ header, dataStart, fd }`。 */
export function openArchive(file: string = ARCHIVE): AsarArchive {
	const fd = fs.openSync(file, "r");
	const sizeBuf = Buffer.alloc(16);
	fs.readSync(fd, sizeBuf, 0, 16, 0);
	const strLen = sizeBuf.readUInt32LE(12);
	const jsonBuf = Buffer.alloc(strLen);
	fs.readSync(fd, jsonBuf, 0, strLen, 16);
	return { fd, header: JSON.parse(jsonBuf.toString("utf8")) as AsarNode, dataStart: 16 + strLen };
}

/** 展平目录树 → `[{ path, size, offset }]`（只含文件）。 */
export function flatten(node: AsarNode, prefix = "", out: AsarFile[] = []): AsarFile[] {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const filePath = prefix === "" ? name : `${prefix}/${name}`;
		if (entry.files !== undefined) flatten(entry, filePath, out);
		else out.push({ path: filePath, size: entry.size ?? 0, offset: entry.offset ?? 0 });
	}
	return out;
}

/** 读 asar 内一个文件的内容。 */
export function readFile(archive: AsarArchive, path: string): Buffer {
	const entry = flatten(archive.header).find((item) => item.path === path);
	if (entry === undefined) throw new Error(`not in archive: ${path}`);
	const buf = Buffer.alloc(entry.size);
	fs.readSync(archive.fd, buf, 0, entry.size, archive.dataStart + Number(entry.offset));
	return buf;
}

/** 命令行入口。 */
function main(argv: string[]): void {
	const [command, ...rest] = argv;
	const archive = openArchive();
	const files = flatten(archive.header);
	if (command === "list") {
		const needle = rest[0] ?? "";
		for (const file of files.filter((item) => item.path.includes(needle))) {
			console.log(`${String(file.size).padStart(10)}  ${file.path}`);
		}
		return;
	}
	if (command === "read") {
		process.stdout.write(readFile(archive, rest[0]).toString("utf8"));
		return;
	}
	if (command === "grep") {
		const [needle, pattern] = rest;
		const re = new RegExp(pattern, "g");
		for (const file of files.filter((item) => item.path.includes(needle))) {
			const text = readFile(archive, file.path).toString("utf8");
			const lines = text.split("\n");
			lines.forEach((line, index) => {
				re.lastIndex = 0;
				if (re.test(line)) console.log(`${file.path}:${index + 1}: ${line.slice(0, 400)}`);
			});
		}
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && entrypoint.endsWith("asar.ts")) main(process.argv.slice(2));
