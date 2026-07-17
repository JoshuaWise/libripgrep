import { basename, dirname } from 'node:path';
import type {
	NativeBinding,
	NativeWalkEntry,
	ResolvedGlobOptions,
	ResolvedRegexOptions,
	ResolvedWalkOptions,
} from './binding';
import type {
	GlobOptions,
	GrepOptions,
	GrepTreeOptions,
	GrepTreeResult,
	MatchedLine,
	RegexOptions,
	TreeEntry,
	WalkOptions,
} from './types';

// The public API of libripgrep, bound to one native addon build.
export interface LibRipgrep {
	// Compiles the given glob pattern and returns a corresponding matcher
	// function that can be run any number of times on relative file paths.
	compileGlob(
		globPattern: string,
		options?: GlobOptions
	): (relativePath: string) => boolean;

	// Scans the given buffer for all lines matching any of the given regexes.
	grepBuffer(data: Readonly<Buffer>, options: GrepOptions): MatchedLine[];

	// Yields a TreeEntry for the given 'rootPath' and every file and
	// directory found within it, recursively (subject to the given options).
	// If the rootPath is a symlink, it is followed regardless of the provided
	// 'symlinks' option.
	walkTree(rootPath: string, options?: WalkOptions): AsyncGenerator<TreeEntry>;

	// Yields a GrepTreeResult for each file with at least one regex match.
	grepTree(rootPath: string, options: GrepTreeOptions): AsyncGenerator<GrepTreeResult>;
}

// Applies the defaults documented on GlobOptions.
function resolveGlobOptions(options?: GlobOptions): ResolvedGlobOptions {
	return {
		caseInsensitive: options?.caseInsensitive ?? false,
		backslashEscape: options?.backslashEscape ?? true,
		emptyAlternates: options?.emptyAlternates ?? true,
		allowUnclosedClass: options?.allowUnclosedClass ?? false,
		explicitDotfiles: options?.explicitDotfiles ?? false,
	};
}

// Applies the defaults documented on RegexOptions.
function resolveRegexOptions(options?: RegexOptions): ResolvedRegexOptions {
	return {
		caseInsensitive: options?.caseInsensitive ?? false,
		multiline: options?.multiline ?? false,
		multilineDotall: options?.multilineDotall ?? false,
		crlf: options?.crlf ?? false,
		unicode: options?.unicode ?? true,
	};
}

// Applies the defaults documented on WalkOptions and validates the numeric
// and enumerated options.
function resolveWalkOptions(options?: WalkOptions): ResolvedWalkOptions {
	const threads = options?.threads ?? 4;
	if (!Number.isInteger(threads) || threads < 1) {
		throw new TypeError('threads must be a positive integer');
	}
	const maxDepth = options?.maxDepth ?? Infinity;
	if (maxDepth !== Infinity && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
		throw new TypeError('maxDepth must be a non-negative integer or Infinity');
	}
	const ignoreStyle = options?.ignoreStyle ?? 'all';
	if (ignoreStyle !== 'all' && ignoreStyle !== 'no-git' && ignoreStyle !== 'none') {
		throw new TypeError("ignoreStyle must be 'all', 'no-git', or 'none'");
	}
	return {
		threads,
		symlinks: options?.symlinks ?? false,
		maxDepth: maxDepth === Infinity || maxDepth > 0xffffffff ? undefined : maxDepth,
		ignoreFiles: [...(options?.ignoreFiles ?? [])],
		ignoreStyle,
		includeGlobs: [...(options?.includeGlobs ?? [])],
		excludeGlobs: [...(options?.excludeGlobs ?? [])],
		globOptions: resolveGlobOptions(options?.globOptions),
	};
}

// File type codes shared with file_type_code() in native/src/walk.rs.
class TreeEntryImpl implements TreeEntry {
	readonly name: string;
	readonly parentPath: string;
	readonly #fileType: number;

	constructor(entry: NativeWalkEntry) {
		// basename('/') is '', so fall back to the path itself.
		this.name = basename(entry.path) || entry.path;
		this.parentPath = dirname(entry.path);
		this.#fileType = entry.fileType;
	}

	isFile(): boolean {
		return this.#fileType === 0;
	}
	isDirectory(): boolean {
		return this.#fileType === 1;
	}
	isSymbolicLink(): boolean {
		return this.#fileType === 2;
	}
	isBlockDevice(): boolean {
		return this.#fileType === 3;
	}
	isCharacterDevice(): boolean {
		return this.#fileType === 4;
	}
	isFIFO(): boolean {
		return this.#fileType === 5;
	}
	isSocket(): boolean {
		return this.#fileType === 6;
	}
}

// Builds the public API around the given native addon.
export function makeApi(native: NativeBinding): LibRipgrep {
	return {
		compileGlob(globPattern, options) {
			const matcher = native.compileGlob(globPattern, resolveGlobOptions(options));
			return (relativePath) => matcher.isMatch(relativePath);
		},
		grepBuffer(data, options) {
			if (options.patterns.length === 0) {
				throw new TypeError('At least one pattern is required');
			}
			return native.grepBuffer(
				data,
				options.patterns,
				resolveRegexOptions(options.regexOptions)
			);
		},
		async *walkTree(rootPath, options) {
			const walk = native.walkTree(rootPath, resolveWalkOptions(options));
			try {
				let batch;
				while ((batch = await walk.next()) !== null) {
					for (const entry of batch) {
						yield new TreeEntryImpl(entry);
					}
				}
			} finally {
				walk.cancel();
			}
		},
		async *grepTree(_rootPath, _options) {
			native.grepTree();
		},
	};
}
