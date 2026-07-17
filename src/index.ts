import { makeApi } from './api';
import type { NativeBinding } from './binding';

// The platform-arch pairs for which prebuilt addon binaries are provided.
const SUPPORTED_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

const platformArch = `${process.platform}-${process.arch}`;
if (!SUPPORTED_PLATFORMS.includes(platformArch)) {
	throw new Error(`libripgrep does not support this platform: ${platformArch}`);
}

const native: NativeBinding = require(`../prebuilds/${platformArch}/libripgrep.node`);

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
