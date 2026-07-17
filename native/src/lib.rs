mod glob;
mod search;
mod walk;

use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Task};
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

impl GlobOptions {
    fn to_compile_options(&self) -> glob::CompileOptions {
        glob::CompileOptions {
            case_insensitive: self.case_insensitive,
            backslash_escape: self.backslash_escape,
            empty_alternates: self.empty_alternates,
            allow_unclosed_class: self.allow_unclosed_class,
            explicit_dotfiles: self.explicit_dotfiles,
        }
    }
}

// Compiles a glob pattern, throwing on invalid patterns.
#[napi]
pub fn compile_glob(glob_pattern: String, options: GlobOptions) -> Result<GlobMatcher> {
    let re = glob::compile(&glob_pattern, &options.to_compile_options())
        .map_err(|err| Error::from_reason(err.to_string()))?;
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

// Fully-resolved options for walkTree; mirrors ResolvedWalkOptions in
// src/binding.ts.
#[napi(object)]
pub struct WalkOptions {
    pub threads: u32,
    pub symlinks: bool,
    pub max_depth: Option<u32>,
    pub ignore_files: Vec<String>,
    pub ignore_style: String,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub glob_options: GlobOptions,
}

impl WalkOptions {
    fn to_config(&self) -> Result<walk::WalkConfig> {
        let glob_opts = self.glob_options.to_compile_options();
        let compile_all = |patterns: &[String]| {
            patterns
                .iter()
                .map(|pattern| {
                    glob::compile(pattern, &glob_opts)
                        .map_err(|err| Error::from_reason(err.to_string()))
                })
                .collect::<Result<Vec<_>>>()
        };
        Ok(walk::WalkConfig {
            threads: (self.threads as usize).max(1),
            symlinks: self.symlinks,
            max_depth: self.max_depth.map(|depth| depth as usize),
            ignore_files: self.ignore_files.clone(),
            ignore_style: match self.ignore_style.as_str() {
                "all" => walk::IgnoreStyle::All,
                "no-git" => walk::IgnoreStyle::NoGit,
                "none" => walk::IgnoreStyle::None,
                other => {
                    return Err(Error::from_reason(format!(
                        "invalid ignoreStyle: '{other}'"
                    )))
                }
            },
            include: compile_all(&self.include_globs)?,
            exclude: compile_all(&self.exclude_globs)?,
        })
    }
}

// One walked entry, in wire format; JS derives name/parentPath from `path`.
#[napi(object)]
pub struct WalkEntry {
    pub path: String,
    pub file_type: u32,
}

// How many entries next() returns at most per call.
const WALK_BATCH_SIZE: usize = 256;

// Resolves batches of walked entries off the main thread by blocking on the
// walker's channel from the libuv thread pool.
pub struct NextBatchTask {
    stream: Arc<walk::WalkStream>,
}

impl Task for NextBatchTask {
    type Output = Option<Vec<walk::EntryData>>;
    type JsValue = Option<Vec<WalkEntry>>;

    fn compute(&mut self) -> Result<Self::Output> {
        self.stream
            .next_batch(WALK_BATCH_SIZE)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(|batch| {
            batch
                .into_iter()
                .map(|entry| WalkEntry {
                    path: entry.path,
                    file_type: entry.file_type,
                })
                .collect()
        }))
    }
}

// A running directory walk, consumed by the walkTree async generator.
#[napi]
pub struct Walk {
    stream: Arc<walk::WalkStream>,
}

#[napi]
impl Walk {
    // Resolves the next batch of entries, or null when the walk is done.
    #[napi]
    pub fn next(&self) -> AsyncTask<NextBatchTask> {
        AsyncTask::new(NextBatchTask {
            stream: Arc::clone(&self.stream),
        })
    }

    // Stops the walk promptly; safe to call at any time.
    #[napi]
    pub fn cancel(&self) {
        self.stream.cancel();
    }
}

// Starts a directory walk on background threads, throwing on invalid globs,
// unreadable ignore files, or an invalid ignoreStyle.
#[napi]
pub fn walk_tree(root_path: String, options: WalkOptions) -> Result<Walk> {
    let stream = walk::start_walk(root_path, options.to_config()?).map_err(Error::from_reason)?;
    Ok(Walk {
        stream: Arc::new(stream),
    })
}

// Stub for phase 5: will walk and search file contents.
#[napi]
pub fn grep_tree() -> Result<()> {
    Err(Error::from_reason("grepTree is not implemented yet"))
}
