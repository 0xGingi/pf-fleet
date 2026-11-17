//! Self-update: the dashboard sends `update {version, sha256, size}` and then the binary.
//! We verify it, prove it runs, and swap it over our own executable. main.rs re-execs
//! once every lane has finished its job.

use crate::protocol::Update;
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Checks `bytes` against `meta`, then atomically replaces `exe` with it.
pub fn install(exe: &Path, meta: &Update, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != meta.size {
        bail!("expected {} bytes, got {}", meta.size, bytes.len());
    }
    let got = sha256_hex(bytes);
    if got != meta.sha256 {
        bail!("checksum mismatch (expected {}, got {got})", meta.sha256);
    }
    let dir = exe
        .parent()
        .context("agent executable has no parent directory")?;
    let tmp: PathBuf = dir.join(".pf-fleet-agent.new");
    write_executable(&tmp, bytes)
        .with_context(|| format!("writing {} (is the directory writable?)", tmp.display()))?;

    // never swap in something that cannot start on this machine
    let out = std::process::Command::new(&tmp).arg("version").output();
    let expected = format!("pf-fleet-agent {}", meta.version);
    match out {
        Ok(o) if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == expected => {}
        Ok(o) => {
            let _ = std::fs::remove_file(&tmp);
            bail!(
                "new agent reported {:?}, expected {expected:?}",
                String::from_utf8_lossy(&o.stdout).trim()
            );
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            bail!("new agent does not run here: {e}");
        }
    }
    std::fs::rename(&tmp, exe).with_context(|| format!("replacing {}", exe.display()))?;
    Ok(())
}

fn write_executable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o755)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(bytes: &[u8], version: &str) -> Update {
        Update {
            version: version.into(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            graceful: true,
        }
    }

    #[test]
    fn digest() {
        assert_eq!(
            sha256_hex(b"test"),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pf-fleet-update-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("pf-fleet-agent");
        std::fs::write(&exe, b"old").unwrap();
        exe
    }

    #[test]
    fn installs_a_binary_that_reports_the_right_version() {
        let exe = scratch("ok");
        let script = b"#!/bin/sh\necho 'pf-fleet-agent 9.9.9'\n";
        install(&exe, &meta(script, "9.9.9"), script).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), script);
    }

    #[test]
    fn rejects_bad_checksum_size_or_version() {
        let exe = scratch("bad");
        let script = b"#!/bin/sh\necho 'pf-fleet-agent 1.0.0'\n";
        let mut m = meta(script, "1.0.0");
        m.sha256 = "0".repeat(64);
        assert!(install(&exe, &m, script)
            .unwrap_err()
            .to_string()
            .contains("checksum"));
        let mut m = meta(script, "1.0.0");
        m.size += 1;
        assert!(install(&exe, &m, script).is_err());
        assert!(install(&exe, &meta(script, "2.0.0"), script)
            .unwrap_err()
            .to_string()
            .contains("reported"));
        assert_eq!(
            std::fs::read(&exe).unwrap(),
            b"old",
            "a failed update must leave the old agent in place"
        );
    }
}
