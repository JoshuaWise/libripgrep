import { compileGlob } from '../src/index';

describe('basic matching', () => {
	test('literals match exactly', () => {
		const m = compileGlob('foo/bar.txt');
		expect(m('foo/bar.txt')).toBe(true);
		expect(m('foo/bar.txt2')).toBe(false);
		expect(m('xfoo/bar.txt')).toBe(false);
	});

	test('* matches within a segment only', () => {
		const m = compileGlob('*.js');
		expect(m('index.js')).toBe(true);
		expect(m('.js')).toBe(true);
		expect(m('src/index.js')).toBe(false);
	});

	test('? matches a single non-separator character', () => {
		const m = compileGlob('a?c');
		expect(m('abc')).toBe(true);
		expect(m('ac')).toBe(false);
		expect(m('a/c')).toBe(false);
	});

	test('** matches across segments', () => {
		const m = compileGlob('**/*.js');
		expect(m('index.js')).toBe(true);
		expect(m('src/index.js')).toBe(true);
		expect(m('src/a/b/index.js')).toBe(true);
		expect(m('index.ts')).toBe(false);
	});

	test('trailing /** matches everything inside a directory', () => {
		const m = compileGlob('src/**');
		expect(m('src/a')).toBe(true);
		expect(m('src/a/b')).toBe(true);
		expect(m('src')).toBe(false);
	});

	test('interior /**/ matches zero or more segments', () => {
		const m = compileGlob('a/**/b');
		expect(m('a/b')).toBe(true);
		expect(m('a/x/b')).toBe(true);
		expect(m('a/x/y/b')).toBe(true);
		expect(m('ab')).toBe(false);
	});

	test('character classes and ranges', () => {
		const m = compileGlob('[a-c].txt');
		expect(m('a.txt')).toBe(true);
		expect(m('c.txt')).toBe(true);
		expect(m('d.txt')).toBe(false);
		const neg = compileGlob('[!a-c].txt');
		expect(neg('d.txt')).toBe(true);
		expect(neg('a.txt')).toBe(false);
	});

	test('alternates', () => {
		const m = compileGlob('*.{js,ts}');
		expect(m('a.js')).toBe(true);
		expect(m('a.ts')).toBe(true);
		expect(m('a.rs')).toBe(false);
	});

	test('alternates can be nested', () => {
		const m = compileGlob('{a,{b,c}}');
		expect(m('a')).toBe(true);
		expect(m('b')).toBe(true);
		expect(m('c')).toBe(true);
		expect(m('d')).toBe(false);
		const suffixed = compileGlob('*.{js,{ts,tsx}}');
		expect(suffixed('x.js')).toBe(true);
		expect(suffixed('x.ts')).toBe(true);
		expect(suffixed('x.tsx')).toBe(true);
		expect(suffixed('x.rs')).toBe(false);
	});

	test('alternates can contain separators and globs', () => {
		const m = compileGlob('{src/**,test}/x.js');
		expect(m('src/a/x.js')).toBe(true);
		expect(m('test/x.js')).toBe(true);
		expect(m('other/x.js')).toBe(false);
	});

	test('matcher is reusable', () => {
		const m = compileGlob('*.txt');
		for (let i = 0; i < 3; i++) {
			expect(m('a.txt')).toBe(true);
			expect(m('a.js')).toBe(false);
		}
	});
});

describe('caseInsensitive', () => {
	test('defaults to case-sensitive', () => {
		expect(compileGlob('*.TXT')('a.txt')).toBe(false);
	});

	test('matches case-insensitively when enabled', () => {
		const m = compileGlob('*.TXT', { caseInsensitive: true });
		expect(m('a.txt')).toBe(true);
		expect(m('A.tXt')).toBe(true);
	});
});

describe('backslashEscape', () => {
	test('defaults to escaping special characters', () => {
		const m = compileGlob('a\\*b');
		expect(m('a*b')).toBe(true);
		expect(m('axb')).toBe(false);
	});

	test('dangling escape throws by default', () => {
		expect(() => compileGlob('abc\\')).toThrow(/dangling/);
	});

	test('treats backslash literally when disabled', () => {
		const m = compileGlob('a\\*b', { backslashEscape: false });
		expect(m('a\\xb')).toBe(true);
		expect(m('a*b')).toBe(false);
	});
});

describe('emptyAlternates', () => {
	test('empty alternates match zero characters by default', () => {
		const m = compileGlob('foo{,.txt}');
		expect(m('foo')).toBe(true);
		expect(m('foo.txt')).toBe(true);
	});

	test('empty alternates are ignored when disabled', () => {
		const m = compileGlob('foo{,.txt}', { emptyAlternates: false });
		expect(m('foo')).toBe(false);
		expect(m('foo.txt')).toBe(true);
	});
});

describe('allowUnclosedClass', () => {
	test('unclosed classes throw by default', () => {
		expect(() => compileGlob('abc[def')).toThrow(/unclosed character class/);
	});

	test('unclosed classes are treated literally when enabled', () => {
		const m = compileGlob('abc[def', { allowUnclosedClass: true });
		expect(m('abc[def')).toBe(true);
		expect(m('abcd')).toBe(false);
	});
});

describe('explicitDotfiles', () => {
	test('wildcards match dotfiles by default', () => {
		expect(compileGlob('*')('.foo')).toBe(true);
		expect(compileGlob('?foo')('.foo')).toBe(true);
		expect(compileGlob('**/*')('a/.foo')).toBe(true);
	});

	test('* does not enter a leading dot', () => {
		const m = compileGlob('*', { explicitDotfiles: true });
		expect(m('foo')).toBe(true);
		expect(m('.foo')).toBe(false);
	});

	test('* cannot match zero characters before a literal dot', () => {
		const m = compileGlob('*.js', { explicitDotfiles: true });
		expect(m('a.js')).toBe(true);
		expect(m('a.b.js')).toBe(true);
		expect(m('.js')).toBe(false);
		expect(m('.a.js')).toBe(false);
	});

	test('? does not match a leading dot', () => {
		const m = compileGlob('?oo', { explicitDotfiles: true });
		expect(m('foo')).toBe(true);
		expect(m('.oo')).toBe(false);
	});

	test('negated classes do not match a leading dot', () => {
		const m = compileGlob('[!x]oo', { explicitDotfiles: true });
		expect(m('foo')).toBe(true);
		expect(m('.oo')).toBe(false);
	});

	test('positive classes may match a leading dot', () => {
		const m = compileGlob('[.f]oo', { explicitDotfiles: true });
		expect(m('foo')).toBe(true);
		expect(m('.oo')).toBe(true);
	});

	test('literal dots still match dotfiles', () => {
		const m = compileGlob('.f*', { explicitDotfiles: true });
		expect(m('.foo')).toBe(true);
		expect(m('foo')).toBe(false);
	});

	test('dots after the first character are unrestricted', () => {
		const m = compileGlob('a*', { explicitDotfiles: true });
		expect(m('a.b')).toBe(true);
		expect(m('a..')).toBe(true);
	});

	test('the rule applies per segment', () => {
		const m = compileGlob('foo/*', { explicitDotfiles: true });
		expect(m('foo/bar')).toBe(true);
		expect(m('foo/.bar')).toBe(false);
	});

	test('** does not enter dot-led segments', () => {
		const m = compileGlob('**', { explicitDotfiles: true });
		expect(m('a/b/c')).toBe(true);
		expect(m('.a')).toBe(false);
		expect(m('a/.b')).toBe(false);
		expect(m('a/.b/c')).toBe(false);
		expect(m('a/b/.c')).toBe(false);
	});

	test('leading **/ does not enter dot-led segments', () => {
		const m = compileGlob('**/foo', { explicitDotfiles: true });
		expect(m('foo')).toBe(true);
		expect(m('a/b/foo')).toBe(true);
		expect(m('.a/foo')).toBe(false);
		expect(m('a/.b/foo')).toBe(false);
	});

	test('trailing /** does not enter dot-led segments', () => {
		const m = compileGlob('a/**', { explicitDotfiles: true });
		expect(m('a/b')).toBe(true);
		expect(m('a/b/c')).toBe(true);
		expect(m('a/.b')).toBe(false);
		expect(m('a/b/.c')).toBe(false);
	});

	test('interior /**/ does not enter dot-led segments', () => {
		const m = compileGlob('a/**/b', { explicitDotfiles: true });
		expect(m('a/b')).toBe(true);
		expect(m('a/x/b')).toBe(true);
		expect(m('a/.x/b')).toBe(false);
	});

	test('star chains stay constrained', () => {
		const m = compileGlob('*?x', { explicitDotfiles: true });
		expect(m('a.x')).toBe(true);
		expect(m('.ax')).toBe(false);
		const mm = compileGlob('**x', { explicitDotfiles: true });
		expect(mm('ax')).toBe(true);
		expect(mm('.x')).toBe(false);
	});

	test('alternates inherit the segment-start constraint', () => {
		const m = compileGlob('{*.js,*.ts}', { explicitDotfiles: true });
		expect(m('a.js')).toBe(true);
		expect(m('.js')).toBe(false);
		expect(m('.a.ts')).toBe(false);
		const lit = compileGlob('{.env,*.txt}', { explicitDotfiles: true });
		expect(lit('.env')).toBe(true);
		expect(lit('.other.txt')).toBe(false);
	});

	test('nested alternates inherit the segment-start constraint', () => {
		const m = compileGlob('{.env,{*.js,*.ts}}', { explicitDotfiles: true });
		expect(m('.env')).toBe(true);
		expect(m('a.js')).toBe(true);
		expect(m('a.ts')).toBe(true);
		expect(m('.js')).toBe(false);
		expect(m('.a.ts')).toBe(false);
	});
});

describe('invalid patterns', () => {
	test('invalid range throws', () => {
		expect(() => compileGlob('[z-a]')).toThrow(/invalid range/);
	});

	test('unopened alternate group throws', () => {
		expect(() => compileGlob('a}b')).toThrow(/unopened alternate group/);
	});

	test('unclosed alternate group throws', () => {
		expect(() => compileGlob('{a,b')).toThrow(/unclosed alternate group/);
	});
});
