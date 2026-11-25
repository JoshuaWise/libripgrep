import { compileGrep, GrepOptions, MatchedLine } from '../src/index';

function buf(text: string): Buffer {
	return Buffer.from(text, 'utf8');
}

// One-shot helper: compile and scan in a single call.
function grep(data: Buffer, options: GrepOptions): MatchedLine[] {
	return compileGrep(options)(data);
}

describe('basic matching', () => {
	test('returns matching lines with 1-based line numbers and offsets', () => {
		const results = grep(buf('foo\nbar\nfoobar\n'), { patterns: ['foo'] });
		expect(results).toEqual([
			{ line: 'foo', lineNumber: 1, matches: [[0, 3]] },
			{ line: 'foobar', lineNumber: 3, matches: [[0, 3]] },
		]);
	});

	test('reports every match within a line', () => {
		const results = grep(buf('a foo b foo c\n'), { patterns: ['foo'] });
		expect(results).toEqual([
			{
				line: 'a foo b foo c',
				lineNumber: 1,
				matches: [
					[2, 5],
					[8, 11],
				],
			},
		]);
	});

	test('multiple patterns act as an alternation', () => {
		const results = grep(buf('foo bar\nbaz\nqux\n'), {
			patterns: ['foo', 'bar', 'qux'],
		});
		expect(results).toEqual([
			{
				line: 'foo bar',
				lineNumber: 1,
				matches: [
					[0, 3],
					[4, 7],
				],
			},
			{ line: 'qux', lineNumber: 3, matches: [[0, 3]] },
		]);
	});

	test('a line without a trailing newline is searched', () => {
		const results = grep(buf('foo\nbar'), { patterns: ['bar'] });
		expect(results).toEqual([{ line: 'bar', lineNumber: 2, matches: [[0, 3]] }]);
	});

	test('an empty buffer has no lines', () => {
		expect(grep(buf(''), { patterns: ['.*'] })).toEqual([]);
	});

	test('no matches yields an empty array', () => {
		expect(grep(buf('foo\nbar\n'), { patterns: ['xyz'] })).toEqual([]);
	});

	test('includes requested lines before and after each match', () => {
		const results = grep(buf('zero\n\none\ntwo\nthree\nfour\n'), {
			patterns: ['one|three'],
			beforeContext: 2,
			afterContext: 1,
		});
		expect(results).toEqual([
			{
				line: 'one',
				lineNumber: 3,
				matches: [[0, 3]],
				linesBefore: ['zero', ''],
				linesAfter: ['two'],
			},
			{
				line: 'three',
				lineNumber: 5,
				matches: [[0, 5]],
				linesBefore: ['one', 'two'],
				linesAfter: ['four'],
			},
		]);
	});

	test('context is truncated at file boundaries', () => {
		expect(
			grep(buf('first\nlast'), {
				patterns: ['first|last'],
				beforeContext: 3,
				afterContext: 3,
			})
		).toEqual([
			{
				line: 'first',
				lineNumber: 1,
				matches: [[0, 5]],
				linesBefore: [],
				linesAfter: ['last'],
			},
			{
				line: 'last',
				lineNumber: 2,
				matches: [[0, 4]],
				linesBefore: ['first'],
				linesAfter: [],
			},
		]);
	});

	test('context properties are always present and independently optional', () => {
		const withoutContext = grep(buf('match\n'), { patterns: ['match'] })[0];
		expect(Object.hasOwn(withoutContext, 'linesBefore')).toBe(true);
		expect(Object.hasOwn(withoutContext, 'linesAfter')).toBe(true);
		expect(withoutContext.linesBefore).toBeUndefined();
		expect(withoutContext.linesAfter).toBeUndefined();

		const withBefore = grep(buf('before\nmatch\n'), {
			patterns: ['match'],
			beforeContext: 1,
		})[0];
		expect(withBefore.linesBefore).toEqual(['before']);
		expect(withBefore.linesAfter).toBeUndefined();
	});
});

describe('regex semantics', () => {
	test('^ and $ anchor at line boundaries', () => {
		const results = grep(buf('ab\nb\nba\n'), { patterns: ['^b$'] });
		expect(results).toEqual([{ line: 'b', lineNumber: 2, matches: [[0, 1]] }]);
	});

	test('empty matches are reported at their positions', () => {
		const results = grep(buf('ab\ncd\n'), { patterns: ['^'] });
		expect(results).toEqual([
			{ line: 'ab', lineNumber: 1, matches: [[0, 0]] },
			{ line: 'cd', lineNumber: 2, matches: [[0, 0]] },
		]);
	});

	test('an empty match after the final newline has no line', () => {
		const results = grep(buf('a\n'), { patterns: ['$'] });
		expect(results).toEqual([{ line: 'a', lineNumber: 1, matches: [[1, 1]] }]);
	});

	test('NUL bytes are banned from patterns like ripgrep', () => {
		expect(() => grep(buf('ab'), { patterns: ['a\\x00'] })).toThrow();
	});
});

describe('regexOptions', () => {
	test('caseInsensitive', () => {
		expect(grep(buf('FOO\n'), { patterns: ['foo'] })).toEqual([]);
		const results = grep(buf('FOO\n'), {
			patterns: ['foo'],
			regexOptions: { caseInsensitive: true },
		});
		expect(results).toEqual([{ line: 'FOO', lineNumber: 1, matches: [[0, 3]] }]);
	});

	test('patterns containing \\n are rejected without multiline', () => {
		expect(() => grep(buf('a\nb'), { patterns: ['a\\nb'] })).toThrow(/not allowed/);
	});

	test('multiline matches span lines, clipped per line', () => {
		const results = grep(buf('xa\nby\n'), {
			patterns: ['a\\nb'],
			regexOptions: { multiline: true },
		});
		expect(results).toEqual([
			{ line: 'xa', lineNumber: 1, matches: [[1, 2]] },
			{ line: 'by', lineNumber: 2, matches: [[0, 1]] },
		]);
	});

	test('a match spanning three lines reports each line', () => {
		const results = grep(buf('a\nbbb\nc\n'), {
			patterns: ['a[\\s\\S]*c'],
			regexOptions: { multiline: true },
		});
		expect(results).toEqual([
			{ line: 'a', lineNumber: 1, matches: [[0, 1]] },
			{ line: 'bbb', lineNumber: 2, matches: [[0, 3]] },
			{ line: 'c', lineNumber: 3, matches: [[0, 1]] },
		]);
	});

	test('multilineDotall lets . match line terminators', () => {
		expect(
			grep(buf('a\nb\n'), {
				patterns: ['a.b'],
				regexOptions: { multiline: true },
			})
		).toEqual([]);
		const results = grep(buf('a\nb\n'), {
			patterns: ['a.b'],
			regexOptions: { multiline: true, multilineDotall: true },
		});
		expect(results).toEqual([
			{ line: 'a', lineNumber: 1, matches: [[0, 1]] },
			{ line: 'b', lineNumber: 2, matches: [[0, 1]] },
		]);
	});

	test('multilineDotall has no effect without multiline', () => {
		expect(
			grep(buf('a\nb\n'), {
				patterns: ['a.b'],
				regexOptions: { multilineDotall: true },
			})
		).toEqual([]);
	});

	test('crlf is enabled by default: \\r is stripped and $ matches before it', () => {
		const data = buf('foo\r\nbar\r\n');
		expect(grep(data, { patterns: ['foo$'] })).toEqual([
			{ line: 'foo', lineNumber: 1, matches: [[0, 3]] },
		]);
	});

	test('crlf: false keeps \\r in lines and $ stops matching before \\r\\n', () => {
		const data = buf('foo\r\nbar\r\n');
		expect(grep(data, { patterns: ['foo$'], regexOptions: { crlf: false } })).toEqual(
			[]
		);
		expect(grep(data, { patterns: ['o\\r'], regexOptions: { crlf: false } })).toEqual(
			[{ line: 'foo\r', lineNumber: 1, matches: [[2, 4]] }]
		);
	});

	test('unicode is enabled by default', () => {
		const results = grep(buf('héllo\n'), { patterns: ['h\\wllo'] });
		expect(results).toEqual([{ line: 'héllo', lineNumber: 1, matches: [[0, 5]] }]);
		expect(
			grep(buf('héllo\n'), {
				patterns: ['h\\wllo'],
				regexOptions: { unicode: false },
			})
		).toEqual([]);
	});
});

describe('UTF-16 offsets', () => {
	test('offsets count UTF-16 code units, not bytes', () => {
		// '𝒳' is 4 bytes in UTF-8 but 2 UTF-16 code units.
		const results = grep(buf('𝒳x\n'), { patterns: ['x'] });
		expect(results).toEqual([{ line: '𝒳x', lineNumber: 1, matches: [[2, 3]] }]);
		expect('𝒳x'.slice(2, 3)).toBe('x');
	});

	test('offsets are correct for multi-byte BMP characters', () => {
		const results = grep(buf('éé-x\n'), { patterns: ['x'] });
		expect(results).toEqual([{ line: 'éé-x', lineNumber: 1, matches: [[3, 4]] }]);
	});
});

describe('encodings', () => {
	test('UTF-16 LE BOM', () => {
		const data = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('foo\nbär\n', 'utf16le'),
		]);
		const results = grep(data, { patterns: ['bär'] });
		expect(results).toEqual([{ line: 'bär', lineNumber: 2, matches: [[0, 3]] }]);
	});

	test('UTF-16 BE BOM', () => {
		const le = Buffer.from('foo\nbär\n', 'utf16le');
		le.swap16();
		const data = Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
		const results = grep(data, { patterns: ['bär'] });
		expect(results).toEqual([{ line: 'bär', lineNumber: 2, matches: [[0, 3]] }]);
	});

	test('UTF-8 BOM is stripped', () => {
		const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf('foo\n')]);
		const results = grep(data, { patterns: ['foo'] });
		expect(results).toEqual([{ line: 'foo', lineNumber: 1, matches: [[0, 3]] }]);
	});

	test('invalid UTF-8 bytes become replacement characters', () => {
		const data = Buffer.concat([buf('a'), Buffer.from([0xff]), buf('b\n')]);
		const results = grep(data, { patterns: ['b'] });
		expect(results).toEqual([{ line: 'a�b', lineNumber: 1, matches: [[2, 3]] }]);
	});
});

describe('binary detection', () => {
	test('buffers containing NUL are ignored', () => {
		const data = Buffer.concat([buf('foo\n'), Buffer.from([0x00]), buf('foo\n')]);
		expect(grep(data, { patterns: ['foo'] })).toEqual([]);
	});

	test('UTF-16 buffers containing U+0000 are ignored', () => {
		const data = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('foo foo', 'utf16le'),
		]);
		expect(grep(data, { patterns: ['foo'] })).toEqual([]);
	});
});

describe('matcher reuse', () => {
	test('a compiled matcher can scan many buffers', () => {
		const scan = compileGrep({ patterns: ['foo'] });
		expect(scan(buf('foo\n'))).toEqual([
			{ line: 'foo', lineNumber: 1, matches: [[0, 3]] },
		]);
		expect(scan(buf('bar\n'))).toEqual([]);
		expect(scan(buf('x foo\n'))).toEqual([
			{ line: 'x foo', lineNumber: 1, matches: [[2, 5]] },
		]);
	});

	test('BOM and binary handling are per buffer', () => {
		const scan = compileGrep({ patterns: ['foo'] });
		const utf16 = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('foo\n', 'utf16le'),
		]);
		const binary = Buffer.concat([buf('foo'), Buffer.from([0x00])]);
		expect(scan(utf16)).toHaveLength(1);
		expect(scan(binary)).toEqual([]);
		expect(scan(buf('foo\n'))).toHaveLength(1);
	});
});

describe('argument validation', () => {
	test('an empty patterns array throws a TypeError at compile time', () => {
		const patterns: [string, ...string[]] = ['x'];
		patterns.pop();
		expect(() => compileGrep({ patterns })).toThrow(TypeError);
	});

	test('invalid regexes throw at compile time, before any data', () => {
		expect(() => compileGrep({ patterns: ['('] })).toThrow();
	});

	test('invalid context sizes throw a TypeError', () => {
		expect(() => compileGrep({ patterns: ['x'], beforeContext: -1 })).toThrow(
			TypeError
		);
		expect(() => compileGrep({ patterns: ['x'], afterContext: 1.5 })).toThrow(
			TypeError
		);
	});
});

describe('finalEmptyLine', () => {
	// Every line, numbered and split the way JavaScript's split(/\r?\n/) does.
	function splitLines(text: string): { line: string; lineNumber: number }[] {
		return text.split(/\r?\n/).map((line, i) => ({ line, lineNumber: i + 1 }));
	}

	function everyLine(data: Buffer, options?: Partial<GrepOptions>): MatchedLine[] {
		return grep(data, { patterns: ['^'], finalEmptyLine: true, ...options });
	}

	test.each([
		'a\nb\n',
		'x\n\n\n',
		'a\r\nb\rc\n\nd\n',
		'a\nb',
		'a\r\n',
		'\n',
		'one\r\n\r\ntwo\r\n',
		'é😀\nü\n',
	])('line numbers and contents agree with split(/\\r?\\n/) for %j', (text) => {
		const results = everyLine(buf(text));
		expect(results.map(({ line, lineNumber }) => ({ line, lineNumber }))).toEqual(
			splitLines(text)
		);
	});

	test('defaults to false (like ripgrep)', () => {
		expect(
			grep(buf('x\n\n\n'), { patterns: ['^'] }).map((r) => r.lineNumber)
		).toEqual([1, 2, 3]);
		expect(grep(buf('a\n'), { patterns: ['^$'] })).toEqual([]);
	});

	test.each(['^', '$', '^$', '.*'])('%s matches the final empty line', (pattern) => {
		const results = grep(buf('a\n'), { patterns: [pattern], finalEmptyLine: true });
		expect(results[results.length - 1]).toEqual({
			line: '',
			lineNumber: 2,
			matches: [[0, 0]],
		});
		expect(results.every((r) => r.lineNumber <= 2)).toBe(true);
	});

	test('no final terminator and an empty buffer are unchanged', () => {
		expect(grep(buf('a'), { patterns: ['^'], finalEmptyLine: true })).toEqual([
			{ line: 'a', lineNumber: 1, matches: [[0, 0]] },
		]);
		expect(grep(buf(''), { patterns: ['^'], finalEmptyLine: true })).toEqual([]);
		expect(
			grep(Buffer.from([0xef, 0xbb, 0xbf]), {
				patterns: ['^'],
				finalEmptyLine: true,
			})
		).toEqual([]);
	});

	test('a multiline match ending at EOF does not touch the final empty line', () => {
		expect(
			grep(buf('a\n'), {
				patterns: ['a\\n'],
				finalEmptyLine: true,
				regexOptions: { multiline: true },
			})
		).toEqual([{ line: 'a', lineNumber: 1, matches: [[0, 1]] }]);
		expect(
			grep(buf('a\nb\n'), {
				patterns: ['^$'],
				finalEmptyLine: true,
				regexOptions: { multiline: true },
			})
		).toEqual([{ line: '', lineNumber: 3, matches: [[0, 0]] }]);
	});

	test('with crlf disabled, \\r stays in the line and \\n still ends it', () => {
		expect(
			everyLine(buf('a\r\nb\r\n'), { regexOptions: { crlf: false } }).map(
				(r) => r.line
			)
		).toEqual(['a\r', 'b\r', '']);
		expect(
			grep(buf('a\r\n'), {
				patterns: ['$'],
				finalEmptyLine: true,
				regexOptions: { crlf: false },
			})
		).toEqual([
			{ line: 'a\r', lineNumber: 1, matches: [[2, 2]] },
			{ line: '', lineNumber: 2, matches: [[0, 0]] },
		]);
	});

	test('context lines include the final empty line on both sides', () => {
		expect(
			grep(buf('a\nb\n'), {
				patterns: ['b'],
				finalEmptyLine: true,
				afterContext: 3,
			})
		).toEqual([{ line: 'b', lineNumber: 2, matches: [[0, 1]], linesAfter: [''] }]);
		expect(
			grep(buf('a\nb\n'), {
				patterns: ['^$'],
				finalEmptyLine: true,
				beforeContext: 3,
			})
		).toEqual([
			{ line: '', lineNumber: 3, matches: [[0, 0]], linesBefore: ['a', 'b'] },
		]);
	});

	test.each(['utf16le', 'utf16be'])('applies to %s input with a BOM', (encoding) => {
		const text = 'a\r\nb\n';
		const le = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(text, 'utf16le'),
		]);
		const data = encoding === 'utf16le' ? le : Buffer.from(le).swap16();
		expect(
			everyLine(data).map(({ line, lineNumber }) => ({ line, lineNumber }))
		).toEqual(splitLines(text));
	});
});
