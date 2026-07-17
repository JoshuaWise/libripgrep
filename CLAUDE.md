# CLAUDE.md

This file guides Claude Code when working with the "libripgrep" repository.

## Project Overview

This project provides native bindings for [ripgrep](https://github.com/burntsushi/ripgrep) in Node.js. The challenge is: ripgrep is not actually distributed as a library. Fortunately, most of ripgrep's core functionality is available as individual Rust creates:

- [ignore](https://crates.io/crates/ignore)
- [globset](https://crates.io/crates/globset)
- [grep-matcher](https://crates.io/crates/grep-matcher)
- [grep-regex](https://crates.io/crates/grep-regex)
- [grep-searcher](https://crates.io/crates/grep-searcher)

By using these crates, we can build a native addon for Node.js that replicates ripgrep's functionality, but exposes it as a JavaScript/TypeScript library.

## Compatability

- Use [napi-rs](https://napi.rs/docs/introduction/getting-started), never directly include `node.h`, `v8.h`, `nan.h`, or `node_api.h`.
- Write the native code in Rust, not C or C++.
- Only Unix-like systems need to be supported; explicit support is only provided for Linux and MacOS.
- We will publish prebuilt binaries for the supported platforms (both x64 and arm64).
- The main `dist/index.js` export will do auto-detection of the current platform and architecture to load the appropriate addon binary. We will also allow users to import `libripgrep/<platform-arch>` for a version that is explicitly bound to a specific platform/architecture, without any auto-detection or dynamic importing in the entire `require` graph (e.g., don't even import the auto-detection logic from these entry points, even if unused).

## Public API

```ts
interface GlobOptions {
    // When true, match paths case-insensitively. Default false.
    readonly caseInsensitive?: boolean;

    // When true, backslashes can escape special characters. Default true.
    readonly backslashEscape?: boolean;

    // When true, empty patterns in alternate lists are not ignored
    // (i.e., they can match zero characters). Default true.
    readonly emptyAlternates?: boolean;

    // Whether to allow unclosed character classes (treating them as literals).
    // Default false.
    readonly allowUnclosedClass?: boolean;

    // When true, "**", "*", "?", and negated classes don't enter dots (".")
    // at the start of path segments (including preventing "*" from matching
    // zero characters in patterns like "/*."). Default false.
    readonly explicitDotfiles?: boolean;
}

// Compiles the given glob pattern and returns a corresponding matcher
// function that can be run any number of times on relative file paths.
function compileGlob(globPattern: string, options?: GlobOptions): (relativePath: string) => boolean;

interface WalkOptions {
    // The number of threads to use. Default is 4.
    readonly threads?: number;

    // If true, symlinks will be followed while traversing directories.
    // When true, cycles are detected to protect against infinite traversal.
    // Default false.
    readonly symlinks?: boolean;

    // Limit the depth of directory traversal. A value of 0 only searches the
    // explicitly given path itself. Default is Infinity.
    readonly maxDepth?: number;

    // Specifies the path to one or more "gitignore" formatted rule files.
    // These patterns are applied at a lower precedence than files
    // automatically found in the directory tree. If multiple paths are
    // provided, earlier files have lower precedence than later files.
    readonly ignoreFiles?: ReadonlyArray<string>;

    // The default behavior is 'all', which causes directory traversal to
    // consider ".gitignore", ".ignore", and ".rgignore" files, as well as
    // ".git/info/exclude", git's "core.excludesFile", etc. Note that all parent
    // directories are also ascended to look for applicable ignore files.
    // When this option is set to 'no-git', only ".ignore" and ".rgignore"
    // files are respected. When set to 'none', none of these ignore sources
    // are respected. Files explicitly passed to "ignoreFiles" are always
    // respected. Note that we always use the behavior of ripgrep's
    // "--require-git" flag, which means files such as ".gitignore" are only
    // respected in actual git repositories.
    readonly ignoreStyle?: 'all' | 'no-git' | 'none';

    // If provided, only return files and directories that match at least one
    // of these globs. Directories that don't match are still traversed (like
    // ripgrep), so matching files within them are found; the directories
    // themselves just aren't yielded.
    readonly includeGlobs?: ReadonlyArray<string>;

    // If provided, don't search or return files or directories that match any
    // of these globs.
    readonly excludeGlobs?: ReadonlyArray<string>;

    // The options to apply to globs in "includeGlobs" and "excludeGlobs".
    readonly globOptions?: GlobOptions;
}

interface TreeEntry extends fs.Dirent {}

// Yields a TreeEntry for the given 'rootPath' and every file and directory
// found within it, recursively (subject to the given options). If the rootPath
// is a symlink, it is followed regardless of the provided 'symlinks' option.
async function* walkTree(rootPath: string, options?: WalkOptions): AsyncGenerator<TreeEntry>;

interface RegexOptions {
    // Treat regex patterns case-insensitively. Default false.
    readonly caseInsensitive?: boolean;

    // Allows regex patterns to match across multiple lines. Default false.
    readonly multiline?: boolean;

    // Causes "." to match line terminators when "multiline" is enabled.
    // This option has no affect when "multiline" mode is not enabled.
    // Default false.
    readonly multilineDotall?: boolean;

    // Treat CRLF (`\r\n`) as a line terminator instead of just `\n`.
    // This affects how lines are detected in multiline mode. Default true.
    readonly crlf?: boolean;

    // Enables unicode mode for regexp patterns. Default true.
    readonly unicode?: boolean;
}

interface GrepOptions {
    // The regex patterns to search for.
    // Lines matching at least one pattern are returned.
    readonly patterns: Readonly<[string, ...string[]]>;

    // The options to apply to all regex patterns.
    readonly regexOptions?: RegexOptions;
}

interface MatchedLine {
    line: string; // The entire line where the match was found
    lineNumber: number; // 1-based line number
    matches: [number, number][]; // The start/end pair of indices of each match found within the line: UTF-16 code-unit offsets within the `line` string (e.g., for String.prototype.slice())
}

// Compiles the given regular expressions and returns a corresponding matcher
// function that can be run any number of times on raw Buffers, to find all
// lines matching any of the given regexes.
function compileGrep(options: GrepOptions): (data: Readonly<Buffer>) => MatchedLine[];

interface GrepTreeOptions extends GrepOptions {
    // Ignore files larger than this size in bytes. Default is 16 MiB.
    readonly maxFileSize?: number;

    // The options to use for directory tree traversal.
    readonly walkOptions?: WalkOptions;
}

interface GrepTreeResult {
    entry: TreeEntry;
    matches: MatchedLine[];
}

// Yields a GrepTreeResult for each file with at least one regex match.
// Under the hood, this does the same directory traversal as walkTree(),
// but it also reads candidate files to search their contents. Always do file
// operations off the main thread (readdir, read data). Benchmark whether it's
// better to do the actual regex scanning in the main thread or not.
async function* grepTree(rootPath: string, options: GrepTreeOptions): AsyncGenerator<GrepTreeResult>;
```

> In `compileGrep()` and `grepTree()`, file encodings should be detected automatically based on the BOM (UTF-16 BE, UTF-16 LE, or UTF-8). No other detection should be performed. UTF-8 should be assumed if there's no BOM.

> In `compileGrep()` and `grepTree()`, never search binary files. Use ripgrep's default behavior of detecting NUL bytes to identify binary files and ignore them.

> When traversing directories, never treat dotfiles any differently from regular files. In other words, always behave as if ripgrep's `--hidden` option was provided. Dotfiles can still naturally be excluded by using an `includeGlobs` glob of `**` with `explicitDotfiles: true`.

> Globs should ALWAYS use the `literal_separator: true` option in `globset`.

> Just like in ripgrep, DFAs should be limited to some large default max size, to prevent exponential state generation. Use the same limit that ripgrep uses by default `--dfa-size-limit`. Also apply ripgrep's default regex size limit (`--regex-size-limit`). These need not be configurable.

> Only the `grep-regex` engine should be used. PCRE2 is not provided as an option.

> Never use mmap when reading files.

> I/O should never occur synchronously in the main thread.

## Dev Commands

- **Compile TS to JS:** `npm run prepare`
- **Test:** `npm run test`
- **Prettier:** `npm run prettier`

> Coding agents like Claude Code should always use `--runInBand` when running tests, because Claude Code is often run in a memory-constrained sandbox. Using `--runInBand` avoids crashing due to memory exhaustion.

## Coding Rules

- Avoid the `any` type, and usage of the `as` operator.
- In `catch` blocks, always check the specific error type/code that is relevant. For example, for filesystem operations, prefer to explicitly check error codes like `ENOENT` instead of writing catch-all blocks.
- Never use `__dirname`, `__filename`, `require.resolve()`, or `require.resolve()`.
- **MANDATORY:** Run relevant tests after every implementation.
- **MANDATORY:** Run prettier and ALL tests before committing.

### Comments

- No file-level block comments. Imports are the top of the file. Comments belong on each exported type/function/const; the file's purpose should be obvious from the aggregate of those per-export comments.
- Reserve block comments (`/* ... */`) for very large functions or classes. For smaller utility-style functions, use one or several consecutive single-line comments (`// ...`) instead.
- Keep comments tight. Don't restate what well-named code already says, and don't write defensive "future-proofing" notes (e.g., "belt-and-braces guard for a future API change") — trust the type system and library contracts.

### API surface

- Don't expose, export, or return data that has no current consumer. Speculative API surface gets edited away or shapes the eventual design incorrectly — wait until real usage drives the shape, even when a written plan lists the field.
- Don't `export` a symbol that isn't used outside its own file. Exception: type definitions referenced by an exported function's signature (directly or transitively) should be exported, so callers can name them when declaring variables or helpers.
- Collapse discriminated failure reasons (`{ ok: false, reason }`) until a concrete caller branches on the distinction. Two reasons that produce the same caller response should be one reason.
- For inputs where "absent" carries real meaning, prefer required-nullable (`T | null`) over optional (`T?`/`T | undefined`). It forces callers to make a deliberate decision instead of silently skipping the parameter. Optional parameters are okay when the "absent" case is truly more canonical than the "present" case.

### Style

- Be terse. Prefer inlining a simple helper at the call site over extracting it to a neighboring file unless the extraction carries its weight.
- Delete dead code on the same turn as the refactor that orphans it — don't leave it for a follow-up.

### Working rhythm

- Implement plan steps in small, reviewable chunks. After each chunk, stop and let the human review/edit before starting the next.
- Don't commit, don't `git add`. Leave changes in the working tree for the human to stage themselves.
- When a section of a `plan-*.md` file lands, add a `> **Status: implemented (awaiting review).**` blockquote summarizing what landed and what was deferred. When the human clarifies a requirement, edit the plan file inline (alongside or before the code change) so the plan stays the source of truth across review cycles.
