import { compileGlob, grepBuffer, walkTree, grepTree } from '../src/index';

describe('addon loading', () => {
	test('the auto-detected entry point exposes the four public functions', () => {
		expect(typeof compileGlob).toBe('function');
		expect(typeof grepBuffer).toBe('function');
		expect(typeof walkTree).toBe('function');
		expect(typeof grepTree).toBe('function');
	});

	test('the platform-specific entry point loads without auto-detection', () => {
		const platformArch = `${process.platform}-${process.arch}`;
		const pinned: typeof import('../src/index') = require(`../src/${platformArch}`);
		expect(typeof pinned.compileGlob).toBe('function');
		expect(typeof pinned.grepBuffer).toBe('function');
		expect(typeof pinned.walkTree).toBe('function');
		expect(typeof pinned.grepTree).toBe('function');
	});
});

describe('stubs', () => {
	test('compileGlob throws not implemented', () => {
		expect(() => compileGlob('**/*.js')).toThrow(/not implemented/);
	});

	test('grepBuffer throws not implemented', () => {
		expect(() => grepBuffer(Buffer.from('hello'), { patterns: ['h'] })).toThrow(
			/not implemented/
		);
	});

	test('walkTree rejects not implemented', async () => {
		await expect(walkTree('.').next()).rejects.toThrow(/not implemented/);
	});

	test('grepTree rejects not implemented', async () => {
		await expect(grepTree('.', { patterns: ['h'] }).next()).rejects.toThrow(
			/not implemented/
		);
	});
});
