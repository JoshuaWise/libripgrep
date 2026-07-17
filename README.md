# libripgrep

Native [ripgrep](https://github.com/BurntSushi/ripgrep) bindings for Node.js.

ripgrep isn't distributed as a library, but its core functionality is: this package binds the same Rust crates ripgrep is built from (`ignore`, `globset`, `grep-regex`, `grep-matcher`) into a JavaScript/TypeScript API, with all filesystem I/O and regex scanning running off the main thread on native worker threads. In [benchmarks](bench/grep-tree.js) it matches the ripgrep CLI's speed.

## Installation

```bash
npm install libripgrep
```

> Requires Node.js v24.x.x or later. Only GNU/Linux and MacOS are supported.

Prebuilt binaries are included for `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`. The main entry point auto-detects your platform. If you need a require graph with no dynamic loading at all (e.g. for bundlers), you can import a specific platform directly:

```ts
import { grepTree } from 'libripgrep/linux-arm64';
```

## Basic usage

```ts
import { compileGlob, compileGrep, walkTree, grepTree } from 'libripgrep';

// Search a directory tree for regex matches (like `rg 'TODO|FIXME'`):
for await (const { entry, matches } of grepTree('./src', { patterns: ['TODO|FIXME'] })) {
	for (const { line, lineNumber } of matches) {
		console.log(`${entry.parentPath}/${entry.name}:${lineNumber}: ${line}`);
	}
}

// Walk a tree, respecting .gitignore et al (like `rg --files`):
for await (const entry of walkTree('.', { includeGlobs: ['**'] })) {
	console.log(entry.name, entry.isDirectory());
}

// Compile a glob to a reusable predicate:
const isSource = compileGlob('src/**/*.{js,ts}');
isSource('src/api.ts'); // => true

// Compile regexes to a reusable buffer scanner:
const scan = compileGrep({ patterns: ['^import\\b'] });
scan(await fs.promises.readFile('src/index.ts')); // => MatchedLine[]
```

## API

### `compileGlob(globPattern, globOptions?)`

Compiles a glob pattern and returns a matcher function `(relativePath: string) => boolean`. Throws on invalid patterns.

Globs use ripgrep's syntax (`*`, `**`, `?`, `[a-z]`, `[!a-z]` or `[^a-z]`, `{a,b}` with nesting). `/` is always a literal separator: `*` and `?` never match it. Matching runs against relative paths (no leading `/`).

`GlobOptions`:

| Option               | Default | Meaning                                                                                                                                       |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `caseInsensitive`    | `false` | Match paths case-insensitively.                                                                                                               |
| `backslashEscape`    | `true`  | `\` escapes special characters. Note that `\` is always treated literally if not followed by a special character (so `\\` is literally `\\`). |
| `emptyAlternates`    | `true`  | Empty alternate branches (`foo{,.txt}`) match zero characters. If disabled, such branches are ignored.                                        |
| `allowUnclosedClass` | `false` | Treat an unclosed `[` as a literal instead of erroring.                                                                                       |
| `explicitDotfiles`   | `false` | Prevent `**`, `*`, `?`, and negated classes from matching dotfiles. Literal dots and non-negated classes (`[.a]`) still can.                  |

### `compileGrep(grepOptions)`

Compiles one or more regex patterns and returns a scanner function `(data: Readonly<Buffer>) => MatchedLine[]` that finds all lines matching any pattern. Compilation cost is paid once; the scanner can be reused on any number of buffers. Throws on invalid patterns (including empty `patterns`).

```ts
interface MatchedLine {
	line: string; // the entire matching line, without its terminator
	lineNumber: number; // 1-based
	matches: [number, number][]; // per-match [start, end) offsets into `line`, in UTF-16 code units (ready for String.prototype.slice)
}
```

`GrepOptions`:

- `patterns` — one or more regex patterns (Rust regex syntax, like ripgrep). A line matches if any pattern matches.
- `regexOptions`:

| Option            | Default | Meaning                                                                                                                                                        |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caseInsensitive` | `false` | Case-insensitive matching.                                                                                                                                     |
| `multiline`       | `false` | Patterns may match across lines; matches are reported clipped to each line they touch. Without it, patterns containing `\n` are compile errors (like ripgrep). |
| `multilineDotall` | `false` | `.` matches line terminators (only meaningful with `multiline`).                                                                                               |
| `crlf`            | `true`  | Treat `\r\n` as a line terminator: `$` matches before it and the `\r` is excluded from `line`.                                                                 |
| `unicode`         | `true`  | Unicode-aware character classes (`\w`, `\d`, ...).                                                                                                             |

Encodings are detected from a BOM (Byte Order Mark) only: UTF-16 LE/BE is transcoded, a UTF-8 BOM is stripped, and everything else is assumed to be UTF-8 (invalid bytes become U+FFFD). Buffers containing a NUL byte are considered binary and yield no matches, matching ripgrep's default binary handling.

### `walkTree(rootPath, walkOptions?)`

An `AsyncGenerator<TreeEntry>` yielding the root and every file and directory within it. `TreeEntry` implements the `fs.Dirent` interface (`name`, `parentPath`, `isFile()`, `isDirectory()`, `isSymbolicLink()`, ...). Traversal runs on native threads and streams back with backpressure; exiting the loop early (break/return/throw) stops the walk.

`WalkOptions`:

| Option         | Default    | Meaning                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads`      | `4`        | Walker thread count.                                                                                                                                                                                                                                                                                                                            |
| `symlinks`     | `false`    | Follow symlinks (with cycle detection). The root is always followed regardless.                                                                                                                                                                                                                                                                 |
| `maxDepth`     | `Infinity` | `0` yields only the root.                                                                                                                                                                                                                                                                                                                       |
| `ignoreFiles`  | `[]`       | Extra gitignore-format files; later files take precedence over earlier ones.                                                                                                                                                                                                                                                                    |
| `ignoreStyle`  | `'all'`    | `'all'` respects `.gitignore` (only inside real git repositories), `.ignore`, `.rgignore`, `.git/info/exclude`, and git's global excludes, ascending parent directories like ripgrep. `'no-git'` respects only `.ignore`/`.rgignore`. `'none'` respects nothing automatically. Even with `'none'`, explicit `ignoreFiles` are always respected. |
| `includeGlobs` | `[]`       | Only yield entries matching at least one glob (non-matching directories are still traversed).                                                                                                                                                                                                                                                   |
| `excludeGlobs` | `[]`       | Never yield or descend into entries matching any of these globs.                                                                                                                                                                                                                                                                                |
| `globOptions`  | —          | `GlobOptions` applied to both glob lists.                                                                                                                                                                                                                                                                                                       |

Globs match paths relative to `rootPath`. `excludeGlobs` prunes traversal: an excluded directory is never descended into. `includeGlobs` only filters what is yielded: `['**/*.txt']` finds every nested `.txt` file, and the intermediate directories are traversed but not yielded (since they don't match). Hidden files are never treated specially — to exclude dotfiles, use `includeGlobs: ['**']` with `globOptions: { explicitDotfiles: true }`.

### `grepTree(rootPath, grepTreeOptions)`

An `AsyncGenerator<{ entry: TreeEntry, matches: MatchedLine[] }>` yielding each file with at least one matching line. Does the same traversal as `walkTree()` while reading and scanning candidate files on the walker threads — the main thread stays free.

`GrepTreeOptions` extends `GrepOptions` with:

| Option        | Default | Meaning                                                                 |
| ------------- | ------- | ----------------------------------------------------------------------- |
| `maxFileSize` | 16 MiB  | Skip files larger than this many bytes (`Infinity` disables the limit). |
| `walkOptions` | —       | Traversal options, as in `walkTree()`.                                  |

## Behavior notes

- All filesystem I/O (directory reading, file reading) happens off the main thread; mmap is never used.
- Regex engine: ripgrep's default engine (`grep-regex`) only — no PCRE2. ripgrep's default regex and DFA size limits apply. Multiple patterns compile into one alternation, so overlapping matches from different patterns are reported leftmost-first, non-overlapping (as in ripgrep).
- Patterns that could match a NUL byte are rejected, like ripgrep.
- An error reading the root (e.g. it doesn't exist) rejects the generator. Errors deeper in the tree — unreadable directories or files, broken symlinks — are silently skipped, like ripgrep's warn-and-continue.
- An unreadable root directory yields just the root entry, since the error occurs when reading its contents.
- An empty file has zero lines; an empty match after a trailing newline is not reported on a phantom line.

## Development

```bash
npm install            # also compiles TypeScript (prepare)
npm run build:native   # cargo build + copy into prebuilds/ (requires Rust)
npm test               # jest
npm run prettier
node bench/grep-tree.js <dir> # benchmark vs rg and naive Node
```

## License

MIT
