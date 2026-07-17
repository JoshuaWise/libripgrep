import type { NativeBinding } from './binding';
import type {
	GlobOptions,
	GrepOptions,
	GrepTreeOptions,
	GrepTreeResult,
	MatchedLine,
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

// Builds the public API around the given native addon.
export function makeApi(native: NativeBinding): LibRipgrep {
	return {
		compileGlob(_globPattern, _options) {
			return native.compileGlob();
		},
		grepBuffer(_data, _options) {
			return native.grepBuffer();
		},
		async *walkTree(_rootPath, _options) {
			native.walkTree();
		},
		async *grepTree(_rootPath, _options) {
			native.grepTree();
		},
	};
}
