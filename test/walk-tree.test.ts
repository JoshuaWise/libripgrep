import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { walkTree, TreeEntry, WalkOptions } from '../src/index';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'libripgrep-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

// Creates files (with content) and directories (null) under `base`,
// creating parent directories as needed.
async function makeTree(
	base: string,
	spec: Record<string, string | null>
): Promise<void> {
	for (const [name, content] of Object.entries(spec)) {
		const target = join(base, name);
		if (content === null) {
			await mkdir(target, { recursive: true });
		} else {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}
	}
}

async function collect(gen: AsyncGenerator<TreeEntry>): Promise<TreeEntry[]> {
	const entries = [];
	for await (const entry of gen) {
		entries.push(entry);
	}
	return entries;
}

// Walks and returns sorted root-relative paths ('.' for the root itself).
async function walkPaths(rootPath: string, options?: WalkOptions): Promise<string[]> {
	const entries = await collect(walkTree(rootPath, options));
	return entries
		.map((e) => relative(rootPath, join(e.parentPath, e.name)) || '.')
		.sort();
}

describe('basic walking', () => {
	test('yields the root and every file and directory', async () => {
		await makeTree(root, {
			'a.txt': 'a',
			'sub/b.txt': 'b',
			'sub/nested/c.txt': 'c',
			empty: null,
		});
		expect(await walkPaths(root)).toEqual([
			'.',
			'a.txt',
			'empty',
			'sub',
			'sub/b.txt',
			'sub/nested',
			'sub/nested/c.txt',
		]);
	});

	test('entries implement the fs.Dirent interface', async () => {
		await makeTree(root, { 'a.txt': 'a', sub: null });
		const entries = await collect(walkTree(root));
		const file = entries.find((e) => e.name === 'a.txt');
		const dir = entries.find((e) => e.name === 'sub');
		expect(file?.isFile()).toBe(true);
		expect(file?.isDirectory()).toBe(false);
		expect(file?.isSymbolicLink()).toBe(false);
		expect(file?.parentPath).toBe(root);
		expect(dir?.isDirectory()).toBe(true);
		expect(dir?.isFile()).toBe(false);
		const rootEntry = entries.find((e) => join(e.parentPath, e.name) === root);
		expect(rootEntry?.isDirectory()).toBe(true);
	});

	test('dotfiles are never treated specially', async () => {
		await makeTree(root, { '.hidden': 'x', '.dir/inner.txt': 'y' });
		expect(await walkPaths(root)).toEqual(['.', '.dir', '.dir/inner.txt', '.hidden']);
	});

	test('the root may be a single file', async () => {
		await makeTree(root, { 'only.txt': 'x' });
		const entries = await collect(walkTree(join(root, 'only.txt')));
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe('only.txt');
		expect(entries[0].isFile()).toBe(true);
	});

	test('a nonexistent root rejects', async () => {
		await expect(collect(walkTree(join(root, 'missing')))).rejects.toThrow();
	});

	test('threads: 1 walks the same tree', async () => {
		await makeTree(root, { 'a.txt': 'a', 'sub/b.txt': 'b' });
		expect(await walkPaths(root, { threads: 1 })).toEqual([
			'.',
			'a.txt',
			'sub',
			'sub/b.txt',
		]);
	});
});

describe('maxDepth', () => {
	test('0 yields only the root', async () => {
		await makeTree(root, { 'a.txt': 'a' });
		expect(await walkPaths(root, { maxDepth: 0 })).toEqual(['.']);
	});

	test('1 yields the root and its direct children', async () => {
		await makeTree(root, { 'a.txt': 'a', 'sub/b.txt': 'b' });
		expect(await walkPaths(root, { maxDepth: 1 })).toEqual(['.', 'a.txt', 'sub']);
	});
});

describe('symlinks', () => {
	test('symlinks are yielded but not followed by default', async () => {
		await makeTree(root, { 'target/inner.txt': 'x' });
		await symlink(join(root, 'target'), join(root, 'link'));
		const entries = await collect(walkTree(root));
		const link = entries.find((e) => e.name === 'link');
		expect(link?.isSymbolicLink()).toBe(true);
		expect(await walkPaths(root)).toEqual([
			'.',
			'link',
			'target',
			'target/inner.txt',
		]);
	});

	test('symlinks are followed when enabled', async () => {
		await makeTree(root, { 'target/inner.txt': 'x' });
		await symlink(join(root, 'target'), join(root, 'link'));
		const paths = await walkPaths(root, { symlinks: true });
		expect(paths).toContain('link/inner.txt');
		const entries = await collect(walkTree(root, { symlinks: true }));
		const link = entries.find((e) => e.name === 'link');
		expect(link?.isDirectory()).toBe(true);
	});

	test('symlink cycles terminate', async () => {
		await makeTree(root, { 'dir/file.txt': 'x' });
		await symlink(join(root, 'dir'), join(root, 'dir', 'loop'));
		const paths = await walkPaths(root, { symlinks: true });
		expect(paths).toContain('dir/file.txt');
		expect(paths).not.toContain('dir/loop/file.txt');
	});

	test('a root symlink is always followed', async () => {
		await makeTree(root, { 'target/inner.txt': 'x' });
		await symlink(join(root, 'target'), join(root, 'link'));
		const paths = await walkPaths(join(root, 'link'));
		expect(paths).toEqual(['.', 'inner.txt']);
	});
});

describe('ignore files', () => {
	test('.gitignore is respected only inside a git repository', async () => {
		await makeTree(root, {
			'.gitignore': 'ignored.txt\n',
			'ignored.txt': 'x',
			'kept.txt': 'x',
		});
		expect(await walkPaths(root)).toContain('ignored.txt');
		await mkdir(join(root, '.git'));
		const paths = await walkPaths(root);
		expect(paths).not.toContain('ignored.txt');
		expect(paths).toContain('kept.txt');
	});

	test('.gitignore directory patterns prune whole subtrees', async () => {
		await makeTree(root, {
			'.git': null,
			'.gitignore': 'sub/\n',
			'sub/a.txt': 'x',
			'keep/b.txt': 'x',
		});
		const paths = await walkPaths(root);
		expect(paths).not.toContain('sub');
		expect(paths).not.toContain('sub/a.txt');
		expect(paths).toContain('keep/b.txt');
	});

	test('.ignore and .rgignore work without git', async () => {
		await makeTree(root, {
			'.ignore': 'a.txt\n',
			'.rgignore': 'b.txt\n',
			'a.txt': 'x',
			'b.txt': 'x',
			'c.txt': 'x',
		});
		const paths = await walkPaths(root);
		expect(paths).not.toContain('a.txt');
		expect(paths).not.toContain('b.txt');
		expect(paths).toContain('c.txt');
	});

	test('.rgignore has higher precedence than .ignore', async () => {
		await makeTree(root, {
			'.ignore': 'x.txt\n',
			'.rgignore': '!x.txt\n',
			'x.txt': 'x',
		});
		expect(await walkPaths(root)).toContain('x.txt');
	});

	test('parent directories are searched for ignore files', async () => {
		await makeTree(root, {
			'.git': null,
			'.gitignore': 'ig.txt\n',
			'sub/ig.txt': 'x',
			'sub/ok.txt': 'x',
		});
		const paths = await walkPaths(join(root, 'sub'));
		expect(paths).not.toContain('ig.txt');
		expect(paths).toContain('ok.txt');
	});

	test("ignoreStyle 'no-git' skips .gitignore but keeps .ignore/.rgignore", async () => {
		await makeTree(root, {
			'.git': null,
			'.gitignore': 'a.txt\n',
			'.ignore': 'b.txt\n',
			'a.txt': 'x',
			'b.txt': 'x',
		});
		const paths = await walkPaths(root, { ignoreStyle: 'no-git' });
		expect(paths).toContain('a.txt');
		expect(paths).not.toContain('b.txt');
	});

	test("ignoreStyle 'none' skips all automatic ignore files", async () => {
		await makeTree(root, {
			'.git': null,
			'.gitignore': 'a.txt\n',
			'.ignore': 'b.txt\n',
			'.rgignore': 'c.txt\n',
			'a.txt': 'x',
			'b.txt': 'x',
			'c.txt': 'x',
		});
		const paths = await walkPaths(root, { ignoreStyle: 'none' });
		expect(paths).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'c.txt']));
	});

	test("explicit ignoreFiles are respected even with ignoreStyle 'none'", async () => {
		await makeTree(root, { 'rules.ignore': 'a.txt\n', 'a.txt': 'x', 'b.txt': 'x' });
		const paths = await walkPaths(root, {
			ignoreStyle: 'none',
			ignoreFiles: [join(root, 'rules.ignore')],
		});
		expect(paths).not.toContain('a.txt');
		expect(paths).toContain('b.txt');
	});

	test('later ignoreFiles take precedence over earlier ones', async () => {
		await makeTree(root, {
			'low.ignore': 'x.txt\n',
			'high.ignore': '!x.txt\n',
			'x.txt': 'x',
		});
		const low = join(root, 'low.ignore');
		const high = join(root, 'high.ignore');
		expect(
			await walkPaths(root, { ignoreStyle: 'none', ignoreFiles: [low, high] })
		).toContain('x.txt');
		expect(
			await walkPaths(root, { ignoreStyle: 'none', ignoreFiles: [high, low] })
		).not.toContain('x.txt');
	});

	test('a missing ignoreFiles path rejects', async () => {
		await expect(
			collect(walkTree(root, { ignoreFiles: [join(root, 'nope.ignore')] }))
		).rejects.toThrow();
	});
});

describe('include/exclude globs', () => {
	test('excludeGlobs filters entries and prunes directories', async () => {
		await makeTree(root, {
			'a.log': 'x',
			'a.txt': 'x',
			'sub/b.log': 'x',
			'skip/c.txt': 'x',
		});
		const paths = await walkPaths(root, { excludeGlobs: ['**/*.log', 'skip'] });
		expect(paths).toEqual(['.', 'a.txt', 'sub']);
	});

	test('globs match paths relative to the root', async () => {
		await makeTree(root, { 'sub/x.txt': 'x', 'nested/sub/y.txt': 'y' });
		const paths = await walkPaths(root, { excludeGlobs: ['sub'] });
		expect(paths).not.toContain('sub');
		expect(paths).toContain('nested/sub');
		expect(paths).toContain('nested/sub/y.txt');
	});

	test('includeGlobs gates yielding but never traversal', async () => {
		await makeTree(root, { 'a.txt': 'x', 'b.log': 'x', 'foo/bar/baz.txt': 'x' });
		// Intermediate directories don't match '**/*.txt', but are still
		// descended; they just aren't yielded themselves.
		expect(await walkPaths(root, { includeGlobs: ['**/*.txt'] })).toEqual([
			'.',
			'a.txt',
			'foo/bar/baz.txt',
		]);
		// Directories are yielded when they match an include glob.
		expect(await walkPaths(root, { includeGlobs: ['**/*.txt', 'foo'] })).toEqual([
			'.',
			'a.txt',
			'foo',
			'foo/bar/baz.txt',
		]);
	});

	test("includeGlobs ['**'] with explicitDotfiles excludes dotfiles", async () => {
		await makeTree(root, {
			'a.txt': 'x',
			'.hidden': 'x',
			'.dir/inner.txt': 'x',
			'sub/.nested': 'x',
			'sub/ok.txt': 'x',
		});
		const paths = await walkPaths(root, {
			includeGlobs: ['**'],
			globOptions: { explicitDotfiles: true },
		});
		expect(paths).toEqual(['.', 'a.txt', 'sub', 'sub/ok.txt']);
	});

	test('include and exclude combine (exclude wins)', async () => {
		await makeTree(root, { 'a.txt': 'x', 'b.txt': 'x' });
		const paths = await walkPaths(root, {
			includeGlobs: ['**'],
			excludeGlobs: ['b*'],
		});
		expect(paths).toEqual(['.', 'a.txt']);
	});

	test('an invalid glob rejects', async () => {
		await expect(collect(walkTree(root, { includeGlobs: ['{a,b'] }))).rejects.toThrow(
			/unclosed alternate group/
		);
	});
});

describe('cancellation and validation', () => {
	test('early exit from iteration stops the walk cleanly', async () => {
		await makeTree(root, { 'a.txt': 'x', 'b.txt': 'x', 'sub/c.txt': 'x' });
		let count = 0;
		for await (const entry of walkTree(root)) {
			void entry;
			if (++count === 2) {
				break;
			}
		}
		expect(count).toBe(2);
		// The walker can still be used afterwards.
		expect(await walkPaths(root)).toContain('a.txt');
	});

	test('invalid options reject with TypeError', async () => {
		await expect(collect(walkTree(root, { threads: 0 }))).rejects.toThrow(TypeError);
		await expect(collect(walkTree(root, { maxDepth: -1 }))).rejects.toThrow(
			TypeError
		);
		await expect(collect(walkTree(root, { maxDepth: 1.5 }))).rejects.toThrow(
			TypeError
		);
	});
});
