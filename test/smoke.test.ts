import { compileGlob, compileGrep, walkTree, grepTree } from '../src/index';

describe('addon loading', () => {
	test('the auto-detected entry point exposes the four public functions', () => {
		expect(typeof compileGlob).toBe('function');
		expect(typeof compileGrep).toBe('function');
		expect(typeof walkTree).toBe('function');
		expect(typeof grepTree).toBe('function');
	});

	test('the platform-specific entry point loads without auto-detection', () => {
		const platformArch = `${process.platform}-${process.arch}`;
		const pinned: typeof import('../src/index') = require(`../src/${platformArch}`);
		expect(typeof pinned.compileGlob).toBe('function');
		expect(typeof pinned.compileGrep).toBe('function');
		expect(typeof pinned.walkTree).toBe('function');
		expect(typeof pinned.grepTree).toBe('function');
	});
});
