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

- `globset::GlobBuilder` with `literal_separator(true)` always, mapping
  `GlobOptions`: `caseInsensitive` -> `case_insensitive`, `backslashEscape` ->
  `backslash_escape`, `emptyAlternates` -> `empty_alternates`,
  `allowUnclosedClass` (globset ~0.4.15+ `allow_unclosed_class`... verify
  crate API), `explicitDotfiles` -> globset's `require_literal_leading_dot`
  equivalent (verify exact builder method).
- Native returns an opaque matcher handle (napi class or external) exposing
  `isMatch(path: string): boolean`; TS wraps it in a plain closure
  `(relativePath: string) => boolean`.
- Matching itself is pure CPU on small inputs — fine on the calling thread.
- Tests: each option on/off, separator literalness, dotfile semantics,
  invalid patterns throw with useful messages.

### Phase 3 — grepBuffer

- `grep-regex::RegexMatcherBuilder` mapping `RegexOptions` (case_insensitive,
  multi_line, dot_matches_new_line, crlf, unicode) + fixed DFA/regex size
  limits. Multiple patterns: single matcher via alternation? No — semantics
  require per-line match offsets for *each* pattern; use one matcher built
  from the patterns joined as alternation for line selection, then per-line
  `find_iter` to collect all match ranges. (Decide during implementation:
  ripgrep builds one matcher from multiple patterns via alternation —
  mirror that, then find_iter on matched lines gives all ranges.)
- `grep-searcher::SearcherBuilder`: line-oriented, BOM sniffing on, binary
  detection quit(NUL), no mmap; search the JS-supplied Buffer via
  `search_slice` with a sink collecting line text, 1-based line numbers, and
  match byte ranges.
- Convert match byte ranges to UTF-16 code-unit offsets in Rust while the
  line bytes are at hand.
- Tests: single/multi pattern, all RegexOptions, BOMs (UTF-16 LE/BE, UTF-8),
  binary buffers yield no results, multiline mode, CRLF handling, offsets
  correctness on non-ASCII lines (astral plane chars).

### Phase 4 — walkTree

- `ignore::WalkBuilder` with `threads` (default 4), `follow_links`,
  `max_depth` (Infinity -> None; 0 = only the root), custom `add_ignore`
  files (precedence: earlier files lower), `ignoreStyle` mapping:
  - 'all': gitignore(true) + git_global(true) + git_exclude(true) +
    ignore(true) + `.rgignore` via add_custom_ignore_filename, require_git(true)
  - 'no-git': only ignore(true) + `.rgignore` custom filename
  - 'none': all standard filters off
  - hidden(false) always (never filter dotfiles); parents(true) so parent
    ignore files apply (off for 'none').
- include/exclude globs: build `overrides`-style matchers with the user's
  `globOptions` (reuse phase 2 compilation), applied during traversal so
  excluded directories aren't descended into.
- Parallel walker runs on Rust threads; entries stream to JS in batches via
  ThreadsafeFunction; JS async generator yields `TreeEntry` objects that
  satisfy `fs.Dirent` (name, parentPath, isFile()/isDirectory()/
  isSymbolicLink() etc. from the walker's file type). Root symlink always
  followed; cycle detection on when `symlinks: true` (ignore crate does this).
- Backpressure: bounded channel / pause flag so a slow consumer doesn't
  buffer the whole tree in memory.
- Tests: fixture trees with .gitignore/.ignore/.rgignore (inside and outside
  a real .git repo), ignoreFiles precedence, maxDepth 0/1/n, symlink follow +
  cycle safety, include/exclude globs pruning directories, dotfiles included
  by default, threads option smoke test, cancellation (generator.return()
  stops the walk).

### Phase 5 — grepTree

- Same traversal as phase 4, but worker threads also open + search each
  candidate file (skip files > maxFileSize, default 16 MiB) using the
  phase 3 searcher configuration; results stream back as
  `{ entry, matches }` per file with >= 1 match.
- All reads off the main thread. Benchmark (per CLAUDE.md) whether regex
  scanning belongs on the walker threads or the main thread — expectation:
  scanning on walker threads wins; record the numbers in this file.
- Tests: end-to-end fixtures (ignores + globs + size cap + binary skip +
  BOM files), streaming order-independence, cancellation, error paths
  (unreadable files are skipped like ripgrep does, surfaced how ripgrep
  surfaces them — decide and document).

### Phase 6 — Prebuilds & packaging

- CI (GitHub Actions) building linux-x64, linux-arm64, darwin-x64,
  darwin-arm64 `.node` binaries; publish flow bundling them into the npm
  package (`files` + `prebuilds/`).
- Verify the platform-specific entry points' require graphs stay fully
  static (lint or test that asserts no dynamic require in those files).

### Phase 7 — Benchmarks, docs, polish

- Benchmark vs ripgrep CLI and vs naive fs.readdir+regex for sanity.
- README with API docs and examples; document divergences (if any).
- Final prettier + full test pass.
