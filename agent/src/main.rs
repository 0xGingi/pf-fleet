//! pf-fleet-agent: runs Pirate Face `pf work` lanes on this machine as the dashboard says,
//! and reports their status, jobs and logs back over one outbound WebSocket.

mod config;
mod conn;
mod lane;
mod parser;
mod protocol;
mod supervisor;
mod system;
mod update;

use anyhow::Result;
use conn::{Conn, ConnEvent};
use protocol::{AgentMsg, Hello, ServerMsg};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use supervisor::Supervisor;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::mpsc;

/// Release builds set PF_FLEET_VERSION (the git tag); local builds use Cargo.toml's version.
pub const VERSION: &str = match option_env!("PF_FLEET_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

const USAGE: &str = "pf-fleet-agent — runs Pirate Face `pf work` lanes for the pf-fleet dashboard

usage:
  pf-fleet-agent run [--config <dir>]   run the agent (what the systemd unit does)
  pf-fleet-agent version

The config dir (default ~/.config/pf-fleet) holds agent.json, written by the
install command from the dashboard, and state.json, the last lane config.";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("run") => {
            let dir = match args.iter().position(|a| a == "--config") {
                Some(i) => PathBuf::from(
                    args.get(i + 1)
                        .ok_or_else(|| anyhow::anyhow!("--config needs a directory"))?,
                ),
                None => config::default_dir(),
            };
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(run(dir))
        }
        Some("version" | "--version" | "-V") => {
            println!("pf-fleet-agent {VERSION}");
            Ok(())
        }
        _ => {
            println!("{USAGE}");
            Ok(())
        }
    }
}

async fn run(dir: PathBuf) -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // resolved now: once an update replaces the file, /proc/self/exe points at a deleted inode
    let exe = std::env::current_exe()?;
    let agent = config::load_agent(&dir.join("agent.json"))?;
    let url = config::ws_url(&agent.server);
    eprintln!("pf-fleet-agent {VERSION}: dashboard {url}");

    let (out_tx, out_rx) = mpsc::unbounded_channel::<AgentMsg>();
    let (conn_tx, mut conn_rx) = mpsc::unbounded_channel::<ConnEvent>();
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let active_jobs = Arc::new(Mutex::new(Vec::new()));

    let conn = Conn {
        url,
        token: agent.token,
        hello: Hello {
            agent_version: VERSION.into(),
            hostname: system::hostname(),
            os: system::os_name(),
            kernel: system::kernel(),
            arch: std::env::consts::ARCH.into(),
            cpus: system::cpus(),
            active_jobs: vec![],
        },
        active_jobs: active_jobs.clone(),
    };
    tokio::spawn(conn.run(out_rx, conn_tx));

    let mut sup = Supervisor::new(out_tx, ev_tx, active_jobs, dir.join("state.json"));
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut ticks: u64 = 0;
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;

    loop {
        tokio::select! {
            Some(ev) = conn_rx.recv() => match ev {
                ConnEvent::Connected => {
                    eprintln!("pf-fleet-agent: connected");
                    sup.connected = true;
                    sup.heartbeat();
                }
                ConnEvent::Disconnected(why) => {
                    if sup.connected {
                        eprintln!("pf-fleet-agent: disconnected: {why}");
                    }
                    sup.connected = false;
                }
                ConnEvent::Msg(ServerMsg::Config(cfg)) => sup.apply_config(cfg, true),
                ConnEvent::Msg(ServerMsg::Command(cmd)) => sup.on_command(cmd),
                ConnEvent::Msg(ServerMsg::Update(u)) => {
                    if u.version == VERSION {
                        eprintln!("pf-fleet-agent: already on {VERSION}; ignoring update");
                    } else {
                        eprintln!("pf-fleet-agent: receiving agent {}", u.version);
                        sup.update = Some((u, false));
                    }
                }
                ConnEvent::Binary(bytes) => sup.on_update_binary(&exe, &bytes),
            },
            Some(ev) = ev_rx.recv() => sup.on_proc(ev),
            _ = tick.tick() => {
                ticks += 1;
                sup.flush_logs();
                if ticks.is_multiple_of(5) && sup.connected {
                    sup.heartbeat();
                }
                sup.reconcile();
                if sup.ready_to_restart() {
                    restart_into(&exe, &mut sup).await;
                }
            }
            _ = term.recv() => break,
            _ = int.recv() => break,
        }
    }

    eprintln!("pf-fleet-agent: stopping workers");
    sup.stop_all();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    while sup.running() > 0 {
        tokio::select! {
            Some(ev) = ev_rx.recv() => sup.on_proc(ev),
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
    sup.flush_logs();
    // give the connection a moment to send the last job events
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok(())
}

/// Replace this process with the freshly installed agent (same arguments, same PID, so
/// systemd and nohup setups both carry on). Workers are already stopped.
async fn restart_into(exe: &std::path::Path, sup: &mut Supervisor) {
    use std::os::unix::process::CommandExt;
    let version = sup
        .staged_update()
        .map(|u| u.version.clone())
        .unwrap_or_default();
    eprintln!("pf-fleet-agent: restarting into agent {version}");
    sup.flush_logs();
    tokio::time::sleep(Duration::from_millis(500)).await; // let the last frames go out
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec();
    eprintln!("pf-fleet-agent: could not start the new agent ({err}); carrying on with {VERSION}");
    sup.update = None;
}
