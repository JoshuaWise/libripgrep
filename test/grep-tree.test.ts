import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { grepTree, GrepTreeResult, GrepTreeOptions } from '../src/index';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'libripgrep-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function makeTree(base: string, spec: Record<string, string>): Promise<void> {
	for (const [name, content] of Object.entries(spec)) {
		const target = join(base, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

async function collect(gen: AsyncGenerator<GrepTreeResult>): Promise<GrepTreeResult[]> {
	const results = [];
	for await (const result of gen) {
		results.push(result);
	}
	return results;
}

// Greps and returns results keyed by root-relative path, sorted.
async function grepPaths(
	rootPath: string,
	options: GrepTreeOptions
): Promise<Map<string, GrepTreeResult>> {
	const results = await collect(grepTree(rootPath, options));
	return new Map(
		results
			.map((r): [string, GrepTreeResult] => [
				relative(rootPath, join(r.entry.parentPath, r.entry.name)),
				r,
			])
			.sort(([a], [b]) => (a < b ? -1 : 1))
	);
}

describe('basic searching', () => {
	test('yields only files with matches, with full match details', async () => {
		await makeTree(root, {
			'a.txt': 'hello\nworld\n',
			'sub/b.txt': 'say hello twice: hello\n',
			'c.txt': 'nothing here\n',
		});
		const results = await grepPaths(root, { patterns: ['hello'] });
		expect([...results.keys()]).toEqual(['a.txt', 'sub/b.txt']);
		expect(results.get('a.txt')?.matches).toEqual([
			{ line: 'hello', lineNumber: 1, matches: [[0, 5]] },
		]);
		expect(results.get('sub/b.txt')?.matches).toEqual([
			{
				line: 'say hello twice: hello',
				lineNumber: 1,
				matches: [
					[4, 9],
					[17, 22],
				],
			},
		]);
		const entry = results.get('a.txt')?.entry;
		expect(entry?.isFile()).toBe(true);
		expect(entry?.name).toBe('a.txt');
		expect(entry?.parentPath).toBe(root);
	});

	test('directories are never yielded', async () => {
		await makeTree(root, { 'hello/hello.txt': 'hello\n' });
		const results = await grepPaths(root, { patterns: ['hello'] });
		expect([...results.keys()]).toEqual(['hello/hello.txt']);
	});

	test('the root may be a single file', async () => {
		await makeTree(root, { 'only.txt': 'match me\n' });
		const results = await collect(
			grepTree(join(root, 'only.txt'), { patterns: ['match'] })
		);
		expect(results).toHaveLength(1);
		expect(results[0].entry.name).toBe('only.txt');
	});

	test('a nonexistent root rejects', async () => {
		await expect(
			collect(grepTree(join(root, 'missing'), { patterns: ['x'] }))
		).rejects.toThrow();
	});

	test('no matching files yields nothing', async () => {
		await makeTree(root, { 'a.txt': 'nope\n' });
		expect(await collect(grepTree(root, { patterns: ['hello'] }))).toEqual([]);
	});
});

describe('regexOptions plumbing', () => {
	test('multiline matches span lines within a file', async () => {
		await makeTree(root, { 'a.txt': 'xa\nby\n' });
		const results = await grepPaths(root, {
			patterns: ['a\\nb'],
			regexOptions: { multiline: true },
		});
		expect(results.get('a.txt')?.matches).toEqual([
			{ line: 'xa', lineNumber: 1, matches: [[1, 2]] },
			{ line: 'by', lineNumber: 2, matches: [[0, 1]] },
		]);
	});

	test('crlf and caseInsensitive apply', async () => {
		await makeTree(root, { 'a.txt': 'FOO\r\n' });
		const results = await grepPaths(root, {
			patterns: ['foo$'],
			regexOptions: { caseInsensitive: true, crlf: true },
		});
		expect(results.get('a.txt')?.matches).toEqual([
			{ line: 'FOO', lineNumber: 1, matches: [[0, 3]] },
		]);
	});

	test('invalid regexes reject', async () => {
		await expect(collect(grepTree(root, { patterns: ['('] }))).rejects.toThrow();
	});

	test('an empty patterns array rejects with TypeError', async () => {
		const patterns: [string, ...string[]] = ['x'];
		patterns.pop();
		await expect(collect(grepTree(root, { patterns }))).rejects.toThrow(TypeError);
	});
});

describe('binary and encoding handling', () => {
	test('binary files are skipped', async () => {
		await makeTree(root, { 'text.txt': 'hello\n' });
		await writeFile(
			join(root, 'binary.bin'),
			Buffer.concat([
				Buffer.from('hello\n'),
				Buffer.from([0x00]),
				Buffer.from('hello\n'),
			])
		);
		const results = await grepPaths(root, { patterns: ['hello'] });
		expect([...results.keys()]).toEqual(['text.txt']);
	});

	test('UTF-16 files with a BOM are searched', async () => {
		await writeFile(
			join(root, 'utf16.txt'),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\n', 'utf16le')])
		);
		const results = await grepPaths(root, { patterns: ['héllo'] });
		expect(results.get('utf16.txt')?.matches).toEqual([
			{ line: 'héllo', lineNumber: 1, matches: [[0, 5]] },
		]);
	});
});

describe('maxFileSize', () => {
	test('files larger than the limit are skipped; equal-size files are kept', async () => {
		await makeTree(root, {
			'small.txt': 'match\n', // 6 bytes
			'large.txt': 'match match match\n', // 18 bytes
		});
		const results = await grepPaths(root, { patterns: ['match'], maxFileSize: 6 });
		expect([...results.keys()]).toEqual(['small.txt']);
	});

	test('applies to a root file too', async () => {
		await makeTree(root, { 'big.txt': 'match match match\n' });
		const results = await collect(
			grepTree(join(root, 'big.txt'), { patterns: ['match'], maxFileSize: 6 })
		);
		expect(results).toEqual([]);
	});

	test('Infinity disables the limit', async () => {
		await makeTree(root, { 'a.txt': 'match\n' });
		const results = await grepPaths(root, {
			patterns: ['match'],
			maxFileSize: Infinity,
		});
		expect([...results.keys()]).toEqual(['a.txt']);
	});

	test('invalid maxFileSize rejects with TypeError', async () => {
		await expect(
			collect(grepTree(root, { patterns: ['x'], maxFileSize: -1 }))
		).rejects.toThrow(TypeError);
	});
});

describe('walkOptions plumbing', () => {
	test('ignore files apply', async () => {
		await makeTree(root, {
			'.gitignore': 'skipped.txt\n',
			'skipped.txt': 'hello\n',
			'kept.txt': 'hello\n',
		});
		await mkdir(join(root, '.git'));
		const results = await grepPaths(root, { patterns: ['hello'] });
		expect([...results.keys()]).toEqual(['kept.txt']);
	});

	test('includeGlobs finds nested files without matching directories', async () => {
		await makeTree(root, {
			'a.txt': 'hello\n',
			'a.md': 'hello\n',
			'foo/bar/baz.txt': 'hello\n',
		});
		const results = await grepPaths(root, {
			patterns: ['hello'],
			walkOptions: { includeGlobs: ['**/*.txt'] },
		});
		expect([...results.keys()]).toEqual(['a.txt', 'foo/bar/baz.txt']);
	});

	test('include/exclude globs apply', async () => {
		await makeTree(root, {
			'a.txt': 'hello\n',
			'a.log': 'hello\n',
			'sub/b.txt': 'hello\n',
		});
		const results = await grepPaths(root, {
			patterns: ['hello'],
			walkOptions: { excludeGlobs: ['sub', '**/*.log'] },
		});
		expect([...results.keys()]).toEqual(['a.txt']);
	});

	test('maxDepth applies', async () => {
		await makeTree(root, { 'a.txt': 'hello\n', 'sub/b.txt': 'hello\n' });
		const results = await grepPaths(root, {
			patterns: ['hello'],
			walkOptions: { maxDepth: 1 },
		});
		expect([...results.keys()]).toEqual(['a.txt']);
	});

	test('symlinks are not searched unless enabled', async () => {
		await makeTree(root, { 'real/target.txt': 'hello\n' });
		const { symlink } = await import('node:fs/promises');
		await symlink(join(root, 'real', 'target.txt'), join(root, 'link.txt'));
		const without = await grepPaths(root, { patterns: ['hello'] });
		expect([...without.keys()]).toEqual(['real/target.txt']);
		const withLinks = await grepPaths(root, {
			patterns: ['hello'],
			walkOptions: { symlinks: true },
		});
		expect([...withLinks.keys()]).toEqual(['link.txt', 'real/target.txt']);
	});
});

describe('robustness', () => {
	const testNonRoot = process.getuid && process.getuid() === 0 ? test.skip : test;

	testNonRoot('unreadable files are skipped', async () => {
		await makeTree(root, { 'ok.txt': 'hello\n', 'locked.txt': 'hello\n' });
		await chmod(join(root, 'locked.txt'), 0o000);
		try {
			const results = await grepPaths(root, { patterns: ['hello'] });
			expect([...results.keys()]).toEqual(['ok.txt']);
		} finally {
			await chmod(join(root, 'locked.txt'), 0o644);
		}
	});

	test('early exit from iteration stops the search cleanly', async () => {
		await makeTree(root, {
			'a.txt': 'hello\n',
			'b.txt': 'hello\n',
			'c.txt': 'hello\n',
		});
		let count = 0;
		for await (const result of grepTree(root, { patterns: ['hello'] })) {
			void result;
			count += 1;
			break;
		}
		expect(count).toBe(1);
	});
});
