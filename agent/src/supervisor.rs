//! Owns the lanes: starts/stops `pf work` processes to match the dashboard's config,
//! turns their output into protocol messages, and builds heartbeats.

use crate::config;
use crate::lane::LEASE_WAIT_MESSAGE;
use crate::lane::{Lane, Proc};
use crate::parser::clean;
use crate::protocol::*;
use crate::system;
use std::collections::{BTreeMap, HashMap};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
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
        /// a progress-bar redraw: parsed for progress, kept out of the logs
        frame: bool,
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
    restart_requested: bool,
    /// last blocker reported as an event, so it is reported once, not every second
    reported_blocker: Option<String>,
    out: UnboundedSender<AgentMsg>,
    ev_tx: UnboundedSender<ProcEv>,
    active_jobs: Arc<Mutex<Vec<String>>>,
    state_path: PathBuf,
    /// leases.json: leases a previous agent process left behind, applied as lanes appear
    leases_path: PathBuf,
    held_leases: HashMap<String, u64>,
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
            restart_requested: false,
            reported_blocker: None,
            out,
            ev_tx,
            active_jobs,
            held_leases: config::take_leases(&state_path.with_file_name("leases.json")),
            leases_path: state_path.with_file_name("leases.json"),
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

    /// An entry for the node's event log in the dashboard (also in the journal).
    pub fn event(&self, level: Level, text: impl Into<String>) {
        let text = text.into();
        eprintln!("pf-fleet-agent: {text}");
        self.send(AgentMsg::Event(AgentEvent {
            ts: now_ms(),
            level,
            text,
        }));
    }

    /// A reinstall (SIGHUP) or update wants this process replaced once the lanes are idle.
    pub fn request_restart(&mut self) {
        if !self.restart_requested {
            self.restart_requested = true;
            self.event(
                Level::Info,
                "restart requested (agent reinstalled); restarting once every lane finishes its job",
            );
            self.reconcile();
        }
    }

    /// No new jobs: a new agent takes over as soon as the lanes are idle.
    fn restarting(&self) -> bool {
        self.restart_requested || self.staged_update().is_some()
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
            (p.max_size_gib, p.idle_sec, &p.pirate_key, &p.pirate_version)
                != (
                    cfg.max_size_gib,
                    cfg.idle_sec,
                    &cfg.pirate_key,
                    &cfg.pirate_version,
                )
        });
        for lc in &cfg.lanes {
            let lane = self
                .lanes
                .entry(lc.name.clone())
                .or_insert_with(|| Lane::new(&lc.name));
            if let Some(until) = self.held_leases.remove(&lc.name) {
                lane.lease_free_ms = Some(until);
            }
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
                self.event(
                    Level::Info,
                    format!(
                        "agent {} installed; restarting into it {}",
                        meta.version,
                        if meta.graceful {
                            "once every lane finishes its job"
                        } else {
                            "now"
                        }
                    ),
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
                self.event(
                    Level::Error,
                    format!("update to agent {} failed: {e:#}", meta.version),
                );
                self.update = None;
            }
        }
    }

    /// True when a new agent can take over (no worker left running).
    pub fn ready_to_restart(&self) -> bool {
        self.restarting() && self.running() == 0
    }

    /// Bring processes in line with the desired state. Called on every change and every second.
    pub fn reconcile(&mut self) {
        let now = Instant::now();
        let updating = self.restarting();
        // nothing to block before the dashboard has sent a config (no lanes yet either)
        let blocker = match (&self.uvx, self.cfg.as_ref().map(|c| c.pirate_key.as_ref())) {
            (_, None) => None,
            (None, Some(_)) => Some(
                "uv is not installed on this node (no uvx found); run the install command again"
                    .to_string(),
            ),
            (_, Some(None)) => Some(
                "no Pirate Face key: set one on this node's account in the dashboard".to_string(),
            ),
            _ => None,
        };
        if blocker != self.reported_blocker {
            if let Some(b) = &blocker {
                self.event(Level::Error, b.clone());
            }
            self.reported_blocker = blocker.clone();
        }
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
                if lane.lease_blocked(now_ms()) {
                    if lane.message.as_deref() != Some(LEASE_WAIT_MESSAGE) {
                        lane.state = LaneState::Backoff;
                        lane.message = Some(LEASE_WAIT_MESSAGE.into());
                        self.event(Level::Info, format!("lane {name} is {LEASE_WAIT_MESSAGE}"));
                    }
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
        // the dashboard follows PyPI and pins a version, so every lane runs the same one and
        // a new release restarts them (after their jobs) instead of waiting for a crash
        let pf_version = cfg.pirate_version.clone().filter(|v| valid_version(v));
        let package = match &pf_version {
            Some(v) => format!("pirateface=={v}"),
            None => "pirateface@latest".to_string(),
        };
        let mut cmd = tokio::process::Command::new(&uvx);
        cmd.args([
            "-p", "3.13", "--from", &package, "pf", "work", "-y", "--name", name, "--idle",
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
            .process_group(0);
        // pf 0.2.26+ draws its byte progress only on a terminal, so stderr gets one
        let pty_master = match pty() {
            Ok((master, slave)) => {
                cmd.stderr(slave);
                Some(master)
            }
            Err(e) => {
                self.agent_log(name, format!("no terminal for pf, so no progress: {e}"));
                cmd.stderr(Stdio::piped());
                None
            }
        };
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
                lane.pf_version = pf_version.clone();
                lane.next_start = None;
                let stdout = child.stdout.take().expect("piped");
                let stderr: Box<dyn AsyncRead + Send + Unpin> = match pty_master {
                    Some(m) => Box::new(tokio::fs::File::from_std(m)),
                    None => Box::new(child.stderr.take().expect("piped")),
                };
                drop(cmd); // closes our copy of the terminal, so its reader ends when pf does
                let (tx, lane_name) = (self.ev_tx.clone(), name.to_string());
                tokio::spawn(async move {
                    // read both to EOF before reporting the exit, so the last lines
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
                frame,
            } => {
                let text = clean(&text);
                let Some(l) = self.lanes.get_mut(&lane) else {
                    return;
                };
                if l.proc.as_ref().map(|p| p.gen) != Some(gen) || text.is_empty() {
                    return;
                }
                let fx = l.on_line(&text, now_ms(), Instant::now());
                if !frame {
                    eprintln!("[{lane}] {text}");
                    l.logs.push(LogLine {
                        ts: now_ms(),
                        stream,
                        text,
                    });
                }
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
                let reason = l.message.clone();
                for m in fx.msgs {
                    self.send(m);
                }
                let code = code.map_or("signal".to_string(), |c| c.to_string());
                let text = match retry {
                    Some(s) if s > 0 => {
                        // a crash (not a stop we asked for): worth a line in the node's event log
                        let why = reason.map(|r| format!(": {r}")).unwrap_or_default();
                        self.event(
                            Level::Warn,
                            format!("lane {lane}: pf work exited ({code}){why}; retrying in {s}s"),
                        );
                        format!("pf work exited ({code}); retrying in {s}s")
                    }
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

    /// Remember leases killed workers still hold, so the next agent process waits them out
    /// instead of being refused (called before exiting or re-exec'ing).
    pub fn save_leases(&self) {
        let now = now_ms();
        let held: HashMap<&str, u64> = self
            .lanes
            .iter()
            .filter_map(|(n, l)| {
                l.lease_free_ms
                    .filter(|t| *t > now)
                    .map(|t| (n.as_str(), t))
            })
            .collect();
        if let Err(e) = config::save_leases(&self.leases_path, &held) {
            eprintln!("pf-fleet-agent: could not save held leases: {e}");
        }
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

/// Sends each line, and each progress-bar redraw (text ended by `\r`, at most one per 2 s).
async fn pump<R: AsyncRead + Unpin>(
    r: R,
    stream: Stream,
    lane: &str,
    gen: u64,
    tx: &UnboundedSender<ProcEv>,
) {
    let mut reader = BufReader::new(r);
    let (mut buf, mut byte) = (Vec::new(), [0u8]);
    let mut last_frame: Option<Instant> = None;
    loop {
        // ponytail: byte at a time through the BufReader; pf writes a few lines a second
        let end = match reader.read(&mut byte).await {
            Ok(0) | Err(_) => return, // a terminal reports EIO once pf closes it
            Ok(_) if byte[0] == b'\n' || byte[0] == b'\r' => byte[0],
            Ok(_) => {
                buf.push(byte[0]);
                continue;
            }
        };
        if buf.is_empty() {
            continue;
        }
        let frame = end == b'\r';
        if frame {
            if last_frame.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
                buf.clear();
                continue;
            }
            last_frame = Some(Instant::now());
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        buf.clear();
        let _ = tx.send(ProcEv::Line {
            lane: lane.to_string(),
            gen,
            stream,
            text,
            frame,
        });
    }
}

/// A terminal for pf's stderr: raw (no `\r\n`), 120 columns (tqdm draws nothing at width 0),
/// close-on-exec so other lanes' workers never inherit it and keep it open.
fn pty() -> std::io::Result<(std::fs::File, std::fs::File)> {
    let (mut master, mut slave) = (0, 0);
    let size = libc::winsize {
        ws_row: 40,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: openpty fills in two new fds; null name and termios mean "don't care"/defaults
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            &size,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both fds were just opened and are owned by nothing else
    let (master, slave) = unsafe {
        (
            std::fs::File::from_raw_fd(master),
            std::fs::File::from_raw_fd(slave),
        )
    };
    // SAFETY: plain fcntl/termios calls on fds we own; termios is fully written by tcgetattr
    unsafe {
        for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(slave.as_raw_fd(), &mut t) == 0 {
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &t);
        }
    }
    Ok((master, slave))
}

/// Versions go on a command line as `pirateface==<v>`: allow only what PyPI versions use.
fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 40
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || ".+-".contains(c))
}

#[cfg(test)]
mod tests {
    use super::{pty, pump, valid_version, ProcEv, Stream};

    #[tokio::test]
    async fn pf_sees_a_wide_raw_terminal_and_its_bar_comes_through() {
        let (master, slave) = pty().expect("openpty");
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", r#"test -t 2 && stty size <&2 >&2; printf ' 7%%|x | 1.70G/24.5G [00:01]\rdone\n' >&2"#])
            .stderr(slave)
            .spawn()
            .expect("sh");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let read = pump(tokio::fs::File::from_std(master), Stream::Err, "w1", 1, &tx);
        tokio::time::timeout(std::time::Duration::from_secs(10), read)
            .await
            .expect("the reader ends once sh exits");
        child.wait().await.unwrap();
        let mut got = Vec::new();
        while let Ok(ProcEv::Line { text, frame, .. }) = rx.try_recv() {
            got.push((text, frame));
        }
        assert_eq!(
            got,
            [
                ("40 120".to_string(), false),
                (" 7%|x | 1.70G/24.5G [00:01]".to_string(), true),
                ("done".to_string(), false),
            ]
        );
    }

    #[test]
    fn versions_for_the_command_line() {
        assert!(valid_version("0.2.17"));
        assert!(valid_version("1.0.0rc1"));
        assert!(!valid_version(""));
        assert!(!valid_version("0.2; rm -rf"));
        assert!(!valid_version("--index-url=x"));
    }
}
