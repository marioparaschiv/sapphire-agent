#!/bin/sh
set -eu

# So `systemctl --user` reaches the user's manager from any shell.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# Installed on PATH as `sapphire`, a symlink to this file.
src="$(dirname "$(readlink -f "$0")")/../src"
cli="$src/ctl.ts"

# `sapphire ctl <action>` is `sapphire <action>`.
if [ "${1:-}" = ctl ]; then
	shift
fi

case "${1:-}" in
	status)
		echo "service: $(systemctl --user is-active sapphire-agent.service)"
		exec node "$cli" "$@"
		;;
	hook)
		shift
		exec node "$src/agent-hook.ts" "$@"
		;;
	*)
		exec node "$cli" "$@"
		;;
esac
