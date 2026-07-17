import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// These tests inspect the compiled dist/ output (what the package actually
// ships), so they need `npm run prepare` to have been run first.
const DIST = join(process.cwd(), 'dist');
const PLATFORM_ARCHES = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

beforeAll(() => {
	if (!existsSync(join(DIST, 'index.js'))) {
		throw new Error('dist/ is missing; run "npm run prepare" before testing');
	}
});

// Extracts the argument of every require() call in a JS source, split into
// string literals and anything else (dynamic).
function requireArgs(source: string): { literals: string[]; dynamic: string[] } {
	const literals: string[] = [];
	const dynamic: string[] = [];
	for (const match of source.matchAll(/\brequire\s*\(([^)]*)\)/g)) {
		const arg = match[1].trim();
		const literal = /^(["'])([^"'`]*)\1$/.exec(arg);
		if (literal !== null) {
			literals.push(literal[2]);
		} else {
			dynamic.push(arg);
		}
	}
	return { literals, dynamic };
}

// Walks the require graph starting from a dist file, following relative
// requires of .js modules. Returns visited files (absolute), all string
// literals seen, and all dynamic require arguments seen.
function walkRequireGraph(entry: string): {
	visited: Set<string>;
	literals: string[];
	dynamic: string[];
} {
	const visited = new Set<string>();
	const literals: string[] = [];
	const dynamic: string[] = [];
	const queue = [resolve(entry)];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || visited.has(file)) {
			continue;
		}
		visited.add(file);
		const args = requireArgs(readFileSync(file, 'utf8'));
		dynamic.push(...args.dynamic);
		for (const literal of args.literals) {
			literals.push(literal);
			if (literal.startsWith('.') && !literal.endsWith('.node')) {
				queue.push(resolve(dirname(file), `${literal}.js`));
			}
		}
	}
	return { visited, literals, dynamic };
}

describe('platform-specific entry points', () => {
	for (const platformArch of PLATFORM_ARCHES) {
		test(`${platformArch} has a fully static require graph`, () => {
			const graph = walkRequireGraph(join(DIST, `${platformArch}.js`));
			expect(graph.dynamic).toEqual([]);
			expect(graph.visited.has(join(DIST, 'index.js'))).toBe(false);
			expect(graph.literals).toContain(
				`../prebuilds/${platformArch}/libripgrep.node`
			);
			// The only .node file in the graph is this platform's own.
			const nodeRequires = graph.literals.filter((l) => l.endsWith('.node'));
			expect(nodeRequires).toEqual([
				`../prebuilds/${platformArch}/libripgrep.node`,
			]);
		});
	}

	test('the auto-detecting entry has exactly one dynamic require', () => {
		const graph = walkRequireGraph(join(DIST, 'index.js'));
		expect(graph.dynamic).toHaveLength(1);
		expect(graph.dynamic[0]).toContain('prebuilds');
	});
});

describe('package.json packaging', () => {
	const pkg: {
		exports: Record<string, { types: string; default: string }>;
		files: string[];
	} = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

	test('exports covers the root and every platform-arch subpath', () => {
		expect(Object.keys(pkg.exports).sort()).toEqual(
			['.', ...PLATFORM_ARCHES.map((p) => `./${p}`)].sort()
		);
	});

	test('every export target exists after compilation', () => {
		for (const entry of Object.values(pkg.exports)) {
			expect(existsSync(join(process.cwd(), entry.types))).toBe(true);
			expect(existsSync(join(process.cwd(), entry.default))).toBe(true);
		}
	});

	test('prebuilds are included in the published files', () => {
		expect(pkg.files).toContain('prebuilds/**');
	});
});
