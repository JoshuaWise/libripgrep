import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { grepTree, GrepTreeOptions } from '../src/index';

// Differential tests against the real ripgrep CLI: grepTree's line
// semantics (file selection, line numbers, line text, and match offsets)
// re-implement grep-searcher/grep-printer behavior, so they're checked
// against `rg --json` on a corpus of tricky files. Skipped when rg isn't
// installed (e.g. macOS CI runners without brew ripgrep).
const rgAvailable = spawnSync('rg', ['--version']).status === 0;
const describeRg = rgAvailable ? describe : describe.skip;

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'libripgrep-rg-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function makeTree(
	base: string,
	spec: Record<string, string | Buffer>
): Promise<void> {
	for (const [name, content] of Object.entries(spec)) {
		const target = join(base, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

// A per-file view of matched lines, comparable between both tools. `null`
// matches mean rg left the spans unspecified (see runRg).
interface LineView {
	lineNumber: number;
	line: string;
	matches: [number, number][] | null;
}

// Converts a byte offset within `line` to a UTF-16 code-unit offset.
function byteToUtf16(line: string, byteOffset: number): number {
	return Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}

interface RgFlags {
	crlf?: boolean;
	multiline?: boolean;
	caseInsensitive?: boolean;
}

// Runs `rg --json` and aggregates match events per relative path. Offsets
// convert from byte to UTF-16 code units; line terminators are stripped
// from the reported text like grepTree does.
function runRg(
	rootPath: string,
	patterns: readonly string[],
	flags: RgFlags
): Map<string, LineView[]> {
	const args = ['--json', '--no-config', '--hidden'];
	if (flags.crlf ?? true) {
		args.push('--crlf');
	}
	if (flags.multiline ?? false) {
		args.push('--multiline');
	}
	if (flags.caseInsensitive ?? false) {
		args.push('-i');
	}
	for (const pattern of patterns) {
		args.push('-e', pattern);
	}
	const result = spawnSync('rg', [...args, '.'], { cwd: rootPath, encoding: 'utf8' });
	// Exit status 1 just means "no matches".
	expect([0, 1]).toContain(result.status);
	const files = new Map<string, LineView[]>();
	for (const row of result.stdout.split('\n')) {
		if (row === '') {
			continue;
		}
		const event: {
			type: string;
			data: {
				path?: { text?: string };
				line_number?: number | null;
				lines?: { text?: string };
				submatches?: { start: number; end: number }[];
			};
		} = JSON.parse(row);
		if (event.type !== 'match') {
			continue;
		}
		const path = event.data.path?.text;
		const text = event.data.lines?.text;
		const lineNumber = event.data.line_number;
		if (
			path === undefined
			|| text === undefined
			|| lineNumber === undefined
			|| lineNumber === null
		) {
			throw new Error(`unexpected rg event: ${row}`);
		}
		const rel = relative('.', path);
		const terminator = (flags.crlf ?? true) ? /\r?\n$/ : /\n$/;
		const line = text.replace(terminator, '');
		// rg --json quirk: a zero-width match at EOF of an unterminated
		// final line is reported with an empty submatches array (the
		// terminated equivalent gets a proper empty span). Treat that as
		// "spans unspecified" rather than "no spans".
		const submatches = event.data.submatches ?? [];
		const views = files.get(rel) ?? [];
		views.push({
			lineNumber,
			line,
			matches:
				submatches.length === 0
					? null
					: submatches.map(({ start, end }): [number, number] => [
							byteToUtf16(line, start),
							byteToUtf16(line, end),
						]),
		});
		files.set(rel, views);
	}
	for (const views of files.values()) {
		views.sort((a, b) => a.lineNumber - b.lineNumber);
	}
	return files;
}

// Runs grepTree and aggregates its results in the same per-file shape.
async function runGrepTree(
	rootPath: string,
	options: GrepTreeOptions
): Promise<Map<string, LineView[]>> {
	const files = new Map<string, LineView[]>();
	for await (const { entry, matches } of grepTree(rootPath, options)) {
		const rel = relative(rootPath, join(entry.parentPath, entry.name));
		files.set(
			rel,
			matches.map(({ line, lineNumber, matches: spans }) => ({
				lineNumber,
				line,
				matches: spans,
			}))
		);
	}
	return files;
}

// Asserts full agreement, comparing sorted per-file views. Where rg left
// spans unspecified (see runRg), ours must be zero-width and are then
// excluded from the deep comparison.
async function expectParity(
	patterns: [string, ...string[]],
	options: Omit<GrepTreeOptions, 'patterns'> = {},
	flags: RgFlags = {}
): Promise<void> {
	const ours = await runGrepTree(root, { patterns, ...options });
	const theirs = runRg(root, patterns, flags);
	for (const [path, views] of theirs) {
		for (const view of views) {
			if (view.matches !== null) {
				continue;
			}
			const mine = ours.get(path)?.find((v) => v.lineNumber === view.lineNumber);
			expect(mine?.matches?.every(([s, e]) => s === e)).toBe(true);
			if (mine !== undefined) {
				mine.matches = null;
			}
		}
	}
	const sorted = (m: Map<string, LineView[]>) =>
		[...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
	expect(sorted(ours)).toEqual(sorted(theirs));
}

describeRg('grepTree vs ripgrep CLI', () => {
	test('multi-file trees with dotfiles and gitignore', async () => {
		await makeTree(root, {
			'.git/HEAD': 'ref: refs/heads/main\n',
			'.gitignore': 'ignored.txt\n',
			'ignored.txt': 'hello\n',
			'.hidden': 'hello hidden\n',
			'a.txt': 'hello\nworld\nhello world\n',
			'sub/deep/b.txt': 'no match\nsay hello\n',
			'empty.txt': '',
		});
		await expectParity(['hello']);
	});

	test('multiple patterns with multiple matches per line', async () => {
		await makeTree(root, {
			'a.txt': 'foo bar foo\nbar\nneither\nfoofoo barbar\n',
		});
		await expectParity(['foo', 'bar']);
	});

	test('CRLF files (crlf default matches rg --crlf)', async () => {
		await makeTree(root, {
			'dos.txt': 'foo\r\nbar foo\r\nend\r\n',
			'mixed.txt': 'foo\nbar\r\n',
		});
		await expectParity(['foo$', 'bar']);
	});

	test('BOM transcoding (UTF-16 LE/BE, UTF-8)', async () => {
		const le = Buffer.from('héllo\nsecond héllo\n', 'utf16le');
		const be = Buffer.from('héllo\nagain héllo\n', 'utf16le');
		be.swap16();
		await makeTree(root, {
			'le.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
			'be.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), be]),
			'bom8.txt': Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from('héllo\n'),
			]),
		});
		await expectParity(['héllo']);
	});

	test('binary files are skipped by both', async () => {
		await makeTree(root, {
			'binary.bin': Buffer.concat([
				Buffer.from('match\n'),
				Buffer.from([0x00]),
				Buffer.from('match\n'),
			]),
			'text.txt': 'match\n',
		});
		await expectParity(['match']);
	});

	test('empty matches: ^ on every line, $ at EOF, no trailing newline', async () => {
		await makeTree(root, {
			'terminated.txt': 'a\nbb\n',
			'unterminated.txt': 'a\nbb',
		});
		await expectParity(['^']);
		await expectParity(['$']);
		await expectParity(['b$']);
	});

	test('non-ASCII offsets (multi-byte and astral-plane characters)', async () => {
		await makeTree(root, {
			'unicode.txt': 'é𝒳marker\nmarker é\n𝒳𝒳 marker 𝒳\n',
		});
		await expectParity(['marker']);
	});

	test('caseInsensitive', async () => {
		await makeTree(root, { 'a.txt': 'FOO\nfoo\nFoO bar\n' });
		await expectParity(
			['foo'],
			{ regexOptions: { caseInsensitive: true } },
			{ caseInsensitive: true }
		);
	});

	test("multiline: matched-line sets agree (shapes differ, so only the lines' membership and text are compared)", async () => {
		await makeTree(root, {
			'a.txt': 'start\nalpha\nbeta\ngamma\nend\n',
			'b.txt': 'alpha\nx\nbeta\n',
		});
		const patterns: [string, ...string[]] = ['alpha[\\s\\S]*?beta'];
		const ours = await runGrepTree(root, {
			patterns,
			regexOptions: { multiline: true },
		});
		const theirs = runRg(root, patterns, { multiline: true });
		// rg reports one event per match region spanning k lines; expand it
		// to the set of (lineNumber, text) pairs it covers.
		const expand = (views: LineView[]) => {
			const lines = new Map<number, string>();
			for (const view of views) {
				for (const [i, text] of view.line.split('\n').entries()) {
					lines.set(view.lineNumber + i, text);
				}
			}
			return [...lines.entries()].sort(([a], [b]) => a - b);
		};
		expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort());
		for (const [path, views] of ours) {
			const mine = views.map(({ lineNumber, line }): [number, string] => [
				lineNumber,
				line,
			]);
			expect(mine).toEqual(expand(theirs.get(path) ?? []));
		}
	});

	test("this repository's own source tree", async () => {
		const ours = await runGrepTree(process.cwd(), {
			patterns: ['\\bfunction\\b', 'describe\\('],
		});
		const theirs = runRg(process.cwd(), ['\\bfunction\\b', 'describe\\('], {});
		const sorted = (m: Map<string, LineView[]>) =>
			[...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		expect(sorted(ours)).toEqual(sorted(theirs));
	});
});
