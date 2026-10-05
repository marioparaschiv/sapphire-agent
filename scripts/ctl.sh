#!/bin/sh
set -eu

# The service's environment (systemd/sapphire-agent.service), unless the caller has its own, as a command's tab does.
export HERDR_PLUGIN_STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/sapphire-agent}"
export HERDR_PLUGIN_CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/sapphire-agent}"
export HERDR_BIN_PATH="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
export HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

state_dir="$HERDR_PLUGIN_STATE_DIR"
cli="$(dirname "$0")/../src/ctl.ts"

case "${1:-}" in
	pause)
		touch "$state_dir/paused" "$state_dir/wake"
		echo "dispatching paused; runs in flight are still watched"
		;;
	resume)
		rm -f "$state_dir/paused"
		touch "$state_dir/wake"
		echo "dispatching resumed"
		;;
	status)
		if [ -e "$state_dir/paused" ]; then echo "dispatching: paused"; else echo "dispatching: active"; fi
		echo "service: $(systemctl --user is-active sapphire-agent.service)"
		node "$cli" status
		;;
	start | stop | send | follow-up | session | reply | done)
		exec node "$cli" "$@"
		;;
	*)
		echo "usage: ctl.sh pause|resume|status|start|stop|send|follow-up|session|reply|done" >&2
		exit 2
		;;
esac
