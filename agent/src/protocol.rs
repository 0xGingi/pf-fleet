//! Agent ↔ dashboard protocol v1 (docs/protocol.md). Mirrors packages/protocol/src/index.ts;
//! both sides test against protocol/fixtures.

use serde::{Deserialize, Serialize};

// ---------- agent → dashboard ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMsg {
    Hello(Hello),
    Heartbeat(Heartbeat),
    JobStarted(JobStarted),
    JobFinished(JobFinished),
    Log(Log),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub agent_version: String,
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub cpus: u32,
    pub active_jobs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub ts: u64,
    pub system: SystemStats,
    pub uvx: Option<String>,
    pub processed_bytes: u64,
    pub lanes: Vec<LaneStatus>,
    /// a downloaded agent version waiting for the lanes to finish their jobs
    pub update_pending: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub mem_total: u64,
    pub mem_available: u64,
    pub uptime: u64,
    pub net_rx: u64,
    pub net_tx: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneState {
    Stopped,
    Starting,
    Idle,
    Working,
    Backoff,
    Draining,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneStatus {
    pub name: String,
    pub state: LaneState,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub restarts: u32,
    pub last_exit: Option<i32>,
    pub message: Option<String>,
    pub job: Option<ActiveJob>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveJob {
    pub job_id: String,
    pub repo: String,
    pub revision: String,
    pub files: u32,
    pub size_bytes: u64,
    pub done_bytes: u64,
    pub started_at: u64,
    pub rate_bps: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStarted {
    pub lane: String,
    pub job_id: String,
    pub repo: String,
    pub revision: String,
    pub files: u32,
    pub size_bytes: u64,
    pub started_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobResult {
    Listed,
    AlreadyListed,
    Refused,
    Error,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFinished {
    pub lane: String,
    pub job_id: String,
    pub result: JobResult,
    pub url: Option<String>,
    pub infohash: Option<String>,
    pub message: Option<String>,
    pub finished_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Out,
    Err,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogLine {
    pub ts: u64,
    pub stream: Stream,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Log {
    pub lane: String,
    pub lines: Vec<LogLine>,
}

// ---------- dashboard → agent ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Config(Config),
    Command(Command),
    Update(Update),
}

/// A new agent binary follows this message as one binary WebSocket frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Update {
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub graceful: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaneConfig {
    pub name: String,
    pub enabled: bool,
    pub drain: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub lanes: Vec<LaneConfig>,
    #[serde(rename = "maxSizeGiB")]
    pub max_size_gib: u32,
    pub idle_sec: u32,
    pub pirate_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Restart,
    RestartAll,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub id: String,
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    pub graceful: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Every shared fixture must parse and serialize back to the same JSON, so the
    /// Rust and TypeScript sides cannot drift apart silently.
    #[test]
    fn fixtures_round_trip() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/fixtures");
        let mut n = 0;
        for entry in std::fs::read_dir(&dir).expect("fixtures dir") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let back = match raw["type"].as_str().unwrap() {
                "config" | "command" | "update" => {
                    serde_json::to_value(serde_json::from_value::<ServerMsg>(raw.clone()).unwrap())
                }
                _ => serde_json::to_value(serde_json::from_value::<AgentMsg>(raw.clone()).unwrap()),
            }
            .unwrap();
            assert_eq!(back, raw, "{} does not round-trip", path.display());
            n += 1;
        }
        assert!(n > 5, "expected the shared fixtures, found {n}");
    }
}
