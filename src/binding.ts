import type { MatchedLine } from './types';

// GlobOptions with every documented default already applied; the API layer
// owns default resolution, so the native addon only sees resolved options.
export interface ResolvedGlobOptions {
	caseInsensitive: boolean;
	backslashEscape: boolean;
	emptyAlternates: boolean;
	allowUnclosedClass: boolean;
	explicitDotfiles: boolean;
}

// RegexOptions with every documented default already applied.
export interface ResolvedRegexOptions {
	caseInsensitive: boolean;
	multiline: boolean;
	multilineDotall: boolean;
	crlf: boolean;
	unicode: boolean;
}

// WalkOptions with every documented default already applied. `maxDepth` is
// undefined for unlimited depth (JS Infinity), matching napi's Option<u32>.
export interface ResolvedWalkOptions {
	threads: number;
	symlinks: boolean;
	maxDepth: number | undefined;
	ignoreFiles: string[];
	ignoreStyle: 'all' | 'no-git' | 'none';
	includeGlobs: string[];
	excludeGlobs: string[];
	globOptions: ResolvedGlobOptions;
}

// A compiled glob handle returned by the native addon.
export interface NativeGlobMatcher {
	isMatch(relativePath: string): boolean;
}

// One walked entry; name/parentPath are derived from `path` in JS, and
// `fileType` uses the codes from file_type_code() in native/src/walk.rs.
export interface NativeWalkEntry {
	path: string;
	fileType: number;
}

// A running native walk; next() resolves null when the walk is complete.
export interface NativeWalk {
	next(): Promise<NativeWalkEntry[] | null>;
	cancel(): void;
}

// The shape of the native addon (prebuilds/<platform>-<arch>/libripgrep.node).
// Entry points still marked `never` are stubs that always throw; signatures
// will be fleshed out as each implementation phase lands.
export interface NativeBinding {
	compileGlob(globPattern: string, options: ResolvedGlobOptions): NativeGlobMatcher;
	grepBuffer(
		data: Readonly<Buffer>,
		patterns: ReadonlyArray<string>,
		options: ResolvedRegexOptions
	): MatchedLine[];
	walkTree(rootPath: string, options: ResolvedWalkOptions): NativeWalk;
	grepTree(): never;
}
