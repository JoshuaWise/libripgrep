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

// Fully-resolved options for compileGrep/grepTree regexes; mirrors
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

impl From<search::LineMatch> for MatchedLine {
    fn from(m: search::LineMatch) -> MatchedLine {
        MatchedLine {
            line: m.line,
            line_number: m.line_number,
            matches: m.matches.into_iter().map(|(s, e)| vec![s, e]).collect(),
        }
    }
}

// A compiled set of grep patterns that can scan any number of buffers.
#[napi]
pub struct GrepMatcher {
    matcher: grep_regex::RegexMatcher,
    crlf: bool,
}

#[napi]
impl GrepMatcher {
    // Scans the given buffer for all lines matching any of the patterns.
    #[napi]
    pub fn scan(&self, data: Buffer) -> Vec<MatchedLine> {
        let decoded = search::decode_bom(data.as_ref());
        if search::is_binary(&decoded) {
            return vec![];
        }
        search::search_lines(&self.matcher, self.crlf, &decoded)
            .into_iter()
            .map(MatchedLine::from)
            .collect()
    }
}

// Compiles the given regexes into a reusable matcher, throwing on invalid
// patterns.
#[napi]
pub fn compile_grep(patterns: Vec<String>, options: RegexOptions) -> Result<GrepMatcher> {
    let config = options.to_config();
    let matcher = search::build_matcher(&patterns, &config).map_err(Error::from_reason)?;
    Ok(GrepMatcher {
        matcher,
        crlf: config.crlf,
    })
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
            max_filesize: None,
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
    stream: Arc<walk::WalkStream<walk::EntryData>>,
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
    stream: Arc<walk::WalkStream<walk::EntryData>>,
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
    let stream = walk::start_walk(root_path, options.to_config()?, |entry| {
        Some(walk::entry_data(entry))
    })
    .map_err(Error::from_reason)?;
    Ok(Walk {
        stream: Arc::new(stream),
    })
}

// Fully-resolved options for grepTree; mirrors ResolvedGrepTreeOptions in
// src/binding.ts. `max_file_size` is None for unlimited.
#[napi(object)]
pub struct GrepTreeOptions {
    pub patterns: Vec<String>,
    pub regex_options: RegexOptions,
    pub max_file_size: Option<i64>,
    pub walk_options: WalkOptions,
}

// One matched file produced by the grepTree walker threads.
pub struct GrepItem {
    entry: walk::EntryData,
    matches: Vec<search::LineMatch>,
}

// A matched file in wire format; JS wraps it into a GrepTreeResult.
#[napi(object)]
pub struct GrepTreeEntry {
    pub path: String,
    pub file_type: u32,
    pub matches: Vec<MatchedLine>,
}

// Resolves batches of matched files off the main thread, like NextBatchTask.
pub struct NextGrepBatchTask {
    stream: Arc<walk::WalkStream<GrepItem>>,
}

impl Task for NextGrepBatchTask {
    type Output = Option<Vec<GrepItem>>;
    type JsValue = Option<Vec<GrepTreeEntry>>;

    fn compute(&mut self) -> Result<Self::Output> {
        self.stream
            .next_batch(WALK_BATCH_SIZE)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(|batch| {
            batch
                .into_iter()
                .map(|item| GrepTreeEntry {
                    path: item.entry.path,
                    file_type: item.entry.file_type,
                    matches: item.matches.into_iter().map(MatchedLine::from).collect(),
                })
                .collect()
        }))
    }
}

// A running grep walk, consumed by the grepTree async generator.
#[napi]
pub struct GrepWalk {
    stream: Arc<walk::WalkStream<GrepItem>>,
}

#[napi]
impl GrepWalk {
    // Resolves the next batch of matched files, or null when done.
    #[napi]
    pub fn next(&self) -> AsyncTask<NextGrepBatchTask> {
        AsyncTask::new(NextGrepBatchTask {
            stream: Arc::clone(&self.stream),
        })
    }

    // Stops the walk promptly; safe to call at any time.
    #[napi]
    pub fn cancel(&self) {
        self.stream.cancel();
    }
}

// Starts a recursive content search on background threads. The walker
// threads read and search candidate files; only files with at least one
// matching line are streamed back.
#[napi]
pub fn grep_tree(root_path: String, options: GrepTreeOptions) -> Result<GrepWalk> {
    let mut config = options.walk_options.to_config()?;
    let max_filesize = options.max_file_size.map(|size| size as u64);
    config.max_filesize = max_filesize;
    let regex_config = options.regex_options.to_config();
    let matcher =
        search::build_matcher(&options.patterns, &regex_config).map_err(Error::from_reason)?;
    let crlf = regex_config.crlf;
    let stream = walk::start_walk(root_path, config, move |entry| {
        let file_type = entry.file_type()?;
        if !file_type.is_file() {
            return None;
        }
        // The parallel walker doesn't apply max_filesize to a root file, so
        // enforce it here.
        if entry.depth() == 0 {
            if let Some(max) = max_filesize {
                if entry.metadata().ok()?.len() > max {
                    return None;
                }
            }
        }
        let matches = search::search_file(&matcher, crlf, entry.path())?;
        Some(GrepItem {
            entry: walk::entry_data(entry),
            matches,
        })
    })
    .map_err(Error::from_reason)?;
    Ok(GrepWalk {
        stream: Arc::new(stream),
    })
}
