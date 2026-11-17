//! The WebSocket to the dashboard. Reconnects forever with backoff; while disconnected it
//! queues outgoing frames so job events are not lost (old log lines go first when full).

use crate::protocol::{AgentMsg, Hello, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const QUEUE_MAX: usize = 5000;
/// The dashboard pings idle sockets; silence this long means the connection is dead.
const READ_TIMEOUT: Duration = Duration::from_secs(150);

pub enum ConnEvent {
    Connected,
    Disconnected(String),
    Msg(ServerMsg),
    /// a binary frame: the agent binary announced by the preceding `update` message
    Binary(Vec<u8>),
}

pub struct Conn {
    pub url: String,
    pub token: String,
    /// Static host facts; `active_jobs` is filled in fresh on every connect.
    pub hello: Hello,
    pub active_jobs: Arc<Mutex<Vec<String>>>,
}

struct Queue(VecDeque<String>);

impl Queue {
    fn push(&mut self, frame: String) {
        if self.0.len() >= QUEUE_MAX {
            // drop the oldest log batch if there is one, else the oldest frame
            match self
                .0
                .iter()
                .position(|f| f.starts_with(r#"{"type":"log""#))
            {
                Some(i) => {
                    self.0.remove(i);
                }
                None => {
                    self.0.pop_front();
                }
            }
        }
        self.0.push_back(frame);
    }
}

fn encode(msg: &AgentMsg) -> String {
    serde_json::to_string(msg).expect("protocol types always serialize")
}

impl Conn {
    pub async fn run(
        self,
        mut out_rx: UnboundedReceiver<AgentMsg>,
        events: UnboundedSender<ConnEvent>,
    ) {
        let mut queue = Queue(VecDeque::new());
        let mut backoff = Duration::from_secs(1);
        loop {
            let reason = match self.session(&mut out_rx, &mut queue, &events).await {
                Ok(()) => "closed by dashboard".to_string(),
                Err(e) => e.to_string(),
            };
            let _ = events.send(ConnEvent::Disconnected(reason));
            // wait, but keep collecting outgoing frames meanwhile
            let until = Instant::now() + backoff;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(until) => break,
                    Some(msg) = out_rx.recv() => queue.push(encode(&msg)),
                }
            }
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    }

    async fn session(
        &self,
        out_rx: &mut UnboundedReceiver<AgentMsg>,
        queue: &mut Queue,
        events: &UnboundedSender<ConnEvent>,
    ) -> anyhow::Result<()> {
        let mut req = self.url.as_str().into_client_request()?;
        req.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {}", self.token))?,
        );
        req.headers_mut().insert(
            "User-Agent",
            HeaderValue::from_str(&format!("pf-fleet-agent/{}", crate::VERSION))?,
        );
        let (ws, _) = timeout(
            Duration::from_secs(20),
            tokio_tungstenite::connect_async(req),
        )
        .await??;
        let (mut tx, mut rx) = ws.split();

        let mut hello = self.hello.clone();
        hello.active_jobs = self.active_jobs.lock().unwrap().clone();
        tx.send(Message::text(encode(&AgentMsg::Hello(hello))))
            .await?;
        while let Some(frame) = queue.0.front() {
            tx.send(Message::text(frame.clone())).await?;
            queue.0.pop_front();
        }
        let _ = events.send(ConnEvent::Connected);

        let mut last_read = Instant::now();
        let mut check = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                msg = out_rx.recv() => {
                    let Some(msg) = msg else { return Ok(()) };
                    let frame = encode(&msg);
                    if let Err(e) = tx.send(Message::text(frame.clone())).await {
                        queue.0.push_front(frame);
                        return Err(e.into());
                    }
                }
                frame = rx.next() => {
                    last_read = Instant::now();
                    match frame {
                        None => return Ok(()),
                        Some(Err(e)) => return Err(e.into()),
                        Some(Ok(Message::Text(t))) => match serde_json::from_str::<ServerMsg>(&t) {
                            Ok(m) => { let _ = events.send(ConnEvent::Msg(m)); }
                            Err(e) => eprintln!("pf-fleet-agent: ignoring unknown message from dashboard: {e}"),
                        },
                        Some(Ok(Message::Binary(b))) => { let _ = events.send(ConnEvent::Binary(b.to_vec())); }
                        Some(Ok(Message::Ping(p))) => tx.send(Message::Pong(p)).await?,
                        Some(Ok(Message::Close(_))) => return Ok(()),
                        Some(Ok(_)) => {}
                    }
                }
                _ = check.tick() => {
                    if last_read.elapsed() > READ_TIMEOUT {
                        anyhow::bail!("no traffic from the dashboard for {}s", READ_TIMEOUT.as_secs());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_queue_drops_old_logs_before_job_events() {
        let mut q = Queue(VecDeque::new());
        q.push(r#"{"type":"job_finished"}"#.into());
        q.push(r#"{"type":"log","n":1}"#.into());
        for i in 2..QUEUE_MAX {
            q.push(format!(r#"{{"type":"heartbeat","n":{i}}}"#));
        }
        assert_eq!(q.0.len(), QUEUE_MAX);
        q.push(r#"{"type":"job_started"}"#.into());
        assert_eq!(q.0.len(), QUEUE_MAX);
        assert_eq!(q.0.front().unwrap(), r#"{"type":"job_finished"}"#);
        assert!(!q.0.iter().any(|f| f.starts_with(r#"{"type":"log""#)));
    }
}
