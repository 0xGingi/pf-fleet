//! Host facts and live stats from /proc (Linux only, which is what the agent targets).

use crate::protocol::SystemStats;
use std::path::{Path, PathBuf};

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

pub fn hostname() -> String {
    read("/proc/sys/kernel/hostname").trim().to_string()
}

pub fn kernel() -> String {
    read("/proc/sys/kernel/osrelease").trim().to_string()
}

pub fn os_name() -> String {
    read("/etc/os-release")
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim_matches('"').to_string())
        .unwrap_or_else(|| "Linux".into())
}

pub fn cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

pub fn stats() -> SystemStats {
    let mut s = SystemStats::default();
    let load: Vec<f64> = read("/proc/loadavg")
        .split_whitespace()
        .take(3)
        .filter_map(|v| v.parse().ok())
        .collect();
    if let [a, b, c] = load[..] {
        (s.load1, s.load5, s.load15) = (a, b, c);
    }
    for line in read("/proc/meminfo").lines() {
        let kb = |l: &str| {
            l.split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
                * 1024
        };
        if line.starts_with("MemTotal:") {
            s.mem_total = kb(line);
        } else if line.starts_with("MemAvailable:") {
            s.mem_available = kb(line);
        }
    }
    s.uptime = read("/proc/uptime")
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;
    for line in read("/proc/net/dev").lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        if iface.trim() == "lo" {
            continue;
        }
        let cols: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if cols.len() >= 9 {
            s.net_rx += cols[0];
            s.net_tx += cols[8];
        }
    }
    s
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// uvx from PATH, or where the uv installer puts it (systemd units often have a short PATH).
pub fn find_uvx() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    let extra = home
        .iter()
        .flat_map(|h| [h.join(".local/bin"), h.join(".cargo/bin")])
        .chain([PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")]);
    path_dirs
        .into_iter()
        .chain(extra)
        .map(|d| d.join("uvx"))
        .find(|p| is_executable(p))
}
