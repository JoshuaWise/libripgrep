import type { Dirent } from 'node:fs';

// Options controlling how glob patterns are compiled.
export interface GlobOptions {
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

// Options controlling directory tree traversal.
export interface WalkOptions {
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
	// ".git/info/exclude", git's "core.excludesFile", etc. Note that all
	// parent directories are also ascended to look for applicable ignore
	// files. When this option is set to 'no-git', only ".ignore" and
	// ".rgignore" files are respected. When set to 'none', none of these
	// ignore sources are respected. Files explicitly passed to "ignoreFiles"
	// are always respected. Note that we always use the behavior of ripgrep's
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

// A directory entry yielded by walkTree() and grepTree().
export interface TreeEntry extends Dirent {}

// Options controlling how regex patterns are compiled.
export interface RegexOptions {
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

// Options controlling what compileGrep() and grepTree() search for.
export interface GrepOptions {
	// The regex patterns to search for.
	// Lines matching at least one pattern are returned.
	readonly patterns: Readonly<[string, ...string[]]>;

	// The options to apply to all regex patterns.
	readonly regexOptions?: RegexOptions;

	// Include up to this many lines immediately before each matching line.
	// Default is 0.
	readonly beforeContext?: number;

	// Include up to this many lines immediately after each matching line.
	// Default is 0.
	readonly afterContext?: number;
}

// A line containing one or more regex matches.
export interface MatchedLine {
	// The entire line where the match was found.
	line: string;

	// 1-based line number.
	lineNumber: number;

	// The start/end pair of indices of each match found within the line:
	// UTF-16 code-unit offsets within the `line` string (e.g., for
	// String.prototype.slice()).
	matches: [number, number][];

	// Lines immediately before this match, ordered from earliest to latest,
	// or undefined when beforeContext was not used.
	linesBefore: string[] | undefined;

	// Lines immediately after this match, ordered from earliest to latest,
	// or undefined when afterContext was not used.
	linesAfter: string[] | undefined;
}

// Options controlling grepTree().
export interface GrepTreeOptions extends GrepOptions {
	// Ignore files larger than this size in bytes. Default is 16 MiB.
	readonly maxFileSize?: number;

	// The options to use for directory tree traversal.
	readonly walkOptions?: WalkOptions;
}

// A file with at least one regex match, yielded by grepTree().
export interface GrepTreeResult {
	entry: TreeEntry;
	matches: MatchedLine[];
}
