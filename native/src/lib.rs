use napi::{Error, Result};
use napi_derive::napi;

// Stub for phase 2: will compile a globset matcher and return a handle.
#[napi]
pub fn compile_glob() -> Result<()> {
    Err(Error::from_reason("compileGlob is not implemented yet"))
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
