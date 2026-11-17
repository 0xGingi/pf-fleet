//! agent.json (written by install.sh: where the dashboard is and this node's token) and
//! state.json (the last desired config from the dashboard, so lanes keep running offline).

use crate::protocol::Config;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct AgentFile {
    /// Dashboard base URL, e.g. https://fleet.example.com
    pub server: String,
    /// `<nodeId>.<secret>`
    pub token: String,
}

pub fn default_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("/etc"));
    base.join("pf-fleet")
}

pub fn load_agent(path: &Path) -> Result<AgentFile> {
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let f: AgentFile =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
    if !(f.server.starts_with("https://") || f.server.starts_with("http://")) {
        bail!("server must start with https:// or http://");
    }
    if !f.token.contains('.') {
        bail!("token must look like <nodeId>.<secret>; copy the install command from the dashboard again");
    }
    Ok(f)
}

/// The WebSocket URL for a dashboard base URL.
pub fn ws_url(server: &str) -> String {
    let base = server.trim_end_matches('/');
    let base = base
        .strip_prefix("https://")
        .map(|r| format!("wss://{r}"))
        .or_else(|| base.strip_prefix("http://").map(|r| format!("ws://{r}")));
    format!("{}/agent/ws", base.unwrap_or_default())
}

pub fn load_state(path: &Path) -> Option<Config> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Written 0600: it holds the Pirate Face key.
pub fn save_state(path: &Path, cfg: &Config) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(serde_json::to_string_pretty(cfg)?.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Reads and deletes leases.json (lane -> epoch ms until its lease lapses). Missing is fine.
pub fn take_leases(path: &Path) -> std::collections::HashMap<String, u64> {
    let held = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let _ = std::fs::remove_file(path);
    held
}

pub fn save_leases(path: &Path, held: &std::collections::HashMap<&str, u64>) -> Result<()> {
    if held.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    std::fs::write(path, serde_json::to_string(held)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leases_round_trip_and_are_consumed_once() {
        let path =
            std::env::temp_dir().join(format!("pf-fleet-leases-{}.json", std::process::id()));
        save_leases(&path, &[("w1", 42u64)].into_iter().collect()).unwrap();
        assert_eq!(take_leases(&path).get("w1"), Some(&42));
        assert!(take_leases(&path).is_empty());
    }

    #[test]
    fn ws_urls() {
        assert_eq!(
            ws_url("https://fleet.example.com/"),
            "wss://fleet.example.com/agent/ws"
        );
        assert_eq!(
            ws_url("http://10.0.0.2:1337"),
            "ws://10.0.0.2:1337/agent/ws"
        );
    }
}
