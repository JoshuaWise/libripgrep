# libripgrep Implementation Plan

Native Node.js bindings for ripgrep's core crates (`globset`, `ignore`,
`grep-matcher`, `grep-regex`, `grep-searcher`) via napi-rs. See CLAUDE.md for
the full public API contract; this file plans how we get there.

## Architecture

### Repository layout

```
native/            Rust crate (cdylib) using napi-rs
  Cargo.toml
  build.rs         napi_build::setup()
  src/lib.rs       #[napi] exports (split into modules as phases land)
scripts/
  build-native.sh  cargo build --release + copy cdylib into prebuilds/
prebuilds/
  <platform>-<arch>/libripgrep.node   build artifacts (gitignored)
src/               TypeScript
  types.ts         public option/result interfaces
  binding.ts       NativeBinding interface (internal shape of the addon)
  api.ts           makeApi(native) -> the four public functions
  index.ts         auto-detects platform-arch, dynamic require of prebuild
  linux-x64.ts     static require('../prebuilds/linux-x64/libripgrep.node')
  linux-arm64.ts   (same, per platform-arch)
  darwin-x64.ts
  darwin-arm64.ts
dist/              tsc output (gitignored)
test/              jest tests (ts-jest)
```

### Entry points

- `libripgrep` (main): `dist/index.js` computes
  `${process.platform}-${process.arch}`, validates it against the supported
  set, and does one dynamic `require()` of the matching prebuild.
- `libripgrep/<platform-arch>`: `dist/<platform-arch>.js` does a static,
  literal `require()` of its prebuild. These files import only `types.ts`,
  `binding.ts`, and `api.ts` — never `index.ts` — so no auto-detection or
  dynamic require exists anywhere in their require graph.
- All entry points share `api.ts`'s `makeApi(native: NativeBinding)` factory,
  so the JS-side logic is written once.
- `package.json` gets an `"exports"` map for `"."` and the four
  platform-arch subpaths (plus `"types"` per subpath from tsc declarations).

### Native <-> JS split

- **Rust owns:** glob compilation/matching, directory walking (via `ignore`'s
  parallel walker on its own threads), file reading, BOM sniffing +
  transcoding, binary (NUL) detection, regex compilation and line searching,
  byte-offset -> UTF-16 code-unit offset conversion for `MatchedLine.matches`.
- **JS owns:** argument validation/defaulting ergonomics, async-generator
  surfaces, converting native walk results into `fs.Dirent`-compatible
  `TreeEntry` objects.
- Streaming (`walkTree`, `grepTree`): Rust worker threads push batches of
  results to JS via a ThreadsafeFunction; the JS side buffers them in a queue
  drained by the async generator, with a pause/resume watermark for
  backpressure. No filesystem I/O ever happens on the main thread.
- `grepBuffer` is synchronous by contract (returns `MatchedLine[]`) and
  operates on a caller-supplied buffer, so it runs on the calling thread.

### Fixed policies (from CLAUDE.md)

- Globs always compiled with `literal_separator: true`.
- Only the `grep-regex` engine; no PCRE2.
- Never mmap (`MmapChoice::never()`).
- Binary detection: `BinaryDetection::quit(b'\x00')` equivalent (skip files
  with NUL bytes), like ripgrep's default.
- Encoding: BOM sniffing only (UTF-8 / UTF-16 LE / UTF-16 BE); UTF-8 assumed
  otherwise. grep-searcher's default BOM sniffing does exactly this.
- DFA size limit and regex size limit: hardcode ripgrep's defaults (verify
  exact values in /home/agent/workspace/ripgrep when implementing; both are
  10 MB per `--dfa-size-limit` / `--regex-size-limit` docs).
- Always traverse hidden files (never call the walker's hidden filtering);
  `.gitignore` respected only inside real git repos (`require_git(true)`).

## Phases

Each phase lands as a small reviewable chunk: Rust + TS + tests, with a
status blockquote added here when it lands.

### Phase 1 — Toolchain, addon boilerplate, exported stubs

- Install Rust (rustup) and persist it via CLAUDE_ENV_FILE.
- `native/` crate: napi 2.x + napi-derive + napi-build, cdylib, with one
  `#[napi]` stub per planned native entry point, each throwing
  "not implemented".
- `scripts/build-native.sh` + npm script `build:native`: cargo build
  --release, copy the cdylib to `prebuilds/<platform>-<arch>/libripgrep.node`.
- TS skeleton per the layout above: all public types from CLAUDE.md, the
  `NativeBinding` interface, `makeApi()` with the four functions delegating
  to the native stubs, the five entry points, package.json `exports` map.
- Smoke tests: addon loads through both the auto-detected and the explicit
  platform-arch entry; each public function throws "not implemented".

> **Status: implemented (awaiting review).** Rust 1.97.1 installed via rustup
> (persisted through CLAUDE_ENV_FILE, along with CARGO_TARGET_DIR pointed off
> the virtiofs mount — rustc SIGBUSes when its target dir is on virtiofs).
> `npm run build:native` builds the napi 2.x crate and copies the cdylib to
> `prebuilds/linux-arm64/libripgrep.node`. TS skeleton (types/binding/api +
> the 5 entry points) compiles; package.json has the `exports` map and
> `prebuilds/**` in `files`. 6 smoke tests pass via `jest --runInBand`, and
> the compiled `dist/` entry points were verified to load the addon directly
> under node. Deferred: all real implementations (phases 2-5), prebuilds for
> the other three platform-archs and CI (phase 6).

### Phase 2 — compileGlob

- globset has no `explicitDotfiles` equivalent (and its token stream is
  private), so `native/src/glob.rs` vendors globset 0.4.19's single-glob
  parser verbatim and reimplements the token->regex translation with a
  three-mode emission (Normal/Soft/Hard) that keeps wildcards and negated
  classes from matching segment-leading dots. With `explicitDotfiles` off,
  the translation is byte-identical to globset's (enforced by a Rust
  differential test against globset as a dev-dependency, across a 45-pattern
  corpus x all option combinations, including error parity).
- Option mapping: `literal_separator(true)` always; `caseInsensitive`,
  `backslashEscape` (default true), `emptyAlternates` (default true),
  `allowUnclosedClass` map straight onto the vendored parser options. Regex
  compilation uses globset's exact config (byte-oriented, 10 MB NFA size
  limit).
- The spec's option defaults are applied in the public TypeScript API layer
  (`resolveGlobOptions()` in src/api.ts) — the single source of truth for
  defaults. The native addon only ever receives fully-resolved options
  (`ResolvedGlobOptions` in src/binding.ts; plain bools on the Rust side).
- Native returns a `GlobMatcher` napi class exposing `isMatch()`; TS wraps it
  in a plain closure. Matching runs on the calling thread (pure CPU).
- Tests: 35 jest tests covering every option on/off, separator literalness,
  all explicitDotfiles semantics (per-segment rule, `*` zero-char exclusion,
  `**` variants, positive-vs-negated classes, alternates), and invalid
  pattern errors; plus the 2 Rust differential tests (`cargo test
--manifest-path native/Cargo.toml`).

> **Status: implemented (awaiting review).** All of the above landed.
> `compileGlob` is fully functional; 41 jest tests and 2 Rust tests pass,
> prettier/cargo fmt clean. Deferred: reusing the compiled matchers for
> walkTree include/exclude globs (phase 4 will call into the same
> `glob::compile`).

### Phase 3 — compileGrep (formerly grepBuffer)

- Requirement change (post phase 7): `regexOptions.crlf` now defaults to
  TRUE (spec comment updated in CLAUDE.md/types.ts/README; tests cover both
  the default and the explicit `crlf: false` behavior).
- Redesigned after phase 5 (spec change in CLAUDE.md): instead of
  `grepBuffer(data, options)` compiling the matcher on every call, the API
  is `compileGrep(options)` returning a reusable
  `(data: Readonly<Buffer>) => MatchedLine[]` closure, mirroring
  compileGlob. Compilation cost (~1 ms for two patterns) is paid once;
  validation errors (bad regex, empty patterns) throw at compile time. The
  native side is a `GrepMatcher` napi class with a `scan(Buffer)` method.
- Matcher: `grep-regex::RegexMatcherBuilder::build_many()` (one alternation
  matcher over all patterns), configured exactly like ripgrep's
  `matcher_rust()` (crates/core/flags/hiargs.rs): `multi_line(true)` always
  (so ^/$ anchor at line boundaries), `unicode`, `case_insensitive`,
  `ban_byte(NUL)`; multiline mode sets `dot_matches_new_line(multilineDotall)`
  (and `crlf(true).line_terminator(None)` when crlf); non-multiline sets
  `line_terminator(Some(\n))` so matches can never span lines. Size limits
  are grep-regex's defaults, which ARE ripgrep's defaults (100 MiB regex,
  1000 MiB DFA) — ripgrep only overrides them when flags are passed.
- Search core (`native/src/search.rs`), shared with phase 5: grep-searcher
  is NOT used — its sink API doesn't expose per-match spans (ripgrep's own
  printer re-runs the matcher to find them), and we need exact per-line,
  per-match UTF-16 offsets. Instead: BOM sniff/transcode (UTF-16 LE/BE via
  `char::decode_utf16` lossy, UTF-8 BOM stripped, else assume UTF-8), NUL
  scan on the decoded bytes for binary detection (so UTF-16 U+0000 counts),
  one `find_iter` pass over the whole buffer, then a merge-walk assigning
  (possibly multiline) matches to \n-split lines with per-line clipping.
  Defined edge semantics: empty buffer has no lines; an empty match past a
  final \n is dropped; a match portion inside a line terminator clamps to an
  empty span at end-of-content; crlf strips trailing \r from line content.
- Byte offsets convert to UTF-16 code-unit offsets during line decoding
  (lossy, exactly like String::from_utf8_lossy; mid-character boundaries
  resolve to the next character).
- Tests: single/multi pattern, every RegexOption (incl. multilineDotall
  no-op without multiline), \n-in-pattern rejection, BOMs (UTF-16 LE/BE,
  UTF-8), binary buffers, multiline clipping across 2 and 3 lines, CRLF,
  empty matches (^, $ at EOF), astral-plane and BMP UTF-16 offsets, invalid
  UTF-8 replacement, argument validation.

> **Status: implemented (awaiting review).** Landed as grepBuffer, then
> redesigned to compileGrep after phase 5 per the CLAUDE.md spec change.
> Tests updated (one-shot helper + matcher-reuse and compile-time
> validation tests). `search.rs` is shared with grepTree.

### Phase 4 — walkTree

- `ignore::WalkBuilder` configured like ripgrep's walk_builder(): `threads`
  (default 4), `follow_links`, `max_depth` (Infinity -> None; 0 = only the
  root), `hidden(false)` always, custom `add_ignore` files (earlier files
  lower precedence — the crate's native behavior), `ignoreStyle` mapping:
    - 'all': parents + ignore + git_global + git_ignore + git_exclude +
      require_git(true) + `.rgignore` via add_custom_ignore_filename
    - 'no-git': parents + ignore + `.rgignore`, all git sources off
    - 'none': everything off (including parents)
- include/exclude globs compile through the phase-2 vendored glob module
  (same GlobOptions semantics incl. explicitDotfiles) and match against
  root-relative paths (raw bytes, no lossy conversion). Requirement change
  (post phase 7, adopting ripgrep's semantics): excludeGlobs prune traversal
  via `filter_entry` (an excluded directory is never descended into), while
  includeGlobs only gate what is YIELDED — a non-matching directory is still
  traversed so `['**/*.txt']` finds nested files, and the include check runs
  in the visitor before `map` so grepTree still skips reading non-included
  files. `['**']` + explicitDotfiles remains the dotfile-exclusion recipe
  (identical output; dot directories are now traversed but not yielded).
  The root (depth 0) is always yielded and never filtered. A possible future
  optimization is prefix-aware include pruning (skip directories no
  extension of which could match any include glob).
- Streaming is pull-based rather than ThreadsafeFunction-push: the walker
  runs on its own std threads feeding a bounded crossbeam channel (cap 1024
  — backpressure blocks walker threads when JS is slow); `Walk.next()` is a
  napi AsyncTask that blocks on the channel from the libuv pool and drains
  up to 256 entries per batch. Channel disconnect signals completion.
  `cancel()` (called from the generator's `finally`) sets a flag and drains
  so blocked walker threads unwind promptly.
- Walk errors: an error before any entry (e.g. nonexistent root) is fatal
  and rejects; later errors (unreadable subdirs, symlink loops) are skipped
  like ripgrep. The wire format is `{path, fileType}`; JS derives
  name/parentPath via node:path and wraps them in a Dirent-compatible
  TreeEntryImpl class (@types/node v25 Dirent has no deprecated `path`
  member, so neither do we).
- Tests (29): fixture trees with .gitignore/.ignore/.rgignore (inside and
  outside a real .git repo), .rgignore > .ignore precedence, parent
  ascension, ignoreFiles precedence order + missing-file rejection, maxDepth
  0/1, symlink follow/no-follow/cycles/root-always-followed, include/exclude
  pruning + root-relative matching, `['**']`+explicitDotfiles, early-exit
  cancellation, threads:1, TypeError validation.

> **Status: implemented (awaiting review).** All of the above landed;
> `walkTree` is fully functional. 97 jest tests + 2 cargo tests pass;
> prettier/cargo fmt clean. Deferred: reusing the walk/search plumbing for
> grepTree (phase 5), where the same pull-based streaming pattern applies.

### Phase 5 — grepTree

- The phase-4 walker generalized to `WalkStream<T>` with a per-entry `map`
  closure that runs on the walker threads. walkTree maps every entry to its
  wire format; grepTree maps regular files (only) to read (std::fs::read, no
  mmap) -> BOM decode -> NUL binary check -> phase-3 `search_lines`, so only
  files with >= 1 matching line ever cross the channel/FFI. Same pull-based
  batching, backpressure, fatal-root-error, and cancellation semantics.
- maxFileSize (default 16 MiB; Infinity = unlimited) uses the walker's
  native `max_filesize` filter, plus an explicit depth-0 check because the
  parallel walker doesn't apply the filter to a root file. The limit is
  strictly "larger than" (equal-size files are searched), matching the
  crate. Unreadable files are skipped silently (consistent with phase 4's
  non-fatal error policy).
- Benchmark (scanning location, per CLAUDE.md): ripgrep repo checkout
  (324 entries / 249 files), patterns ['fn\s+\w+', 'Result<'], warm cache,
  median of 5, identical results both ways (84 files, 3060 matched lines):
    - grepTree (scan on walker threads): 5.9 ms
    - walkTree + readFile + one pre-compiled compileGrep matcher on the main
      thread (16-way read concurrency): 15.5 ms (~2.6x slower), and it
      occupies the main thread for the duration while grepTree leaves it
      essentially idle. (Pre-redesign datapoint: with grepBuffer recompiling
      the matcher per file at ~1 ms/call, this variant measured 271 ms —
      that compilation overhead motivated the compileGrep redesign.)
    - Decision: scan on walker threads.
- Tests (18): match details/offsets per file, dirs never yielded, root
  file, nonexistent root, regexOptions plumbing (multiline, crlf+ci,
  invalid regex, empty patterns), binary skip, UTF-16 BOM files,
  maxFileSize (boundary, root file, Infinity, validation), walkOptions
  plumbing (gitignore, globs, maxDepth, symlinks), unreadable-file skip
  (non-root only), early-exit cancellation.

> **Status: implemented (awaiting review).** All of the above landed;
> `grepTree` is fully functional. 117 jest tests + 2 cargo tests pass;
> prettier/cargo fmt clean. Deferred: nothing within this phase.

### Phase 6 — Prebuilds & packaging

- `.github/workflows/ci.yml`: a four-leg matrix on native runners (no
  cross-compilation): ubuntu-latest/linux-x64, ubuntu-24.04-arm/linux-arm64,
  macos-13/darwin-x64, macos-latest/darwin-arm64. Each leg asserts the
  runner actually matches its target, builds the addon, runs
  tsc/prettier-check/cargo fmt-check/cargo test/jest, and uploads
  `prebuilds/<target>/libripgrep.node` as an artifact (rust-cache for cargo
  caching).
- Publish job (release-published event, needs all build legs): downloads
  the four artifacts, rearranges them into `prebuilds/<target>/`, verifies
  all four exist, and `npm publish` (the `prepare` script compiles dist;
  `files` already ships src/dist/prebuilds). Requires an `NPM_TOKEN` secret.
- `test/entry-points.test.ts` (8 tests): walks the compiled require graph
  of each dist/<platform-arch>.js — asserts zero dynamic requires, no path
  to dist/index.js, and exactly its own prebuild `.node` literal; asserts
  dist/index.js has exactly one dynamic require (the auto-detection);
  asserts package.json `exports` covers the root + all four subpaths, every
  export target exists after compilation, and `files` includes prebuilds.

> **Status: implemented (awaiting review).** All of the above landed. 127
> jest tests pass; YAML syntax validated locally (workflow execution itself
> is unverifiable until pushed to GitHub). Deferred: nothing within this
> phase; npm provenance/engines metadata left out until real usage demands
> them.

### Phase 7 — Benchmarks, docs, polish

- `bench/grep-tree.js` (committed, takes corpus + patterns as argv):
  grepTree vs the ripgrep CLI (`--no-config --hidden -j4 -c`, matching our
  defaults) vs naive sequential Node (recursive readdir + readFile + JS
  RegExp per line, .git and NUL-files skipped for count parity). On the
  ripgrep repo checkout, warm cache, median of 5, all three variants
  agreeing exactly on 84 files / 3060 matched lines:
    - grepTree (native threads): 6.1 ms
    - ripgrep CLI: 6.2 ms (includes process spawn)
    - naive Node (sequential, main thread): 43.8 ms (~7x slower)
- README: install + platform-entry docs, usage examples for all four
  functions, full API reference tables, and a "Behavior notes" section
  documenting the defined edge semantics (error policy, unreadable root,
  binary/BOM rules, NUL-pattern ban, alternation match semantics,
  includeGlobs-applies-to-directories, empty-file lines).
- package.json prettier script now covers bench/ too.

> **Status: implemented (awaiting review).** All of the above landed. Final
> pass: 127 jest tests + 2 cargo tests green, prettier and cargo fmt clean.
> The plan is fully implemented; remaining known-unverifiable item is the
> GitHub Actions workflow execution (needs a push to GitHub to observe).
