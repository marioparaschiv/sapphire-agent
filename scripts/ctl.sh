#!/bin/sh
set -eu

state_dir="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/herdr-linear}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

case "${1:-}" in
	pause)
		touch "$state_dir/paused"
		echo "dispatching paused; runs in flight are still watched"
		;;
	resume)
		rm -f "$state_dir/paused"
		echo "dispatching resumed"
		;;
	status)
		if [ -e "$state_dir/paused" ]; then echo "dispatching: paused"; else echo "dispatching: active"; fi
		echo "service: $(systemctl --user is-active herdr-linear.service)"
		HERDR_PLUGIN_STATE_DIR="$state_dir" node "$(dirname "$0")/../src/status.ts"
		;;
	*)
		echo "usage: ctl.sh pause|resume|status" >&2
		exit 2
		;;
esac
