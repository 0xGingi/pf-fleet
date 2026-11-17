//! Owns the lanes: starts/stops `pf work` processes to match the dashboard's config,
//! turns their output into protocol messages, and builds heartbeats.

use crate::config;
use crate::lane::{Lane, Proc};
use crate::parser::clean;
use crate::protocol::*;
use crate::system;
use std::collections::BTreeMap;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::Instant;

/// How long a worker gets after SIGTERM before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(20);
const LOG_TAIL: usize = 400;

pub enum ProcEv {
    Line {
        lane: String,
        gen: u64,
        stream: Stream,
        text: String,
    },
    Exit {
        lane: String,
        gen: u64,
        code: Option<i32>,
    },
    KillDeadline {
        lane: String,
        gen: u64,
    },
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn signal_group(pid: u32, sig: i32) {
    // workers run in their own process group, so this reaches uvx and the python it started
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

pub struct Supervisor {
    pub lanes: BTreeMap<String, Lane>,
    pub cfg: Option<Config>,
    pub uvx: Option<PathBuf>,
    pub processed: u64,
    gen: u64,
    pub connected: bool,
    /// announced by the dashboard; `staged` once the binary is verified and swapped in
    pub update: Option<(Update, bool)>,
    out: UnboundedSender<AgentMsg>,
    ev_tx: UnboundedSender<ProcEv>,
    active_jobs: Arc<Mutex<Vec<String>>>,
    state_path: PathBuf,
}

impl Supervisor {
    pub fn new(
        out: UnboundedSender<AgentMsg>,
        ev_tx: UnboundedSender<ProcEv>,
        active_jobs: Arc<Mutex<Vec<String>>>,
        state_path: PathBuf,
    ) -> Self {
        let mut s = Supervisor {
            lanes: BTreeMap::new(),
            cfg: None,
            uvx: system::find_uvx(),
            processed: 0,
            gen: 0,
            connected: false,
            update: None,
            out,
            ev_tx,
            active_jobs,
            state_path,
        };
        if let Some(cfg) = config::load_state(&s.state_path) {
            eprintln!(
                "pf-fleet-agent: resuming {} lane(s) from {}",
                cfg.lanes.len(),
                s.state_path.display()
            );
            s.apply_config(cfg, false);
        }
        s
    }

    fn send(&self, msg: AgentMsg) {
        let _ = self.out.send(msg);
    }

    fn agent_log(&mut self, lane: &str, text: String) {
        eprintln!("[{lane}] {text}");
        if let Some(l) = self.lanes.get_mut(lane) {
            l.logs.push(LogLine {
                ts: now_ms(),
                stream: Stream::Agent,
                text,
            });
        }
    }

    pub fn apply_config(&mut self, cfg: Config, save: bool) {
        let worker_args_changed = self.cfg.as_ref().is_some_and(|p| {
            (p.max_size_gib, p.idle_sec, &p.pirate_key)
                != (cfg.max_size_gib, cfg.idle_sec, &cfg.pirate_key)
        });
        for lc in &cfg.lanes {
            let lane = self
                .lanes
                .entry(lc.name.clone())
                .or_insert_with(|| Lane::new(&lc.name));
            if lane.enabled != lc.enabled {
                lane.next_start = None; // a fresh enable starts now, not after an old backoff
            }
            (lane.enabled, lane.drain, lane.in_config) = (lc.enabled, lc.drain, true);
        }
        for (name, lane) in self.lanes.iter_mut() {
            if !cfg.lanes.iter().any(|lc| &lc.name == name) {
                (lane.enabled, lane.drain, lane.in_config) = (false, false, false);
            }
            if worker_args_changed && lane.proc.is_some() {
                lane.restart_pending = true;
            }
        }
        if save {
            if let Err(e) = config::save_state(&self.state_path, &cfg) {
                eprintln!(
                    "pf-fleet-agent: could not save {}: {e}",
                    self.state_path.display()
                );
            }
        }
        self.cfg = Some(cfg);
        self.reconcile();
    }

    /// A new agent is in place: let every lane finish its job (or stop now), start nothing new.
    pub fn staged_update(&self) -> Option<&Update> {
        self.update
            .as_ref()
            .filter(|(_, staged)| *staged)
            .map(|(u, _)| u)
    }

    /// The new binary arrived for the announced update.
    pub fn on_update_binary(&mut self, exe: &std::path::Path, bytes: &[u8]) {
        let Some((meta, false)) = self.update.clone() else {
            eprintln!("pf-fleet-agent: ignoring an unannounced binary from the dashboard");
            return;
        };
        match crate::update::install(exe, &meta, bytes) {
            Ok(()) => {
                eprintln!(
                    "pf-fleet-agent: agent {} installed; restarting into it {}",
                    meta.version,
                    if meta.graceful {
                        "once every lane finishes its job"
                    } else {
                        "now"
                    }
                );
                self.update = Some((meta.clone(), true));
                if !meta.graceful {
                    let names: Vec<String> = self.lanes.keys().cloned().collect();
                    for n in names {
                        self.stop(&n, false);
                    }
                }
                self.reconcile();
            }
            Err(e) => {
                eprintln!("pf-fleet-agent: update to {} failed: {e:#}", meta.version);
                self.update = None;
            }
        }
    }

    /// True when a staged update can take over (no worker left running).
    pub fn ready_to_restart(&self) -> bool {
        self.staged_update().is_some() && self.running() == 0
    }

    /// Bring processes in line with the desired state. Called on every change and every second.
    pub fn reconcile(&mut self) {
        let now = Instant::now();
        let updating = self.staged_update().is_some();
        let blocker = match (
            &self.uvx,
            self.cfg.as_ref().and_then(|c| c.pirate_key.as_ref()),
        ) {
            (None, _) => Some(
                "uv is not installed on this node (no uvx found); run the install command again"
                    .to_string(),
            ),
            (_, None) => Some(
                "no Pirate Face key: set one on this node's account in the dashboard".to_string(),
            ),
            _ => None,
        };
        let names: Vec<String> = self.lanes.keys().cloned().collect();
        for name in names {
            let lane = self.lanes.get_mut(&name).expect("from keys");
            if !lane.enabled {
                lane.restart_pending = false;
                match &lane.proc {
                    Some(p) if !p.stopping => {
                        if lane.drain && lane.job.is_some() {
                            lane.state = LaneState::Draining;
                        } else {
                            self.stop(&name, false);
                        }
                    }
                    Some(_) => {}
                    None => {
                        lane.state = LaneState::Stopped;
                        lane.next_start = None;
                    }
                }
                continue;
            }
            if updating {
                // finish the current job, then stop; the new agent starts the lanes again
                match &lane.proc {
                    Some(p) if !p.stopping && lane.job.is_none() => self.stop(&name, false),
                    Some(_) => lane.restart_pending = true,
                    None => {}
                }
                continue;
            }
            if lane.proc.is_none() {
                if let Some(msg) = &blocker {
                    lane.state = LaneState::Error;
                    lane.message = Some(msg.clone());
                    continue;
                }
                if lane.next_start.is_none_or(|t| t <= now) {
                    self.spawn(&name);
                }
            } else if lane.restart_pending
                && lane.job.is_none()
                && !lane.proc.as_ref().is_some_and(|p| p.stopping)
            {
                self.stop(&name, true);
            }
        }
        self.lanes.retain(|_, l| l.in_config || l.proc.is_some());
        *self.active_jobs.lock().unwrap() = self
            .lanes
            .values()
            .filter_map(|l| l.job.as_ref().map(|j| j.id.clone()))
            .collect();
    }

    fn spawn(&mut self, name: &str) {
        let (Some(uvx), Some(cfg)) = (self.uvx.clone(), self.cfg.clone()) else {
            return;
        };
        let Some(key) = cfg.pirate_key.clone() else {
            return;
        };
        self.gen += 1;
        let gen = self.gen;
        let mut cmd = tokio::process::Command::new(&uvx);
        cmd.args([
            "-p",
            "3.13",
            "--from",
            "pirateface@latest",
            "pf",
            "work",
            "-y",
            "--name",
            name,
            "--idle",
        ])
        .arg(cfg.idle_sec.to_string());
        if cfg.max_size_gib > 0 {
            cmd.arg("--max-size").arg(cfg.max_size_gib.to_string());
        }
        cmd.env("PIRATEFACE_KEY", key)
            .env("PYTHONUNBUFFERED", "1")
            .env("NO_COLOR", "1")
            // shared hosts (seedboxes) often cap threads per user; uv sizes pools by core count otherwise
            .env("RAYON_NUM_THREADS", "2")
            .env("UV_CONCURRENT_INSTALLS", "1")
            .env("UV_CONCURRENT_DOWNLOADS", "4")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let lane = self.lanes.get_mut(name).expect("caller checked");
        match cmd.spawn() {
            Err(e) => {
                lane.state = LaneState::Error;
                lane.message = Some(format!("could not start {}: {e}", uvx.display()));
                lane.next_start = Some(Instant::now() + Duration::from_secs(30));
            }
            Ok(mut child) => {
                let pid = child.id().unwrap_or(0);
                lane.proc = Some(Proc {
                    pid,
                    gen,
                    started: Instant::now(),
                    started_ms: now_ms(),
                    stopping: false,
                    restart_after: false,
                });
                lane.state = LaneState::Starting;
                lane.message = None;
                lane.next_start = None;
                let (stdout, stderr) = (
                    child.stdout.take().expect("piped"),
                    child.stderr.take().expect("piped"),
                );
                let (tx, lane_name) = (self.ev_tx.clone(), name.to_string());
                tokio::spawn(async move {
                    // read both pipes to EOF before reporting the exit, so the last lines
                    // (usually the reason it died) arrive before the Exit event
                    tokio::join!(
                        pump(stdout, Stream::Out, &lane_name, gen, &tx),
                        pump(stderr, Stream::Err, &lane_name, gen, &tx)
                    );
                    let code = child
                        .wait()
                        .await
                        .ok()
                        .and_then(|s| s.code().or_else(|| s.signal().map(|sig| 128 + sig)));
                    let _ = tx.send(ProcEv::Exit {
                        lane: lane_name,
                        gen,
                        code,
                    });
                });
                self.agent_log(name, format!("started pf work (pid {pid})"));
            }
        }
    }

    pub fn stop(&mut self, name: &str, restart_after: bool) {
        let Some(lane) = self.lanes.get_mut(name) else {
            return;
        };
        lane.restart_pending = false;
        let Some(p) = lane.proc.as_mut() else {
            if restart_after {
                lane.next_start = None;
            }
            return;
        };
        p.restart_after |= restart_after;
        if p.stopping {
            return;
        }
        p.stopping = true;
        let (pid, gen) = (p.pid, p.gen);
        signal_group(pid, libc::SIGTERM);
        let tx = self.ev_tx.clone();
        let lane_name = name.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(KILL_GRACE).await;
            let _ = tx.send(ProcEv::KillDeadline {
                lane: lane_name,
                gen,
            });
        });
        self.agent_log(
            name,
            format!(
                "stopping pf work (pid {pid}){}",
                if restart_after { " to restart it" } else { "" }
            ),
        );
    }

    pub fn on_proc(&mut self, ev: ProcEv) {
        match ev {
            ProcEv::Line {
                lane,
                gen,
                stream,
                text,
            } => {
                let text = clean(&text);
                let Some(l) = self.lanes.get_mut(&lane) else {
                    return;
                };
                if l.proc.as_ref().map(|p| p.gen) != Some(gen) || text.is_empty() {
                    return;
                }
                eprintln!("[{lane}] {text}");
                let fx = l.on_line(&text, now_ms(), Instant::now());
                l.logs.push(LogLine {
                    ts: now_ms(),
                    stream,
                    text,
                });
                self.processed += fx.processed;
                let restart = l.enabled;
                for m in fx.msgs {
                    self.send(m);
                }
                if fx.stop_now {
                    self.stop(&lane, restart);
                }
                self.reconcile();
            }
            ProcEv::Exit { lane, gen, code } => {
                let Some(l) = self.lanes.get_mut(&lane) else {
                    return;
                };
                if l.proc.as_ref().map(|p| p.gen) != Some(gen) {
                    return;
                }
                let fx = l.on_exit(code, now_ms(), Instant::now());
                let retry = l
                    .next_start
                    .map(|t| t.saturating_duration_since(Instant::now()).as_secs());
                for m in fx.msgs {
                    self.send(m);
                }
                let code = code.map_or("signal".to_string(), |c| c.to_string());
                let text = match retry {
                    Some(s) if s > 0 => format!("pf work exited ({code}); retrying in {s}s"),
                    _ => format!("pf work exited ({code})"),
                };
                self.agent_log(&lane, text);
                self.reconcile();
            }
            ProcEv::KillDeadline { lane, gen } => {
                if let Some(p) = self.lanes.get(&lane).and_then(|l| l.proc.as_ref()) {
                    if p.gen == gen && p.stopping {
                        signal_group(p.pid, libc::SIGKILL);
                    }
                }
            }
        }
    }

    pub fn on_command(&mut self, cmd: Command) {
        let targets: Vec<String> = match (cmd.action, &cmd.lane) {
            (Action::RestartAll, _) => self
                .lanes
                .iter()
                .filter(|(_, l)| l.enabled)
                .map(|(n, _)| n.clone())
                .collect(),
            (Action::Restart, Some(lane)) if self.lanes.contains_key(lane) => vec![lane.clone()],
            _ => return,
        };
        for name in targets {
            let busy = self.lanes[&name].job.is_some();
            if cmd.graceful && busy {
                self.lanes
                    .get_mut(&name)
                    .expect("from keys")
                    .restart_pending = true;
                self.agent_log(
                    &name,
                    "restart requested; it happens after the current job".into(),
                );
            } else {
                self.stop(&name, true);
            }
        }
        self.reconcile();
    }

    pub fn flush_logs(&mut self) {
        let batches: Vec<(String, Vec<LogLine>)> = self
            .lanes
            .iter_mut()
            .filter(|(_, l)| !l.logs.is_empty())
            .map(|(n, l)| (n.clone(), std::mem::take(&mut l.logs)))
            .collect();
        for (lane, mut lines) in batches {
            if lines.len() > LOG_TAIL {
                lines.drain(..lines.len() - LOG_TAIL);
            }
            self.send(AgentMsg::Log(Log { lane, lines }));
        }
    }

    pub fn heartbeat(&mut self) {
        if self.uvx.is_none() {
            self.uvx = system::find_uvx();
        }
        let order: Vec<String> = match &self.cfg {
            Some(c) => c.lanes.iter().map(|l| l.name.clone()).collect(),
            None => vec![],
        };
        let mut lanes: Vec<LaneStatus> = order
            .iter()
            .filter_map(|n| self.lanes.get(n))
            .map(Lane::status)
            .collect();
        lanes.extend(
            self.lanes
                .values()
                .filter(|l| !order.contains(&l.name))
                .map(Lane::status),
        );
        self.send(AgentMsg::Heartbeat(Heartbeat {
            ts: now_ms(),
            system: system::stats(),
            uvx: self.uvx.as_ref().map(|p| p.display().to_string()),
            processed_bytes: self.processed,
            lanes,
            update_pending: self.staged_update().map(|u| u.version.clone()),
        }));
    }

    pub fn running(&self) -> usize {
        self.lanes.values().filter(|l| l.proc.is_some()).count()
    }

    pub fn stop_all(&mut self) {
        let names: Vec<String> = self.lanes.keys().cloned().collect();
        for n in names {
            if let Some(l) = self.lanes.get_mut(&n) {
                l.enabled = false;
                l.drain = false;
            }
            self.stop(&n, false);
        }
    }
}

async fn pump<R: AsyncRead + Unpin>(
    r: R,
    stream: Stream,
    lane: &str,
    gen: u64,
    tx: &UnboundedSender<ProcEv>,
) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf).into_owned();
                let _ = tx.send(ProcEv::Line {
                    lane: lane.to_string(),
                    gen,
                    stream,
                    text,
                });
            }
        }
    }
}
