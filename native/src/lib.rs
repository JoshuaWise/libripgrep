mod glob;
mod search;

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};
use napi_derive::napi;

// Fully-resolved options for compileGlob; mirrors ResolvedGlobOptions in
// src/binding.ts. Defaults are applied by the TypeScript API layer.
#[napi(object)]
pub struct GlobOptions {
    pub case_insensitive: bool,
    pub backslash_escape: bool,
    pub empty_alternates: bool,
    pub allow_unclosed_class: bool,
    pub explicit_dotfiles: bool,
}

// A compiled glob pattern that can be matched against relative paths.
#[napi]
pub struct GlobMatcher {
    re: regex_automata::meta::Regex,
}

#[napi]
impl GlobMatcher {
    #[napi]
    pub fn is_match(&self, relative_path: String) -> bool {
        self.re.is_match(relative_path.as_bytes())
    }
}

// Compiles a glob pattern, throwing on invalid patterns.
#[napi]
pub fn compile_glob(glob_pattern: String, options: GlobOptions) -> Result<GlobMatcher> {
    let opts = glob::CompileOptions {
        case_insensitive: options.case_insensitive,
        backslash_escape: options.backslash_escape,
        empty_alternates: options.empty_alternates,
        allow_unclosed_class: options.allow_unclosed_class,
        explicit_dotfiles: options.explicit_dotfiles,
    };
    let re =
        glob::compile(&glob_pattern, &opts).map_err(|err| Error::from_reason(err.to_string()))?;
    Ok(GlobMatcher { re })
}

// Fully-resolved options for grepBuffer/grepTree regexes; mirrors
// ResolvedRegexOptions in src/binding.ts.
#[napi(object)]
pub struct RegexOptions {
    pub case_insensitive: bool,
    pub multiline: bool,
    pub multiline_dotall: bool,
    pub crlf: bool,
    pub unicode: bool,
}

impl RegexOptions {
    fn to_config(&self) -> search::RegexConfig {
        search::RegexConfig {
            case_insensitive: self.case_insensitive,
            multiline: self.multiline,
            multiline_dotall: self.multiline_dotall,
            crlf: self.crlf,
            unicode: self.unicode,
        }
    }
}

// A matching line; mirrors the public MatchedLine interface in src/types.ts.
#[napi(object)]
pub struct MatchedLine {
    pub line: String,
    pub line_number: u32,
    pub matches: Vec<Vec<u32>>,
}

// Scans the given buffer for all lines matching any of the given regexes,
// throwing on invalid patterns.
#[napi]
pub fn grep_buffer(
    data: Buffer,
    patterns: Vec<String>,
    options: RegexOptions,
) -> Result<Vec<MatchedLine>> {
    let config = options.to_config();
    let matcher = search::build_matcher(&patterns, &config).map_err(Error::from_reason)?;
    let decoded = search::decode_bom(data.as_ref());
    if search::is_binary(&decoded) {
        return Ok(vec![]);
    }
    let lines = search::search_lines(&matcher, config.crlf, &decoded);
    Ok(lines
        .into_iter()
        .map(|m| MatchedLine {
            line: m.line,
            line_number: m.line_number,
            matches: m.matches.into_iter().map(|(s, e)| vec![s, e]).collect(),
        })
        .collect())
}

// Stub for phase 4: will run the parallel directory walker.
#[napi]
pub fn walk_tree() -> Result<()> {
    Err(Error::from_reason("walkTree is not implemented yet"))
}

// Stub for phase 5: will walk and search file contents.
#[napi]
pub fn grep_tree() -> Result<()> {
    Err(Error::from_reason("grepTree is not implemented yet"))
}
