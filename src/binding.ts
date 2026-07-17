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

// A compiled grep handle returned by the native addon.
export interface NativeGrepMatcher {
	scan(data: Readonly<Buffer>): NativeMatchedLine[];
}

// A matching line returned by napi-rs. Optional Rust object fields may arrive
// as null or undefined and are normalized by the public API layer.
export interface NativeMatchedLine {
	line: string;
	lineNumber: number;
	matches: [number, number][];
	linesBefore?: string[] | null;
	linesAfter?: string[] | null;
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

// GrepTreeOptions with every documented default already applied.
// `maxFileSize` is undefined for unlimited, matching napi's Option.
export interface ResolvedGrepTreeOptions {
	patterns: string[];
	regexOptions: ResolvedRegexOptions;
	beforeContext: number;
	afterContext: number;
	maxFileSize: number | undefined;
	walkOptions: ResolvedWalkOptions;
}

// One matched file produced by the native grep walk.
export interface NativeGrepTreeEntry extends NativeWalkEntry {
	matches: NativeMatchedLine[];
}

// A running native grep walk; next() resolves null when complete.
export interface NativeGrepWalk {
	next(): Promise<NativeGrepTreeEntry[] | null>;
	cancel(): void;
}

// The shape of the native addon (prebuilds/<platform>-<arch>/libripgrep.node).
// Entry points still marked `never` are stubs that always throw; signatures
// will be fleshed out as each implementation phase lands.
export interface NativeBinding {
	compileGlob(globPattern: string, options: ResolvedGlobOptions): NativeGlobMatcher;
	compileGrep(
		patterns: ReadonlyArray<string>,
		options: ResolvedRegexOptions,
		beforeContext: number,
		afterContext: number
	): NativeGrepMatcher;
	walkTree(rootPath: string, options: ResolvedWalkOptions): NativeWalk;
	grepTree(rootPath: string, options: ResolvedGrepTreeOptions): NativeGrepWalk;
}
