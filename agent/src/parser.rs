//! Turns `pf work` output lines into events. pf has no machine-readable output, so this
//! follows its human format (pirateface/work/runner.py and build.py) and ignores anything else.

#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    /// `leased  <repo>` (start of a job; revision/files/size follow)
    Leased(String),
    Revision(String),
    Files(u32),
    /// `size  88.73 GB`
    SizeGb(f64),
    /// Older pf: `==> Leased <repo> at <rev>: <n> files, <gb> GB`
    LeasedAll {
        repo: String,
        revision: String,
        files: u32,
        gb: f64,
    },
    /// `18.3 of 88.7 GB`, or pf 0.2.26+'s terminal bar ` 35%|███▌  | 8.50G/24.5G [01:23<02:40, 102MB/s]`
    Progress {
        done_gb: f64,
        total_gb: f64,
    },
    Listed(String),
    Infohash(String),
    AlreadyListed {
        url: Option<String>,
        infohash: Option<String>,
    },
    NotListed(String),
    Error(String),
    Idle,
    Other,
}

/// Strips ANSI colour codes and keeps only what follows the last carriage return.
pub fn clean(line: &str) -> String {
    let line = line.rsplit('\r').next().unwrap_or(line);
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim_end().to_string()
}

/// `label   value` -> value, when the line starts with exactly that label word.
fn field<'a>(t: &'a str, label: &str) -> Option<&'a str> {
    let rest = t.strip_prefix(label)?;
    rest.starts_with(char::is_whitespace).then(|| rest.trim())
}

fn gb(s: &str) -> Option<f64> {
    s.trim().strip_suffix("GB")?.trim().parse().ok()
}

/// tqdm's decimal sizes: `512`, `1.70G`, `24.5G`, `1.02T` -> GB
fn si_gb(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num, exp) = match s.char_indices().last()? {
        (i, c) if c.is_ascii_alphabetic() => (&s[..i], "kMGTP".find(c)? as i32 + 1),
        _ => (s, 0),
    };
    Some(num.parse::<f64>().ok()? * 1e3f64.powi(exp) / 1e9)
}

pub fn parse(line: &str) -> Ev {
    let t = line.trim();
    if let Some(v) = field(t, "leased") {
        return Ev::Leased(v.split_whitespace().next().unwrap_or(v).to_string());
    }
    if let Some(v) = field(t, "revision") {
        return Ev::Revision(v.to_string());
    }
    if let Some(n) = field(t, "files").and_then(|v| v.parse().ok()) {
        return Ev::Files(n);
    }
    if let Some(g) = field(t, "size").and_then(gb) {
        return Ev::SizeGb(g);
    }
    if let Some(v) = field(t, "listed") {
        return Ev::Listed(v.to_string());
    }
    if let Some(v) = field(t, "infohash") {
        return Ev::Infohash(v.to_string());
    }
    if let Some(rest) = t.strip_prefix("==> Leased ") {
        // <repo> at <rev>: <n> files, <gb> GB
        if let Some((repo, rest)) = rest.split_once(" at ") {
            if let Some((rev, rest)) = rest.split_once(": ") {
                if let Some((n, size)) = rest.split_once(" files, ") {
                    return Ev::LeasedAll {
                        repo: repo.to_string(),
                        revision: rev.to_string(),
                        files: n.trim().parse().unwrap_or(0),
                        gb: gb(size).unwrap_or(0.0),
                    };
                }
            }
        }
        return Ev::Leased(rest.split_whitespace().next().unwrap_or("").to_string());
    }
    if let Some((done, total)) = t.split_once(" of ") {
        if let (Ok(d), Some(tot)) = (done.trim().parse::<f64>(), gb(total)) {
            return Ev::Progress {
                done_gb: d,
                total_gb: tot,
            };
        }
    }
    if let Some((_, rest)) = t.rsplit_once("| ") {
        if let Some((done, total)) = rest.split_once(" [").and_then(|(c, _)| c.split_once('/')) {
            if let (Some(d), Some(tot)) = (si_gb(done), si_gb(total)) {
                return Ev::Progress {
                    done_gb: d,
                    total_gb: tot,
                };
            }
        }
    }
    if let Some(rest) = t.strip_prefix("Already listed:") {
        // <url> (<infohash>)
        let rest = rest.trim();
        let (url, hash) = match rest.split_once(" (") {
            Some((u, h)) => (u.trim(), h.trim_end_matches(')').trim()),
            None => (rest, ""),
        };
        let some = |s: &str| (!s.is_empty()).then(|| s.to_string());
        return Ev::AlreadyListed {
            url: some(url),
            infohash: some(hash),
        };
    }
    if t.starts_with("Not listed (") {
        return Ev::NotListed(t.to_string());
    }
    if let Some(msg) = t.strip_prefix("error:") {
        return Ev::Error(msg.trim().to_string());
    }
    if t.starts_with("Nothing queued") || t.starts_with("No work is queued") {
        return Ev::Idle;
    }
    Ev::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_block() {
        assert_eq!(
            parse("    leased    orcarouter/Qwen3.8-27B-MLX"),
            Ev::Leased("orcarouter/Qwen3.8-27B-MLX".into())
        );
        assert_eq!(
            parse("    revision  1dbe8ad5e13e"),
            Ev::Revision("1dbe8ad5e13e".into())
        );
        assert_eq!(parse("    files     67"), Ev::Files(67));
        assert_eq!(parse("    size      88.73 GB"), Ev::SizeGb(88.73));
        assert_eq!(
            parse("    18.3 of 88.7 GB"),
            Ev::Progress {
                done_gb: 18.3,
                total_gb: 88.7
            }
        );
        assert_eq!(
            parse("    listed    https://pirateface.co/a/b"),
            Ev::Listed("https://pirateface.co/a/b".into())
        );
        assert_eq!(parse("    infohash  abc123"), Ev::Infohash("abc123".into()));
    }

    #[test]
    fn terminal_bar() {
        assert_eq!(
            parse(" 35%|███▌      | 8.50G/24.5G [01:23<02:40, 102MB/s]"),
            Ev::Progress {
                done_gb: 8.5,
                total_gb: 24.5
            }
        );
        assert_eq!(
            parse("  0%|          | 0.00/1.02T [00:00<?, ?B/s]"),
            Ev::Progress {
                done_gb: 0.0,
                total_gb: 1020.0
            }
        );
        assert_eq!(parse("a | b [c]"), Ev::Other);
    }

    #[test]
    fn outcomes() {
        assert_eq!(
            parse("    Already listed: https://pirateface.co/a/b (deadbeef)"),
            Ev::AlreadyListed {
                url: Some("https://pirateface.co/a/b".into()),
                infohash: Some("deadbeef".into())
            }
        );
        assert_eq!(
            parse("    Not listed (422): bad hashes"),
            Ev::NotListed("Not listed (422): bad hashes".into())
        );
        assert_eq!(
            parse("error: boom. Taking the next job."),
            Ev::Error("boom. Taking the next job.".into())
        );
        assert_eq!(parse("Nothing queued. Checking again in 300 s."), Ev::Idle);
        assert_eq!(parse("No work is queued right now."), Ev::Idle);
    }

    #[test]
    fn old_format_and_noise() {
        assert_eq!(
            parse("==> Leased a/b at 0123456789ab: 3 files, 2.50 GB"),
            Ev::LeasedAll {
                repo: "a/b".into(),
                revision: "0123456789ab".into(),
                files: 3,
                gb: 2.5
            }
        );
        assert_eq!(parse("==> pf work: you build the torrent"), Ev::Other);
        assert_eq!(parse("leasedX something"), Ev::Other);
        assert_eq!(parse("one of these GB"), Ev::Other);
    }

    #[test]
    fn cleaning() {
        assert_eq!(clean("\x1b[2mleased\x1b[0m  a/b  "), "leased  a/b");
        assert_eq!(clean("1.0 of 9.0 GB\r2.0 of 9.0 GB"), "2.0 of 9.0 GB");
    }
}
