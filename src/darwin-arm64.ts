import { makeApi } from './api';
import type { NativeBinding } from './binding';

// Entry point explicitly bound to the darwin-arm64 addon binary; performs no
// platform auto-detection anywhere in its require graph.
const native: NativeBinding = require('../prebuilds/darwin-arm64/libripgrep.node');

export const { compileGlob, grepBuffer, walkTree, grepTree } = makeApi(native);
export type {
	GlobOptions,
	GrepOptions,
	GrepTreeOptions,
	GrepTreeResult,
	MatchedLine,
	RegexOptions,
	TreeEntry,
	WalkOptions,
} from './types';
