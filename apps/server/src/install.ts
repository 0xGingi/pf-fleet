/**
 * The script behind the dashboard's one-line install command:
 *   curl -fsSL <PUBLIC_URL>/install.sh | sh -s -- --server <PUBLIC_URL> --token <nodeId>.<secret>
 * Installs uv if missing, the agent binary, its config, and a systemd unit (user unit with
 * lingering for normal users, system unit for root). Safe to run again to upgrade.
 */
export const INSTALL_SH = String.raw`#!/bin/sh
set -eu

SERVER="" TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || { echo "usage: install.sh --server URL --token TOKEN" >&2; exit 2; }

say() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "the agent runs on Linux only"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac
command -v curl >/dev/null || fail "curl is required"

if [ "$(id -u)" = 0 ]; then
  BIN_DIR=/usr/local/bin
  CONF_DIR=/etc/pf-fleet
else
  BIN_DIR="$HOME/.local/bin"
  CONF_DIR="$HOME/.config/pf-fleet"
fi
mkdir -p "$BIN_DIR" "$CONF_DIR"

if ! command -v uvx >/dev/null && [ ! -x "$HOME/.local/bin/uvx" ]; then
  say "installing uv (runs pirateface)"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
fi

say "downloading pf-fleet-agent ($ARCH)"
TMP="$BIN_DIR/.pf-fleet-agent.$$"
curl -fsSL "$SERVER/agent/download/$ARCH" -o "$TMP" || { rm -f "$TMP"; fail "download failed from $SERVER"; }
chmod 755 "$TMP"
"$TMP" version >/dev/null || { rm -f "$TMP"; fail "the downloaded agent does not run on this machine"; }
mv -f "$TMP" "$BIN_DIR/pf-fleet-agent"

say "writing $CONF_DIR/agent.json"
umask 077
printf '{"server":"%s","token":"%s"}\n' "$SERVER" "$TOKEN" > "$CONF_DIR/agent.json"
umask 022

UNIT="[Unit]
Description=pf-fleet agent (Pirate Face workers)
Wants=network-online.target
After=network-online.target

[Service]
Environment=HOME=$HOME
ExecStart=$BIN_DIR/pf-fleet-agent run --config $CONF_DIR
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=40

[Install]
WantedBy=__TARGET__"

if ! command -v systemctl >/dev/null; then
  say "no systemd here; start it yourself, e.g.:"
  echo "  nohup $BIN_DIR/pf-fleet-agent run --config $CONF_DIR >>$CONF_DIR/agent.log 2>&1 &"
  exit 0
fi

# A running agent is asked to restart itself (SIGHUP) instead of being killed: it finishes
# its lanes' current jobs, then re-execs into the new binary, so a reinstall loses no work.
start_or_reload() { # $1: "" for the system manager, "--user" for the user manager
  systemctl $1 daemon-reload
  systemctl $1 enable pf-fleet-agent >/dev/null 2>&1
  if systemctl $1 is-active --quiet pf-fleet-agent; then
    systemctl $1 kill -s HUP --kill-whom=main pf-fleet-agent
    say "the running agent restarts into the new one after its lanes finish their current jobs"
  else
    systemctl $1 restart pf-fleet-agent
  fi
}

if [ "$(id -u)" = 0 ]; then
  printf '%s\n' "$UNIT" | sed 's/__TARGET__/multi-user.target/' > /etc/systemd/system/pf-fleet-agent.service
  start_or_reload ""
  say "status: systemctl status pf-fleet-agent / journalctl -u pf-fleet-agent -f"
else
  mkdir -p "$HOME/.config/systemd/user"
  printf '%s\n' "$UNIT" | sed 's/__TARGET__/default.target/' > "$HOME/.config/systemd/user/pf-fleet-agent.service"
  loginctl enable-linger "$(id -un)" 2>/dev/null || say "could not enable lingering; the agent stops when you log out (ask an admin: loginctl enable-linger $(id -un))"
  start_or_reload --user
  say "status: systemctl --user status pf-fleet-agent / journalctl --user -u pf-fleet-agent -f"
fi
say "done; the node shows up in the dashboard within a few seconds"
`;

export function installCommand(publicUrl: string, token: string): string {
  return `curl -fsSL ${publicUrl}/install.sh | sh -s -- --server ${publicUrl} --token ${token}`;
}
