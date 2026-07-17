'use strict';
// Benchmarks grepTree() against the ripgrep CLI and a naive Node
// implementation on the same corpus. Usage:
//
//   node bench/grep-tree.js <root> [pattern...]
//
// Requires `npm run build:native && npm run prepare` first; the rg variant
// is skipped if ripgrep isn't installed.
const { readFile, readdir } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { grepTree } = require('../dist/index.js');

const root = process.argv[2];
const patterns =
	process.argv.length > 3 ? process.argv.slice(3) : ['fn\\s+\\w+', 'Result<'];
if (root === undefined) {
	console.error('usage: node bench/grep-tree.js <root> [pattern...]');
	process.exit(1);
}

// Variant 1: this library (searching on native walker threads).
async function libripgrep() {
	let files = 0;
	let lines = 0;
	for await (const result of grepTree(root, { patterns })) {
		files += 1;
		lines += result.matches.length;
	}
	return { files, lines };
}

// Variant 2: the ripgrep CLI, configured to match grepTree's defaults
// (--hidden, 4 threads, count of matching lines per file).
function rgCli() {
	const args = ['--no-config', '--hidden', '-j', '4', '-c'];
	for (const pattern of patterns) {
		args.push('-e', pattern);
	}
	const result = spawnSync('rg', [...args, root], { encoding: 'utf8' });
	if (result.error !== null && result.error !== undefined) {
		return null;
	}
	let files = 0;
	let lines = 0;
	for (const row of result.stdout.split('\n')) {
		const colon = row.lastIndexOf(':');
		if (colon !== -1) {
			files += 1;
			lines += Number(row.slice(colon + 1));
		}
	}
	return { files, lines };
}

// Variant 3: naive sequential Node — recursive readdir, readFile, and a
// JS RegExp per line, all on the main thread. Skips .git and NUL-containing
// files so the result counts stay comparable.
async function naive() {
	const regex = new RegExp(patterns.map((p) => `(?:${p})`).join('|'), 'u');
	let files = 0;
	let lines = 0;
	async function visit(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== '.git') {
					await visit(path);
				}
			} else if (entry.isFile()) {
				const data = await readFile(path);
				if (data.includes(0)) {
					continue;
				}
				let count = 0;
				for (const line of data.toString('utf8').split('\n')) {
					if (regex.test(line)) {
						count += 1;
					}
				}
				if (count > 0) {
					files += 1;
					lines += count;
				}
			}
		}
	}
	await visit(root);
	return { files, lines };
}

async function bench(name, fn) {
	const counts = await fn(); // warmup (also warms the page cache)
	if (counts === null) {
		console.log(`${name}: skipped (not available)`);
		return;
	}
	const times = [];
	for (let i = 0; i < 5; i++) {
		const start = process.hrtime.bigint();
		await fn();
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	times.sort((a, b) => a - b);
	console.log(
		`${name}: median ${times[2].toFixed(1)}ms (min ${times[0].toFixed(1)}, `
			+ `max ${times[4].toFixed(1)}) - ${counts.files} files, ${counts.lines} matched lines`
	);
}

async function main() {
	await bench('grepTree (native threads)', libripgrep);
	await bench('ripgrep CLI (--hidden -j4)', rgCli);
	await bench('naive Node (sequential)  ', naive);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
