use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crossbeam_channel::{bounded, Receiver};
use ignore::{WalkBuilder, WalkState};
use regex_automata::meta::Regex;

// Entries buffered between the walker threads and JS. The bound provides
// backpressure: when JS consumes slowly, walker threads block on send.
const CHANNEL_CAPACITY: usize = 1024;

// Which of the automatic ignore sources to respect (see WalkOptions in
// src/types.ts). Explicit ignore files are always respected.
pub enum IgnoreStyle {
    All,
    NoGit,
    None,
}

pub struct WalkConfig {
    pub threads: usize,
    pub symlinks: bool,
    pub max_depth: Option<usize>,
    pub ignore_files: Vec<String>,
    pub ignore_style: IgnoreStyle,
    pub include: Vec<Regex>,
    pub exclude: Vec<Regex>,
}

// One walked entry, in wire format for JS (which derives name/parentPath).
pub struct EntryData {
    pub path: String,
    pub file_type: u32,
}

enum WalkMessage {
    Entry(EntryData),
    // Sent only when the very first result is an error (e.g. the root does
    // not exist); later errors are skipped like ripgrep skips unreadable
    // directories.
    FatalError(String),
}

// A running directory walk. Dropping it disconnects the channel, which
// also unwinds the walker threads; cancel() just does so promptly.
pub struct WalkStream {
    rx: Receiver<WalkMessage>,
    cancelled: Arc<AtomicBool>,
}

// Configures the walker the way ripgrep does (see walk_builder() in
// ripgrep's crates/core/flags/hiargs.rs), spawns it on its own threads, and
// returns the receiving stream. Never treats hidden files specially, and
// only respects .gitignore inside real git repositories (require_git).
pub fn start_walk(root: String, config: WalkConfig) -> Result<WalkStream, String> {
    let mut builder = WalkBuilder::new(&root);
    builder
        .follow_links(config.symlinks)
        .max_depth(config.max_depth)
        .threads(config.threads)
        .hidden(false);
    match config.ignore_style {
        IgnoreStyle::All => {
            builder
                .parents(true)
                .ignore(true)
                .git_global(true)
                .git_ignore(true)
                .git_exclude(true)
                .require_git(true)
                .add_custom_ignore_filename(".rgignore");
        }
        IgnoreStyle::NoGit => {
            builder
                .parents(true)
                .ignore(true)
                .git_global(false)
                .git_ignore(false)
                .git_exclude(false)
                .add_custom_ignore_filename(".rgignore");
        }
        IgnoreStyle::None => {
            builder
                .parents(false)
                .ignore(false)
                .git_global(false)
                .git_ignore(false)
                .git_exclude(false);
        }
    }
    for path in &config.ignore_files {
        if let Some(err) = builder.add_ignore(path) {
            return Err(err.to_string());
        }
    }
    if !config.include.is_empty() || !config.exclude.is_empty() {
        let root_prefix = PathBuf::from(&root);
        let include = config.include;
        let exclude = config.exclude;
        builder.filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let rel = entry
                .path()
                .strip_prefix(&root_prefix)
                .unwrap_or(entry.path());
            let bytes = std::os::unix::ffi::OsStrExt::as_bytes(rel.as_os_str());
            if exclude.iter().any(|re| re.is_match(bytes)) {
                return false;
            }
            include.is_empty() || include.iter().any(|re| re.is_match(bytes))
        });
    }

    let (tx, rx) = bounded::<WalkMessage>(CHANNEL_CAPACITY);
    let cancelled = Arc::new(AtomicBool::new(false));
    let walker = builder.build_parallel();
    let thread_cancelled = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let emitted_any = AtomicBool::new(false);
        walker.run(|| {
            let tx = tx.clone();
            let cancelled = &thread_cancelled;
            let emitted_any = &emitted_any;
            Box::new(move |result| {
                if cancelled.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                match result {
                    Ok(entry) => {
                        emitted_any.store(true, Ordering::Relaxed);
                        let data = EntryData {
                            path: entry.path().to_string_lossy().into_owned(),
                            file_type: file_type_code(&entry),
                        };
                        if tx.send(WalkMessage::Entry(data)).is_err() {
                            return WalkState::Quit;
                        }
                        WalkState::Continue
                    }
                    Err(err) => {
                        if !emitted_any.load(Ordering::Relaxed) {
                            let _ = tx.send(WalkMessage::FatalError(err.to_string()));
                            return WalkState::Quit;
                        }
                        WalkState::Continue
                    }
                }
            })
        });
        // The walker (and every sender clone) is dropped here, which
        // disconnects the channel and signals completion to next_batch().
    });
    Ok(WalkStream { rx, cancelled })
}

impl WalkStream {
    // Blocks until at least one entry is available, then greedily drains up
    // to `max` entries. Returns None when the walk is complete.
    pub fn next_batch(&self, max: usize) -> Result<Option<Vec<EntryData>>, String> {
        let first = match self.rx.recv() {
            Ok(WalkMessage::Entry(entry)) => entry,
            Ok(WalkMessage::FatalError(message)) => return Err(message),
            Err(_) => return Ok(None),
        };
        let mut batch = Vec::with_capacity(max.min(CHANNEL_CAPACITY));
        batch.push(first);
        while batch.len() < max {
            match self.rx.try_recv() {
                Ok(WalkMessage::Entry(entry)) => batch.push(entry),
                Ok(WalkMessage::FatalError(message)) => return Err(message),
                Err(_) => break,
            }
        }
        Ok(Some(batch))
    }

    // Stops the walk: walker threads observe the flag on their next entry,
    // and draining unblocks any thread stuck on a full channel.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        while self.rx.try_recv().is_ok() {}
    }
}

// File type codes shared with the TypeScript side (see TreeEntryImpl in
// src/api.ts). Symlink is checked first: with follow_links, followed
// entries report their target's type instead.
fn file_type_code(entry: &ignore::DirEntry) -> u32 {
    use std::os::unix::fs::FileTypeExt;
    let Some(ft) = entry.file_type() else {
        return 7;
    };
    if ft.is_symlink() {
        2
    } else if ft.is_file() {
        0
    } else if ft.is_dir() {
        1
    } else if ft.is_block_device() {
        3
    } else if ft.is_char_device() {
        4
    } else if ft.is_fifo() {
        5
    } else if ft.is_socket() {
        6
    } else {
        7
    }
}
