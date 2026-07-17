mod glob;

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

// Stub for phase 3: will search a buffer with grep-regex/grep-searcher.
#[napi]
pub fn grep_buffer() -> Result<()> {
    Err(Error::from_reason("grepBuffer is not implemented yet"))
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
