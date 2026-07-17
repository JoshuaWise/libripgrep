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

// A compiled glob handle returned by the native addon.
export interface NativeGlobMatcher {
	isMatch(relativePath: string): boolean;
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
	walkTree(): never;
	grepTree(): never;
}
