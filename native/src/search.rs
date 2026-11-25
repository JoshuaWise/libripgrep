use std::borrow::Cow;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};

// Resolved regex options; mirrors ResolvedRegexOptions in src/binding.ts.
#[derive(Clone, Copy, Debug)]
pub struct RegexConfig {
    pub case_insensitive: bool,
    pub multiline: bool,
    pub multiline_dotall: bool,
    pub crlf: bool,
    pub unicode: bool,
}

// A matching line and the spans of every match within it.
pub struct LineMatch {
    pub line: String,
    pub line_number: u32,
    // UTF-16 code-unit offsets into `line`.
    pub matches: Vec<(u32, u32)>,
    pub lines_before: Option<Vec<String>>,
    pub lines_after: Option<Vec<String>>,
}

/*
Builds a single matcher that is an alternation of all the given patterns,
configured exactly like ripgrep's default Rust-regex matcher (see
matcher_rust() in ripgrep's crates/core/flags/hiargs.rs): `multi_line(true)`
so that ^/$ anchor at line boundaries, NUL banned from patterns (as ripgrep
does whenever binary detection is enabled), and in non-multiline mode a \n
line terminator so that no match can span lines. The grep-regex crate's
default size limits are ripgrep's defaults (100 MiB regex, 1000 MiB DFA), so
they are left untouched.
*/
pub fn build_matcher(patterns: &[String], config: &RegexConfig) -> Result<RegexMatcher, String> {
    let mut builder = RegexMatcherBuilder::new();
    builder
        .multi_line(true)
        .unicode(config.unicode)
        .octal(false)
        .case_insensitive(config.case_insensitive)
        .ban_byte(Some(b'\x00'));
    if config.multiline {
        builder.dot_matches_new_line(config.multiline_dotall);
        if config.crlf {
            builder.crlf(true).line_terminator(None);
        }
    } else {
        builder
            .line_terminator(Some(b'\n'))
            .dot_matches_new_line(false);
        if config.crlf {
            builder.crlf(true);
        }
    }
    builder.build_many(patterns).map_err(|err| err.to_string())
}

// Detects a BOM and returns the searchable UTF-8 bytes: UTF-16 (either
// endianness) is transcoded, a UTF-8 BOM is stripped, and anything else is
// assumed to already be UTF-8. No other detection is performed.
pub fn decode_bom(data: &[u8]) -> Cow<'_, [u8]> {
    match data {
        [0xff, 0xfe, rest @ ..] => Cow::Owned(decode_utf16(rest, false).into_bytes()),
        [0xfe, 0xff, rest @ ..] => Cow::Owned(decode_utf16(rest, true).into_bytes()),
        [0xef, 0xbb, 0xbf, rest @ ..] => Cow::Borrowed(rest),
        _ => Cow::Borrowed(data),
    }
}

// Lossily decodes UTF-16, replacing unpaired surrogates and a trailing odd
// byte with U+FFFD.
fn decode_utf16(data: &[u8], big_endian: bool) -> String {
    let units = data.chunks_exact(2).map(|pair| {
        let pair = [pair[0], pair[1]];
        if big_endian {
            u16::from_be_bytes(pair)
        } else {
            u16::from_le_bytes(pair)
        }
    });
    let mut decoded: String = char::decode_utf16(units)
        .map(|result| result.unwrap_or('\u{FFFD}'))
        .collect();
    if data.len() % 2 == 1 {
        decoded.push('\u{FFFD}');
    }
    decoded
}

// Returns true if the data should be treated as binary and not searched,
// using ripgrep's default heuristic of looking for NUL bytes. This runs on
// decoded data, so a UTF-16 buffer containing U+0000 also counts as binary.
pub fn is_binary(data: &[u8]) -> bool {
    memchr::memchr(b'\x00', data).is_some()
}

// Reads and searches one file (no mmap), returning None if it is
// unreadable, binary, or has no matching lines. Runs on walker threads.
pub fn search_file(
    matcher: &RegexMatcher,
    crlf: bool,
    final_empty_line: bool,
    before_context: usize,
    after_context: usize,
    path: &std::path::Path,
) -> Option<Vec<LineMatch>> {
    let data = std::fs::read(path).ok()?;
    let decoded = decode_bom(&data);
    if is_binary(&decoded) {
        return None;
    }
    let matches = search_lines(
        matcher,
        crlf,
        final_empty_line,
        before_context,
        after_context,
        &decoded,
    );
    if matches.is_empty() {
        None
    } else {
        Some(matches)
    }
}

/*
Scans `data` (assumed UTF-8) for all lines with at least one match. Matches
come from a single find_iter pass over the whole buffer (non-overlapping,
leftmost-first across the pattern alternation), then are assigned to lines:

- Lines always split on \n; when `crlf` is set, a trailing \r is excluded
  from the line's content (matching ripgrep's --crlf).
- A match spanning multiple lines (multiline mode) is clipped to each line
  it touches; the portion falling inside a line terminator clamps to an
  empty span at the end of the line's content.
- An empty match belongs to the line whose content region contains it. An
  empty match past a final \n (e.g. `$` at EOF of "a\n") has no line and is
  dropped, unless `final_empty_line` is set: then data ending in \n has one
  more empty, unterminated line after it.

Byte offsets are converted to UTF-16 code-unit offsets while decoding each
matched line, replacing invalid UTF-8 exactly like String::from_utf8_lossy.
*/
pub fn search_lines(
    matcher: &RegexMatcher,
    crlf: bool,
    final_empty_line: bool,
    before_context: usize,
    after_context: usize,
    data: &[u8],
) -> Vec<LineMatch> {
    // An empty buffer has no lines (an empty match at EOF has no home).
    if data.is_empty() {
        return vec![];
    }
    let mut spans = vec![];
    matcher
        .find_iter(data, |m| {
            spans.push((m.start(), m.end()));
            true
        })
        .expect("RegexMatcher's error type is NoError");
    let mut results = vec![];
    if spans.is_empty() {
        return results;
    }

    let mut line = LineBounds::at(data, 0, 1, crlf);
    let mut pending: Vec<(usize, usize)> = vec![];
    // Flushes the matches collected for the current line, then advances to
    // the next line. Returns false at the end of the buffer.
    let advance =
        |line: &mut LineBounds, pending: &mut Vec<(usize, usize)>, results: &mut Vec<LineMatch>| {
            if !pending.is_empty() {
                results.push(finish_line(data, line, pending));
                pending.clear();
            }
            match line.next(data, crlf, final_empty_line) {
                Some(next) => {
                    *line = next;
                    true
                }
                None => false,
            }
        };

    'spans: for &(start, end) in &spans {
        if start == end {
            // Empty match: find the line whose content region contains it.
            while start > line.content_end {
                if !advance(&mut line, &mut pending, &mut results) {
                    break 'spans;
                }
            }
            if start >= line.start {
                pending.push((start, start));
            }
        } else {
            let mut start = start;
            loop {
                while start >= line.term_end {
                    if !advance(&mut line, &mut pending, &mut results) {
                        break 'spans;
                    }
                }
                let s = start.max(line.start).min(line.content_end);
                let e = end.min(line.content_end).max(s);
                pending.push((s, e));
                if end > line.term_end {
                    start = line.term_end;
                } else {
                    break;
                }
            }
        }
    }
    if !pending.is_empty() {
        results.push(finish_line(data, &line, &pending));
    }
    add_context(
        data,
        crlf,
        final_empty_line,
        before_context,
        after_context,
        &mut results,
    );
    results
}

// Adds adjacent physical lines to matched lines only when requested.
fn add_context(
    data: &[u8],
    crlf: bool,
    final_empty_line: bool,
    before_context: usize,
    after_context: usize,
    results: &mut [LineMatch],
) {
    if before_context == 0 && after_context == 0 {
        return;
    }
    let mut lines = vec![];
    let mut line = Some(LineBounds::at(data, 0, 1, crlf));
    while let Some(current) = line {
        lines.push(String::from_utf8_lossy(&data[current.start..current.content_end]).into_owned());
        line = current.next(data, crlf, final_empty_line);
    }
    for result in results {
        let index = result.line_number as usize - 1;
        if before_context > 0 {
            let start = index.saturating_sub(before_context);
            result.lines_before = Some(lines[start..index].to_vec());
        }
        if after_context > 0 {
            let end = (index + 1 + after_context).min(lines.len());
            result.lines_after = Some(lines[index + 1..end].to_vec());
        }
    }
}

struct LineBounds {
    start: usize,
    // End of the line's content, excluding the terminator.
    content_end: usize,
    // End of the line including its terminator (start of the next line).
    term_end: usize,
    number: u32,
}

impl LineBounds {
    fn at(data: &[u8], start: usize, number: u32, crlf: bool) -> LineBounds {
        let (content_end, term_end) = match memchr::memchr(b'\n', &data[start..]) {
            Some(i) => (start + i, start + i + 1),
            None => (data.len(), data.len()),
        };
        let content_end = if crlf && content_end > start && data[content_end - 1] == b'\r' {
            content_end - 1
        } else {
            content_end
        };
        LineBounds {
            start,
            content_end,
            term_end,
            number,
        }
    }

    // Returns the following line, or None at the end of the buffer. With
    // `final_empty_line`, a line ending in \n at EOF is followed by one more
    // empty line.
    fn next(&self, data: &[u8], crlf: bool, final_empty_line: bool) -> Option<LineBounds> {
        let has_more = self.term_end < data.len()
            || (final_empty_line && self.term_end > self.start && data[self.term_end - 1] == b'\n');
        has_more.then(|| LineBounds::at(data, self.term_end, self.number + 1, crlf))
    }
}

// Decodes one matched line and converts its match spans (absolute byte
// offsets) to UTF-16 code-unit offsets within the line. Invalid UTF-8 is
// replaced with U+FFFD exactly like String::from_utf8_lossy; a boundary
// falling inside a multi-byte character resolves to the following character.
fn finish_line(data: &[u8], line: &LineBounds, spans: &[(usize, usize)]) -> LineMatch {
    let bytes = &data[line.start..line.content_end];
    // Spans are non-overlapping and sorted, so their flattened boundaries
    // are non-decreasing and can be resolved in one pass.
    let boundaries: Vec<usize> = spans
        .iter()
        .flat_map(|&(s, e)| [s - line.start, e - line.start])
        .collect();
    let mut resolved: Vec<u32> = Vec::with_capacity(boundaries.len());
    let mut next_boundary = 0usize;
    let mut resolve = |byte_pos: usize, utf16_pos: u32| {
        while next_boundary < boundaries.len() && boundaries[next_boundary] <= byte_pos {
            resolved.push(utf16_pos);
            next_boundary += 1;
        }
    };

    let mut text = String::with_capacity(bytes.len());
    let mut byte_pos = 0usize;
    let mut utf16_pos = 0u32;
    let mut remaining = bytes;
    while !remaining.is_empty() {
        // error_len is None when the rest of the input is valid UTF-8.
        let (valid, error_len) = match std::str::from_utf8(remaining) {
            Ok(valid) => (valid, None),
            Err(err) => {
                let valid =
                    std::str::from_utf8(&remaining[..err.valid_up_to()]).expect("valid prefix");
                let error_len = err
                    .error_len()
                    .unwrap_or(remaining.len() - err.valid_up_to());
                (valid, Some(error_len))
            }
        };
        for c in valid.chars() {
            resolve(byte_pos, utf16_pos);
            text.push(c);
            byte_pos += c.len_utf8();
            utf16_pos += u32::try_from(c.len_utf16()).expect("len_utf16 is 1 or 2");
        }
        let Some(error_len) = error_len else { break };
        resolve(byte_pos, utf16_pos);
        text.push('\u{FFFD}');
        byte_pos += error_len;
        utf16_pos += 1;
        remaining = &remaining[valid.len() + error_len..];
    }
    resolve(bytes.len(), utf16_pos);
    let matches = resolved
        .chunks_exact(2)
        .map(|pair| (pair[0], pair[1]))
        .collect();
    LineMatch {
        line: text,
        line_number: line.number,
        matches,
        lines_before: None,
        lines_after: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Line = (u32, String, Vec<(u32, u32)>);

    fn config(multiline: bool, crlf: bool) -> RegexConfig {
        RegexConfig {
            case_insensitive: false,
            multiline,
            multiline_dotall: false,
            crlf,
            unicode: true,
        }
    }

    fn search(
        pattern: &str,
        config: &RegexConfig,
        final_empty_line: bool,
        data: &str,
    ) -> Vec<Line> {
        let matcher = build_matcher(&[pattern.to_string()], config).unwrap();
        search_lines(
            &matcher,
            config.crlf,
            final_empty_line,
            0,
            0,
            data.as_bytes(),
        )
        .into_iter()
        .map(|m| (m.line_number, m.line, m.matches))
        .collect()
    }

    fn line(number: u32, text: &str, matches: &[(u32, u32)]) -> Line {
        (number, text.to_string(), matches.to_vec())
    }

    #[test]
    fn empty_matches_at_eof_belong_to_the_final_empty_line() {
        let cfg = config(false, true);
        for pattern in ["^", "$", "^$", ".*"] {
            assert!(
                search(pattern, &cfg, false, "a\n")
                    .iter()
                    .all(|(number, ..)| *number == 1),
                "{pattern}"
            );
            assert_eq!(
                search(pattern, &cfg, true, "a\n").last(),
                Some(&line(2, "", &[(0, 0)])),
                "{pattern}"
            );
        }
        assert_eq!(
            search("^", &cfg, true, "x\n\n\n"),
            (1..=4)
                .map(|n| line(n, if n == 1 { "x" } else { "" }, &[(0, 0)]))
                .collect::<Vec<_>>()
        );
        assert_eq!(search("^", &cfg, false, "x\n\n\n").len(), 3);
    }

    #[test]
    fn crlf_terminator_is_followed_by_the_final_empty_line() {
        let cfg = config(false, true);
        assert_eq!(
            search("^", &cfg, true, "a\r\n"),
            vec![line(1, "a", &[(0, 0)]), line(2, "", &[(0, 0)])]
        );
        let no_crlf = config(false, false);
        assert_eq!(
            search("^", &no_crlf, true, "a\r\n"),
            vec![line(1, "a\r", &[(0, 0)]), line(2, "", &[(0, 0)])]
        );
    }

    #[test]
    fn data_without_a_final_terminator_is_unchanged() {
        let cfg = config(false, true);
        assert_eq!(search("^", &cfg, true, "a"), vec![line(1, "a", &[(0, 0)])]);
        assert_eq!(search("^", &cfg, true, ""), vec![]);
        // A trailing lone \r isn't a line terminator.
        assert_eq!(
            search("$", &cfg, true, "a\r"),
            search("$", &cfg, false, "a\r")
        );
    }

    #[test]
    fn multiline_match_ending_at_eof_does_not_touch_the_final_empty_line() {
        let cfg = config(true, true);
        assert_eq!(
            search("a\n", &cfg, true, "a\n"),
            vec![line(1, "a", &[(0, 1)])]
        );
        assert_eq!(
            search("a\n$", &cfg, true, "a\n"),
            vec![line(1, "a", &[(0, 1)])]
        );
        assert_eq!(
            search("^$", &cfg, true, "a\n\n"),
            vec![line(2, "", &[(0, 0)]), line(3, "", &[(0, 0)])]
        );
    }

    #[test]
    fn context_includes_the_final_empty_line() {
        let cfg = config(false, true);
        let matcher = build_matcher(&["b".to_string()], &cfg).unwrap();
        let after = search_lines(&matcher, true, true, 0, 2, b"a\nb\n");
        assert_eq!(after[0].lines_after, Some(vec!["".to_string()]));
        let after = search_lines(&matcher, true, false, 0, 2, b"a\nb\n");
        assert_eq!(after[0].lines_after, Some(vec![]));

        let matcher = build_matcher(&["^$".to_string()], &cfg).unwrap();
        let before = search_lines(&matcher, true, true, 2, 0, b"a\nb\n");
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].line_number, 3);
        assert_eq!(
            before[0].lines_before,
            Some(vec!["a".to_string(), "b".to_string()])
        );
    }
}
