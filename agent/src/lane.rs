//! One lane = one `pf work --name <lane>` worker. This file holds the lane's bookkeeping
//! (job state machine, restart backoff); process handling lives in supervisor.rs so this
//! part can be tested without spawning anything.

use crate::parser::{parse, Ev};
use crate::protocol::{
    ActiveJob, AgentMsg, JobFinished, JobResult, JobStarted, LaneState, LaneStatus, LogLine,
};
use std::time::Duration;
use tokio::time::Instant;

const BACKOFF_BASE: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// A worker that ran this long before dying resets the backoff.
const HEALTHY_RUN: Duration = Duration::from_secs(600);
/// Pirate Face keeps a lease for 10 minutes after its last renewal and pf cannot release
/// it, so a lane whose worker died mid-job must wait this long before leasing again.
pub const LEASE_LAPSE_MS: u64 = 10 * 60_000 + 30_000;
/// A refused lease we did not see coming (e.g. the agent itself was restarted mid-job):
/// check again this often instead of backing off exponentially.
const LEASE_RECHECK_MS: u64 = 60_000;
pub const LEASE_WAIT_MESSAGE: &str =
    "waiting for the previous worker's Pirate Face lease to lapse (up to 10 minutes)";

pub struct Proc {
    pub pid: u32,
    pub gen: u64,
    pub started: Instant,
    pub started_ms: u64,
    pub stopping: bool,
    pub restart_after: bool,
}

/// A seen outcome not reported yet: result, url, infohash, message.
type Outcome = (JobResult, Option<String>, Option<String>, Option<String>);

pub struct Job {
    pub id: String,
    pub repo: String,
    pub revision: String,
    pub files: u32,
    pub size_bytes: u64,
    pub done_bytes: u64,
    pub started_ms: u64,
    pub rate_bps: f64,
    announced: bool,
    last_progress: Option<(Instant, u64)>,
    /// outcome seen but not reported yet (`listed` waits for its `infohash` line)
    pending: Option<Outcome>,
}

#[derive(Default, Debug)]
pub struct Effects {
    pub msgs: Vec<AgentMsg>,
    /// bytes verified since the last line (feeds the processed-bytes counter)
    pub processed: u64,
    /// the lane wants its worker stopped now (draining, or a restart was waiting for the job to end)
    pub stop_now: bool,
}

pub struct Lane {
    pub name: String,
    pub enabled: bool,
    pub drain: bool,
    pub in_config: bool,
    pub proc: Option<Proc>,
    pub state: LaneState,
    pub message: Option<String>,
    pub restarts: u32,
    pub last_exit: Option<i32>,
    fails: u32,
    pub next_start: Option<Instant>,
    pub restart_pending: bool,
    /// wall-clock ms until which Pirate Face may still hold this lane's lease from a killed worker
    pub lease_free_ms: Option<u64>,
    pub job: Option<Job>,
    pub logs: Vec<LogLine>,
}

impl Lane {
    pub fn new(name: &str) -> Self {
        Lane {
            name: name.to_string(),
            enabled: false,
            drain: false,
            in_config: true,
            proc: None,
            state: LaneState::Stopped,
            message: None,
            restarts: 0,
            last_exit: None,
            fails: 0,
            next_start: None,
            restart_pending: false,
            lease_free_ms: None,
            job: None,
            logs: Vec::new(),
        }
    }

    fn new_job(&mut self, repo: String, now_ms: u64, fx: &mut Effects) {
        self.flush_pending(now_ms, fx);
        if self.job.is_some() {
            // a new lease while one was open: the old one never reported an outcome
            self.finish(
                JobResult::Aborted,
                None,
                None,
                Some("superseded by a new lease".into()),
                now_ms,
                fx,
            );
        }
        self.job = Some(Job {
            id: uuid::Uuid::new_v4().to_string(),
            repo,
            revision: String::new(),
            files: 0,
            size_bytes: 0,
            done_bytes: 0,
            started_ms: now_ms,
            rate_bps: 0.0,
            announced: false,
            last_progress: None,
            pending: None,
        });
        self.state = LaneState::Working;
        self.message = None;
    }

    fn announce(&mut self, fx: &mut Effects) {
        let Some(job) = self.job.as_mut() else { return };
        if job.announced {
            return;
        }
        job.announced = true;
        fx.msgs.push(AgentMsg::JobStarted(JobStarted {
            lane: self.name.clone(),
            job_id: job.id.clone(),
            repo: job.repo.clone(),
            revision: job.revision.clone(),
            files: job.files,
            size_bytes: job.size_bytes,
            started_at: job.started_ms,
        }));
    }

    fn finish(
        &mut self,
        result: JobResult,
        url: Option<String>,
        infohash: Option<String>,
        message: Option<String>,
        now_ms: u64,
        fx: &mut Effects,
    ) {
        if self.job.is_none() {
            return;
        }
        self.announce(fx);
        let job = self.job.take().expect("checked above");
        fx.msgs.push(AgentMsg::JobFinished(JobFinished {
            lane: self.name.clone(),
            job_id: job.id,
            result,
            url,
            infohash,
            message,
            finished_at: now_ms,
        }));
        if self.proc.is_some() {
            self.state = LaneState::Idle;
        }
        if (!self.enabled && self.drain) || self.restart_pending {
            fx.stop_now = true;
        }
    }

    fn flush_pending(&mut self, now_ms: u64, fx: &mut Effects) {
        if let Some((r, u, h, m)) = self.job.as_mut().and_then(|j| j.pending.take()) {
            self.finish(r, u, h, m, now_ms, fx);
        }
    }

    /// One cleaned line of worker output.
    pub fn on_line(&mut self, text: &str, now_ms: u64, now: Instant) -> Effects {
        let mut fx = Effects::default();
        match parse(text) {
            Ev::Leased(repo) => self.new_job(repo, now_ms, &mut fx),
            Ev::LeasedAll {
                repo,
                revision,
                files,
                gb,
            } => {
                self.new_job(repo, now_ms, &mut fx);
                if let Some(j) = self.job.as_mut() {
                    (j.revision, j.files, j.size_bytes) = (revision, files, (gb * 1e9) as u64);
                }
                self.announce(&mut fx);
            }
            Ev::Revision(r) => {
                if let Some(j) = self.job.as_mut() {
                    j.revision = r;
                }
            }
            Ev::Files(n) => {
                if let Some(j) = self.job.as_mut() {
                    j.files = n;
                }
            }
            Ev::SizeGb(g) => {
                if let Some(j) = self.job.as_mut() {
                    j.size_bytes = (g * 1e9) as u64;
                }
                self.announce(&mut fx);
            }
            Ev::Progress { done_gb, total_gb } => {
                if self.job.is_none() {
                    self.new_job("(unknown)".into(), now_ms, &mut fx);
                }
                let job = self.job.as_mut().expect("just ensured");
                if job.size_bytes == 0 {
                    job.size_bytes = (total_gb * 1e9) as u64;
                }
                let done = (done_gb * 1e9) as u64;
                fx.processed += done.saturating_sub(job.done_bytes);
                if let Some((t0, b0)) = job.last_progress {
                    let dt = now.duration_since(t0).as_secs_f64();
                    if dt >= 0.5 {
                        let inst = done.saturating_sub(b0) as f64 / dt;
                        job.rate_bps = if job.rate_bps == 0.0 {
                            inst
                        } else {
                            0.7 * job.rate_bps + 0.3 * inst
                        };
                        job.last_progress = Some((now, done));
                    }
                } else {
                    job.last_progress = Some((now, done));
                }
                job.done_bytes = done;
                self.announce(&mut fx);
                self.state = LaneState::Working;
            }
            Ev::Listed(url) => {
                if let Some(j) = self.job.as_mut() {
                    j.pending = Some((JobResult::Listed, Some(url), None, None));
                }
            }
            Ev::Infohash(h) => {
                if let Some((r, u, _, m)) = self.job.as_mut().and_then(|j| j.pending.take()) {
                    self.finish(r, u, Some(h), m, now_ms, &mut fx);
                }
            }
            Ev::AlreadyListed { url, infohash } => self.finish(
                JobResult::AlreadyListed,
                url,
                infohash,
                None,
                now_ms,
                &mut fx,
            ),
            Ev::NotListed(msg) => {
                self.finish(JobResult::Refused, None, None, Some(msg), now_ms, &mut fx)
            }
            Ev::Error(msg) => {
                self.message = Some(msg.clone());
                self.flush_pending(now_ms, &mut fx);
                self.finish(JobResult::Error, None, None, Some(msg), now_ms, &mut fx);
            }
            Ev::Idle => {
                self.flush_pending(now_ms, &mut fx);
                self.state = LaneState::Idle;
                self.message = None;
                if (!self.enabled && self.drain) || self.restart_pending {
                    fx.stop_now = true;
                }
            }
            Ev::Other => self.flush_pending(now_ms, &mut fx),
        }
        if self.state == LaneState::Working && !self.enabled && self.drain {
            self.state = LaneState::Draining;
        }
        fx
    }

    /// The worker process ended (after all its output was read).
    /// True while a lease from a killed worker may still block this lane.
    pub fn lease_blocked(&self, now_ms: u64) -> bool {
        self.lease_free_ms.is_some_and(|t| t > now_ms)
    }

    pub fn on_exit(&mut self, code: Option<i32>, now_ms: u64, now: Instant) -> Effects {
        let mut fx = Effects::default();
        self.flush_pending(now_ms, &mut fx);
        if self.job.is_some() {
            // killed mid-job: its lease stays held until it lapses
            self.lease_free_ms = Some(now_ms + LEASE_LAPSE_MS);
        }
        let why = format!(
            "worker exited ({})",
            code.map_or("signal".into(), |c| format!("code {c}"))
        );
        self.finish(JobResult::Aborted, None, None, Some(why), now_ms, &mut fx);
        let Some(p) = self.proc.take() else { return fx };
        self.last_exit = code;
        if p.stopping {
            if p.restart_after && self.enabled {
                self.next_start = Some(now);
                self.state = LaneState::Starting;
            } else {
                self.next_start = None;
                self.state = LaneState::Stopped;
            }
        } else if self
            .message
            .as_deref()
            .is_some_and(|m| m.contains("already hold lease"))
        {
            // a lease from an earlier worker we did not track (the agent restarted mid-job);
            // not a failure of this worker, so no exponential backoff
            self.lease_free_ms = Some(now_ms + LEASE_RECHECK_MS);
            self.next_start = None;
            self.state = LaneState::Backoff;
        } else {
            self.restarts += 1;
            if now.duration_since(p.started) >= HEALTHY_RUN {
                self.fails = 0;
            }
            self.fails += 1;
            let delay = BACKOFF_BASE
                .saturating_mul(1 << (self.fails - 1).min(8))
                .min(BACKOFF_MAX);
            self.next_start = Some(now + delay);
            self.state = LaneState::Backoff;
        }
        fx
    }

    pub fn status(&self) -> LaneStatus {
        LaneStatus {
            name: self.name.clone(),
            state: self.state,
            pid: self.proc.as_ref().map(|p| p.pid),
            started_at: self.proc.as_ref().map(|p| p.started_ms),
            restarts: self.restarts,
            last_exit: self.last_exit,
            message: self.message.clone(),
            job: self.job.as_ref().map(|j| ActiveJob {
                job_id: j.id.clone(),
                repo: j.repo.clone(),
                revision: j.revision.clone(),
                files: j.files,
                size_bytes: j.size_bytes,
                done_bytes: j.done_bytes,
                started_at: j.started_ms,
                rate_bps: j.rate_bps as u64,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(name: &str) -> Lane {
        let mut l = Lane::new(name);
        l.enabled = true;
        l.proc = Some(Proc {
            pid: 1,
            gen: 1,
            started: Instant::now(),
            started_ms: 0,
            stopping: false,
            restart_after: false,
        });
        l
    }

    fn feed(l: &mut Lane, lines: &[&str]) -> Effects {
        let mut all = Effects::default();
        for (i, line) in lines.iter().enumerate() {
            let fx = l.on_line(line, 1000 + i as u64, Instant::now());
            all.msgs.extend(fx.msgs);
            all.processed += fx.processed;
            all.stop_now |= fx.stop_now;
        }
        all
    }

    const JOB: &[&str] = &[
        "    leased    a/b",
        "    revision  1dbe8ad5e13e",
        "    files     67",
        "    size      88.73 GB",
        "    1.0 of 88.7 GB",
        "    3.5 of 88.7 GB",
    ];

    #[test]
    fn listed_job_reports_start_progress_and_finish() {
        let mut l = running("w1");
        let fx = feed(&mut l, JOB);
        assert_eq!(fx.processed, 3_500_000_000);
        let [AgentMsg::JobStarted(s)] = &fx.msgs[..] else {
            panic!("{:?}", fx.msgs)
        };
        assert_eq!(
            (s.repo.as_str(), s.revision.as_str(), s.files, s.size_bytes),
            ("a/b", "1dbe8ad5e13e", 67, 88_730_000_000)
        );
        assert_eq!(l.status().job.unwrap().done_bytes, 3_500_000_000);

        let fx = feed(
            &mut l,
            &[
                "    listed    https://pirateface.co/a/b",
                "    infohash  abc",
            ],
        );
        let [AgentMsg::JobFinished(f)] = &fx.msgs[..] else {
            panic!("{:?}", fx.msgs)
        };
        assert_eq!(f.result, JobResult::Listed);
        assert_eq!(f.infohash.as_deref(), Some("abc"));
        assert_eq!(f.job_id, s.job_id);
        assert!(l.job.is_none());
        assert_eq!(l.state, LaneState::Idle);
    }

    #[test]
    fn listed_without_infohash_still_finishes() {
        let mut l = running("w1");
        feed(&mut l, JOB);
        let fx = feed(
            &mut l,
            &[
                "    listed    https://pirateface.co/a/b",
                "Nothing queued. Checking again in 300 s.",
            ],
        );
        assert!(
            matches!(&fx.msgs[..], [AgentMsg::JobFinished(f)] if f.result == JobResult::Listed && f.infohash.is_none())
        );
    }

    #[test]
    fn errors_refusals_and_exit() {
        let mut l = running("w1");
        feed(&mut l, JOB);
        let fx = feed(&mut l, &["error: stream broke. Taking the next job."]);
        assert!(matches!(&fx.msgs[..], [AgentMsg::JobFinished(f)] if f.result == JobResult::Error));
        assert_eq!(
            l.message.as_deref(),
            Some("stream broke. Taking the next job.")
        );

        feed(&mut l, JOB);
        let fx = feed(&mut l, &["    Not listed (422): hashes differ"]);
        assert!(
            matches!(&fx.msgs[..], [AgentMsg::JobFinished(f)] if f.result == JobResult::Refused)
        );

        feed(&mut l, JOB);
        let fx = l.on_exit(Some(1), 5000, Instant::now());
        assert!(
            matches!(&fx.msgs[..], [AgentMsg::JobFinished(f)] if f.result == JobResult::Aborted)
        );
        assert_eq!(l.state, LaneState::Backoff);
        assert_eq!(l.restarts, 1);
    }

    #[test]
    fn drain_stops_after_the_job() {
        let mut l = running("w1");
        feed(&mut l, JOB);
        l.enabled = false;
        l.drain = true;
        let fx = feed(&mut l, &["    4.0 of 88.7 GB"]);
        assert!(!fx.stop_now);
        assert_eq!(l.state, LaneState::Draining);
        let fx = feed(
            &mut l,
            &["    Already listed: https://pirateface.co/a/b (h)"],
        );
        assert!(fx.stop_now);
    }

    #[test]
    fn a_worker_killed_mid_job_waits_for_its_lease() {
        let mut l = running("w1");
        feed(&mut l, JOB);
        l.proc.as_mut().unwrap().stopping = true;
        l.proc.as_mut().unwrap().restart_after = true;
        l.on_exit(None, 1_000, Instant::now());
        assert!(l.lease_blocked(1_000 + LEASE_LAPSE_MS - 1));
        assert!(!l.lease_blocked(1_000 + LEASE_LAPSE_MS));
    }

    #[test]
    fn a_refused_stale_lease_rechecks_without_backoff() {
        let mut l = running("w1");
        feed(
            &mut l,
            &["error: lease refused (409): You already hold lease e015. Renew it with {}."],
        );
        l.on_exit(Some(1), 5_000, Instant::now());
        assert_eq!(l.state, LaneState::Backoff);
        assert_eq!(l.restarts, 0);
        assert!(l.lease_blocked(5_000 + LEASE_RECHECK_MS - 1));
        assert!(!l.lease_blocked(5_000 + LEASE_RECHECK_MS));
    }

    #[test]
    fn backoff_grows_and_stopping_does_not_count() {
        let mut l = running("w1");
        let t = Instant::now();
        l.on_exit(Some(1), 0, t);
        let first = l.next_start.unwrap() - t;
        l.proc = Some(Proc {
            pid: 2,
            gen: 2,
            started: t,
            started_ms: 0,
            stopping: false,
            restart_after: false,
        });
        l.on_exit(Some(1), 0, t);
        assert!(l.next_start.unwrap() - t > first);

        l.proc = Some(Proc {
            pid: 3,
            gen: 3,
            started: t,
            started_ms: 0,
            stopping: true,
            restart_after: true,
        });
        l.on_exit(None, 0, t);
        assert_eq!(l.state, LaneState::Starting);
        assert_eq!(l.restarts, 2);
    }
}
