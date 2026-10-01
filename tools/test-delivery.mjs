// 用 esbuild 把交付模块测试打包成 ESM，再交给 node --test 运行。
import { build } from "esbuild";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "delivery-test-"));
const stubEnv = join(dir, "app-environment.js");
writeFileSync(stubEnv, "export const browser = true; export const dev = false; export const building = false; export const version = 'test';\n");

function collectTests(folder) {
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const full = join(folder, entry.name);
		if (entry.isDirectory()) return collectTests(full);
		return entry.name.endsWith(".test.ts") ? [full] : [];
	});
}

const entryPoints = collectTests(join(root, "src/lib/delivery"));
const entry = join(dir, "entry.mjs");
writeFileSync(entry, entryPoints.map((file) => `import ${JSON.stringify(file)};`).join("\n"));
const outfile = join(dir, "bundle.test.mjs");

const localStorageShim = `const __mem = new Map();
globalThis.localStorage = {
	getItem: (k) => (__mem.has(k) ? __mem.get(k) : null),
	setItem: (k, v) => __mem.set(k, String(v)),
	removeItem: (k) => __mem.delete(k),
	clear: () => __mem.clear()
};
`;

try {
	await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		outfile,
		logLevel: "warning",
		banner: { js: localStorageShim },
		alias: {
			"$app/environment": stubEnv,
			$lib: join(root, "src/lib")
		}
	});

	const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
