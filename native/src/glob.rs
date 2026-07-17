use std::fmt::Write;

use regex_automata::meta::Regex;

// The parser (Token, Tokens, Parser, GlobError) is vendored from globset
// 0.4.19 (MIT OR Unlicense), trimmed to single-glob compilation. The regex
// translation is rewritten to support `explicit_dotfiles`, which globset
// does not provide.

// An error that occurs when a glob pattern fails to compile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobError {
    glob: String,
    kind: ErrorKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ErrorKind {
    UnclosedClass,
    InvalidRange(char, char),
    UnopenedAlternates,
    UnclosedAlternates,
    DanglingEscape,
    Regex(String),
}

impl std::fmt::Display for GlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "error parsing glob '{}': ", self.glob)?;
        match self.kind {
            ErrorKind::UnclosedClass => {
                write!(f, "unclosed character class; missing ']'")
            }
            ErrorKind::InvalidRange(s, e) => {
                write!(f, "invalid range; '{}' > '{}'", s, e)
            }
            ErrorKind::UnopenedAlternates => {
                write!(
                    f,
                    "unopened alternate group; missing '{{' \
                     (maybe escape '}}' with '[}}]'?)"
                )
            }
            ErrorKind::UnclosedAlternates => {
                write!(
                    f,
                    "unclosed alternate group; missing '}}' \
                     (maybe escape '{{' with '[{{]'?)"
                )
            }
            ErrorKind::DanglingEscape => write!(f, "dangling '\\'"),
            ErrorKind::Regex(ref err) => write!(f, "{}", err),
        }
    }
}

// Options controlling how a glob pattern is compiled. `literal_separator`
// is not offered because this library always compiles globs with it enabled.
// No defaults are defined here; the TypeScript API layer owns them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompileOptions {
    pub case_insensitive: bool,
    pub backslash_escape: bool,
    pub empty_alternates: bool,
    pub allow_unclosed_class: bool,
    pub explicit_dotfiles: bool,
}

// Compiles a glob pattern into a regex that matches relative paths, always
// treating '/' as a literal separator (wildcards never match it).
pub fn compile(pattern: &str, opts: &CompileOptions) -> Result<Regex, GlobError> {
    let re = glob_to_regex(pattern, opts)?;
    new_regex(pattern, &re)
}

// Parses a glob pattern and translates it to a regex pattern string.
fn glob_to_regex(pattern: &str, opts: &CompileOptions) -> Result<String, GlobError> {
    let mut parser = Parser {
        glob: pattern,
        alternates_stack: Vec::new(),
        branches: vec![Tokens::default()],
        chars: pattern.chars().peekable(),
        prev: None,
        cur: None,
        found_unclosed_class: false,
        opts,
    };
    parser.parse()?;
    if parser.branches.len() > 1 {
        return Err(GlobError {
            glob: pattern.to_string(),
            kind: ErrorKind::UnclosedAlternates,
        });
    }
    let tokens = parser.branches.pop().expect("at least one branch");
    Ok(tokens_to_regex_top(opts, &tokens))
}

// Compiles the translated regex the same way globset does (byte-oriented,
// with an NFA size limit to bound memory).
fn new_regex(glob: &str, pat: &str) -> Result<Regex, GlobError> {
    let syntax = regex_automata::util::syntax::Config::new()
        .utf8(false)
        .dot_matches_new_line(true);
    let config = Regex::config()
        .utf8_empty(false)
        .nfa_size_limit(Some(10 * (1 << 20)))
        .hybrid_cache_capacity(10 * (1 << 20));
    Regex::builder()
        .syntax(syntax)
        .configure(config)
        .build(pat)
        .map_err(|err| GlobError {
            glob: glob.to_string(),
            kind: ErrorKind::Regex(err.to_string()),
        })
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct Tokens(Vec<Token>);

impl std::ops::Deref for Tokens {
    type Target = Vec<Token>;
    fn deref(&self) -> &Vec<Token> {
        &self.0
    }
}

impl std::ops::DerefMut for Tokens {
    fn deref_mut(&mut self) -> &mut Vec<Token> {
        &mut self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Token {
    Literal(char),
    Any,
    ZeroOrMore,
    RecursivePrefix,
    RecursiveSuffix,
    RecursiveZeroOrMore,
    Class {
        negated: bool,
        ranges: Vec<(char, char)>,
    },
    Alternates(Vec<Tokens>),
}

/*
The translation to regex differs from globset's in that it must enforce the
`explicit_dotfiles` rule: "**", "*", "?", and negated classes must not match
a dot at the start of a path segment, and a segment-leading "*" must not
match zero characters when that would let a following token supply the dot
(e.g. the ".x" in the pattern "*.x"). Literal dots and positive classes may
still match segment-leading dots.

The rule is enforced with a per-character "mode" (regex_automata has no
lookahead):

- Normal: no constraint.
- Soft: at a segment start; wildcards and negated classes are constrained
  away from '.', but literals and positive classes are not.
- Hard: at a segment start just after a segment-leading wildcard matched
  zero characters; nothing may match '.' here, so branches that would are
  dropped (emission returns None).

A segment-leading "*" emits an alternation of "star consumes the first
character (constrained)" and "star consumes nothing" with the rest of the
tokens folded into both branches, which is what makes Hard mode reachable.
When `explicit_dotfiles` is disabled, everything stays in Normal mode and
the emission matches globset's exactly.
*/

#[derive(Clone, Copy, Eq, PartialEq)]
enum Mode {
    Normal,
    Soft,
    Hard,
}

fn tokens_to_regex_top(opts: &CompileOptions, tokens: &[Token]) -> String {
    let mut re = String::from("(?-u)");
    if opts.case_insensitive {
        re.push_str("(?i)");
    }
    re.push('^');
    // Special case. If the entire glob is just `**`, then it should match
    // everything (subject to the dotfiles rule).
    if tokens.len() == 1 && tokens[0] == Token::RecursivePrefix {
        if opts.explicit_dotfiles {
            re.push_str("(?:[^/.][^/]*(?:/[^/.][^/]*)*)?");
        } else {
            re.push_str(".*");
        }
        re.push('$');
        return re;
    }
    let mode = if opts.explicit_dotfiles {
        Mode::Soft
    } else {
        Mode::Normal
    };
    let body = tokens_to_regex(opts, tokens, mode)
        .expect("only Hard mode emission can fail, and the top level is never Hard");
    re.push_str(&body);
    re.push('$');
    re
}

// Emits the regex for a token sequence whose first character position is
// constrained by `mode`. Returns None if the constraint is unsatisfiable
// (only possible in Hard mode).
fn tokens_to_regex(opts: &CompileOptions, tokens: &[Token], mut mode: Mode) -> Option<String> {
    let mut re = String::new();
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            Token::Literal(c) => {
                if c == '.' && mode == Mode::Hard {
                    return None;
                }
                re.push_str(&char_to_escaped_literal(c));
                mode = if c == '/' && opts.explicit_dotfiles {
                    Mode::Soft
                } else {
                    Mode::Normal
                };
            }
            Token::Any => {
                if mode == Mode::Normal {
                    re.push_str("[^/]");
                } else {
                    re.push_str("[^/.]");
                }
                mode = Mode::Normal;
            }
            Token::ZeroOrMore => {
                if mode == Mode::Normal {
                    re.push_str("[^/]*");
                } else {
                    let rest = &tokens[i + 1..];
                    let nonempty = tokens_to_regex(opts, rest, Mode::Normal)?;
                    re.push_str("(?:[^/.][^/]*");
                    re.push_str(&nonempty);
                    if let Some(empty) = tokens_to_regex(opts, rest, Mode::Hard) {
                        re.push('|');
                        re.push_str(&empty);
                    }
                    re.push(')');
                    return Some(re);
                }
            }
            Token::RecursivePrefix => {
                if opts.explicit_dotfiles {
                    re.push_str("/?(?:[^/.][^/]*/)*");
                    mode = Mode::Soft;
                } else {
                    re.push_str("(?:/?|.*/)");
                    mode = Mode::Normal;
                }
            }
            Token::RecursiveSuffix => {
                if opts.explicit_dotfiles {
                    re.push_str("(?:/[^/.][^/]*)+");
                    mode = Mode::Soft;
                } else {
                    re.push_str("/.*");
                    mode = Mode::Normal;
                }
            }
            Token::RecursiveZeroOrMore => {
                if opts.explicit_dotfiles {
                    re.push_str("/(?:[^/.][^/]*/)*");
                    mode = Mode::Soft;
                } else {
                    re.push_str("(?:/|/.*/)");
                    mode = Mode::Normal;
                }
            }
            Token::Class {
                negated,
                ref ranges,
            } => {
                let ranges = if mode == Mode::Normal {
                    ranges.clone()
                } else if negated {
                    // A constrained negated class must also exclude '.'.
                    let mut ranges = ranges.clone();
                    ranges.push(('.', '.'));
                    ranges
                } else if mode == Mode::Hard {
                    // A Hard positive class may not match '.': subtract it.
                    let mut newranges = vec![];
                    for &(lo, hi) in ranges {
                        if lo <= '.' && '.' <= hi {
                            if lo < '.' {
                                newranges.push((lo, '-'));
                            }
                            if '.' < hi {
                                newranges.push(('/', hi));
                            }
                        } else {
                            newranges.push((lo, hi));
                        }
                    }
                    if newranges.is_empty() {
                        return None;
                    }
                    newranges
                } else {
                    // A Soft positive class may match a segment-leading dot.
                    ranges.clone()
                };
                re.push('[');
                if negated {
                    re.push('^');
                }
                for r in ranges {
                    if r.0 == r.1 {
                        re.push_str(&char_to_escaped_literal(r.0));
                    } else {
                        re.push_str(&char_to_escaped_literal(r.0));
                        re.push('-');
                        re.push_str(&char_to_escaped_literal(r.1));
                    }
                }
                re.push(']');
                mode = Mode::Normal;
            }
            Token::Alternates(ref branches) => {
                if mode == Mode::Normal {
                    let mut parts = vec![];
                    for branch in branches {
                        let part = tokens_to_regex(opts, branch, Mode::Normal)
                            .expect("Normal mode emission cannot fail");
                        if !part.is_empty() || opts.empty_alternates {
                            parts.push(part);
                        }
                    }
                    // It is possible to have an empty set in which case the
                    // resulting alternation '()' would be an error.
                    if !parts.is_empty() {
                        re.push_str("(?:");
                        re.push_str(&parts.join("|"));
                        re.push(')');
                    }
                } else {
                    // The constraint applies to each branch's first character,
                    // and (through branches that match zero characters) to
                    // whatever follows, so fold the rest into every branch.
                    let rest = &tokens[i + 1..];
                    let mut candidates = 0;
                    let mut parts = vec![];
                    for branch in branches {
                        if branch.is_empty() && !opts.empty_alternates {
                            continue;
                        }
                        candidates += 1;
                        let mut combined = branch.0.clone();
                        combined.extend_from_slice(rest);
                        if let Some(part) = tokens_to_regex(opts, &combined, mode) {
                            parts.push(part);
                        }
                    }
                    if candidates == 0 {
                        // Every branch was an ignored empty pattern; the
                        // group contributes nothing, so continue with the
                        // same constraint.
                        i += 1;
                        continue;
                    }
                    if parts.is_empty() {
                        return None;
                    }
                    re.push_str("(?:");
                    re.push_str(&parts.join("|"));
                    re.push(')');
                    return Some(re);
                }
            }
        }
        i += 1;
    }
    Some(re)
}

// Convert a Unicode scalar value to an escaped string suitable for use as
// a literal in a non-Unicode regex.
fn char_to_escaped_literal(c: char) -> String {
    let mut buf = [0; 4];
    let bytes = c.encode_utf8(&mut buf).as_bytes();
    let mut s = String::with_capacity(bytes.len());
    for &b in bytes {
        if b <= 0x7F {
            regex_syntax::escape_into(char::from(b).encode_utf8(&mut [0; 4]), &mut s);
        } else {
            write!(&mut s, "\\x{:02x}", b).unwrap();
        }
    }
    s
}

struct Parser<'a> {
    /// The glob to parse.
    glob: &'a str,
    /// Marks the index in `stack` where the alternation started.
    alternates_stack: Vec<usize>,
    /// The set of active alternation branches being parsed.
    /// Tokens are added to the end of the last one.
    branches: Vec<Tokens>,
    /// A character iterator over the glob pattern to parse.
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    /// The previous character seen.
    prev: Option<char>,
    /// The current character.
    cur: Option<char>,
    /// Whether we failed to find a closing `]` for a character
    /// class. This can only be true when `allow_unclosed_class`
    /// is enabled. When enabled, it is impossible to ever parse another
    /// character class with this glob. That's because classes cannot be
    /// nested *and* the only way this happens is when there is never a `]`.
    ///
    /// We track this state so that we don't end up spending quadratic time
    /// trying to parse something like `[[[[[[[[[[[[[[[[[[[[[[[...`.
    found_unclosed_class: bool,
    /// Glob options, which may influence parsing.
    opts: &'a CompileOptions,
}

impl<'a> Parser<'a> {
    fn error(&self, kind: ErrorKind) -> GlobError {
        GlobError {
            glob: self.glob.to_string(),
            kind,
        }
    }

    fn parse(&mut self) -> Result<(), GlobError> {
        while let Some(c) = self.bump() {
            match c {
                '?' => self.push_token(Token::Any)?,
                '*' => self.parse_star()?,
                '[' if !self.found_unclosed_class => self.parse_class()?,
                '{' => self.push_alternate()?,
                '}' => self.pop_alternate()?,
                ',' => self.parse_comma()?,
                '\\' => self.parse_backslash()?,
                c => self.push_token(Token::Literal(c))?,
            }
        }
        Ok(())
    }

    fn push_alternate(&mut self) -> Result<(), GlobError> {
        self.alternates_stack.push(self.branches.len());
        self.branches.push(Tokens::default());
        Ok(())
    }

    fn pop_alternate(&mut self) -> Result<(), GlobError> {
        let Some(start) = self.alternates_stack.pop() else {
            return Err(self.error(ErrorKind::UnopenedAlternates));
        };
        assert!(start <= self.branches.len());
        let alts = Token::Alternates(self.branches.drain(start..).collect());
        self.push_token(alts)?;
        Ok(())
    }

    fn push_token(&mut self, tok: Token) -> Result<(), GlobError> {
        if let Some(ref mut pat) = self.branches.last_mut() {
            return Ok(pat.push(tok));
        }
        Err(self.error(ErrorKind::UnopenedAlternates))
    }

    fn pop_token(&mut self) -> Result<Token, GlobError> {
        if let Some(ref mut pat) = self.branches.last_mut() {
            return Ok(pat.pop().unwrap());
        }
        Err(self.error(ErrorKind::UnopenedAlternates))
    }

    fn have_tokens(&self) -> Result<bool, GlobError> {
        match self.branches.last() {
            None => Err(self.error(ErrorKind::UnopenedAlternates)),
            Some(ref pat) => Ok(!pat.is_empty()),
        }
    }

    fn parse_comma(&mut self) -> Result<(), GlobError> {
        // If we aren't inside a group alternation, then don't
        // treat commas specially. Otherwise, we need to start
        // a new alternate branch.
        if self.alternates_stack.is_empty() {
            self.push_token(Token::Literal(','))
        } else {
            Ok(self.branches.push(Tokens::default()))
        }
    }

    fn parse_backslash(&mut self) -> Result<(), GlobError> {
        if self.opts.backslash_escape {
            match self.bump() {
                None => Err(self.error(ErrorKind::DanglingEscape)),
                Some(c) => self.push_token(Token::Literal(c)),
            }
        } else {
            self.push_token(Token::Literal('\\'))
        }
    }

    fn parse_star(&mut self) -> Result<(), GlobError> {
        let prev = self.prev;
        if self.peek() != Some('*') {
            self.push_token(Token::ZeroOrMore)?;
            return Ok(());
        }
        assert!(self.bump() == Some('*'));
        if !self.have_tokens()? {
            if !self.peek().map_or(true, is_separator) {
                self.push_token(Token::ZeroOrMore)?;
                self.push_token(Token::ZeroOrMore)?;
            } else {
                self.push_token(Token::RecursivePrefix)?;
                assert!(self.bump().map_or(true, is_separator));
            }
            return Ok(());
        }

        if !prev.map(is_separator).unwrap_or(false) {
            if self.branches.len() <= 1 || (prev != Some(',') && prev != Some('{')) {
                self.push_token(Token::ZeroOrMore)?;
                self.push_token(Token::ZeroOrMore)?;
                return Ok(());
            }
        }
        let is_suffix = match self.peek() {
            None => {
                assert!(self.bump().is_none());
                true
            }
            Some(',') | Some('}') if self.branches.len() >= 2 => true,
            Some(c) if is_separator(c) => {
                assert!(self.bump().map(is_separator).unwrap_or(false));
                false
            }
            _ => {
                self.push_token(Token::ZeroOrMore)?;
                self.push_token(Token::ZeroOrMore)?;
                return Ok(());
            }
        };
        match self.pop_token()? {
            Token::RecursivePrefix => {
                self.push_token(Token::RecursivePrefix)?;
            }
            Token::RecursiveSuffix => {
                self.push_token(Token::RecursiveSuffix)?;
            }
            _ => {
                if is_suffix {
                    self.push_token(Token::RecursiveSuffix)?;
                } else {
                    self.push_token(Token::RecursiveZeroOrMore)?;
                }
            }
        }
        Ok(())
    }

    fn parse_class(&mut self) -> Result<(), GlobError> {
        // Save parser state for potential rollback to literal '[' parsing.
        let saved_chars = self.chars.clone();
        let saved_prev = self.prev;
        let saved_cur = self.cur;

        fn add_to_last_range(glob: &str, r: &mut (char, char), add: char) -> Result<(), GlobError> {
            r.1 = add;
            if r.1 < r.0 {
                Err(GlobError {
                    glob: glob.to_string(),
                    kind: ErrorKind::InvalidRange(r.0, r.1),
                })
            } else {
                Ok(())
            }
        }
        let mut ranges = vec![];
        let negated = match self.chars.peek() {
            Some(&'!') | Some(&'^') => {
                let bump = self.bump();
                assert!(bump == Some('!') || bump == Some('^'));
                true
            }
            _ => false,
        };
        let mut first = true;
        let mut in_range = false;
        loop {
            let Some(c) = self.bump() else {
                return if self.opts.allow_unclosed_class {
                    self.chars = saved_chars;
                    self.cur = saved_cur;
                    self.prev = saved_prev;
                    self.found_unclosed_class = true;

                    self.push_token(Token::Literal('['))
                } else {
                    Err(self.error(ErrorKind::UnclosedClass))
                };
            };
            match c {
                ']' => {
                    if first {
                        ranges.push((']', ']'));
                    } else {
                        break;
                    }
                }
                '-' => {
                    if first {
                        ranges.push(('-', '-'));
                    } else if in_range {
                        // invariant: in_range is only set when there is
                        // already at least one character seen.
                        let r = ranges.last_mut().unwrap();
                        add_to_last_range(&self.glob, r, '-')?;
                        in_range = false;
                    } else {
                        assert!(!ranges.is_empty());
                        in_range = true;
                    }
                }
                c => {
                    if in_range {
                        // invariant: in_range is only set when there is
                        // already at least one character seen.
                        add_to_last_range(&self.glob, ranges.last_mut().unwrap(), c)?;
                    } else {
                        ranges.push((c, c));
                    }
                    in_range = false;
                }
            }
            first = false;
        }
        if in_range {
            // Means that the last character in the class was a '-', so add
            // it as a literal.
            ranges.push(('-', '-'));
        }
        self.push_token(Token::Class { negated, ranges })
    }

    fn bump(&mut self) -> Option<char> {
        self.prev = self.cur;
        self.cur = self.chars.next();
        self.cur
    }

    fn peek(&mut self) -> Option<char> {
        self.chars.peek().copied()
    }
}

// Only '/' is a separator; this library only supports Unix-like systems.
fn is_separator(c: char) -> bool {
    c == '/'
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATTERNS: &[&str] = &[
        "",
        "a",
        "abc,def",
        "a/b/c",
        "*",
        "**",
        "*.js",
        "a*",
        "*a",
        "a*b*c",
        "?",
        "a?c",
        "?oo",
        "**/a",
        "a/**",
        "a/**/b",
        "/**",
        "**/",
        "a**",
        "**a",
        "a**b",
        "a/**b",
        "a**/b",
        "[a-z]",
        "[!a-z]",
        "[^a-z]",
        "[]]",
        "[a-]",
        "[-a]",
        "[a-z0-9]x",
        "{a,b}",
        "*.{js,ts}",
        "foo{,.txt}",
        "{a,{b,c}}",
        "{a/b,c}",
        "{**/a,b}",
        "{a/**,b}c",
        "a\\*b",
        "a\\\\b",
        "x{*,?y}z",
        "[z-a]",
        "a}b",
        "{a,b",
        "[abc",
        "abc\\",
    ];

    fn upstream_regex(pattern: &str, opts: &CompileOptions) -> Result<String, ()> {
        globset::GlobBuilder::new(pattern)
            .literal_separator(true)
            .case_insensitive(opts.case_insensitive)
            .backslash_escape(opts.backslash_escape)
            .empty_alternates(opts.empty_alternates)
            .allow_unclosed_class(opts.allow_unclosed_class)
            .build()
            .map(|glob| glob.regex().to_string())
            .map_err(|_| ())
    }

    // Without explicit_dotfiles, the translation must be byte-identical to
    // globset's (and fail on exactly the same patterns), since the parser is
    // vendored from it and the Normal-mode emission replicates it.
    #[test]
    fn matches_globset_translation() {
        for &pattern in PATTERNS {
            for case_insensitive in [false, true] {
                for empty_alternates in [false, true] {
                    for backslash_escape in [false, true] {
                        for allow_unclosed_class in [false, true] {
                            let opts = CompileOptions {
                                case_insensitive,
                                backslash_escape,
                                empty_alternates,
                                allow_unclosed_class,
                                explicit_dotfiles: false,
                            };
                            let ours = glob_to_regex(pattern, &opts).map_err(|_| ());
                            let theirs = upstream_regex(pattern, &opts);
                            assert_eq!(
                                ours, theirs,
                                "pattern {:?} with options {:?}",
                                pattern, opts
                            );
                        }
                    }
                }
            }
        }
    }

    // With explicit_dotfiles, every pattern that parses must still produce a
    // valid regex.
    #[test]
    fn explicit_dotfiles_regexes_compile() {
        for &pattern in PATTERNS {
            let opts = CompileOptions {
                case_insensitive: false,
                backslash_escape: true,
                empty_alternates: true,
                allow_unclosed_class: true,
                explicit_dotfiles: true,
            };
            if let Ok(re) = glob_to_regex(pattern, &opts) {
                new_regex(pattern, &re).unwrap();
            }
        }
    }
}
