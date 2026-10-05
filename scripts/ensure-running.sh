#!/bin/sh
# herdr runs startup hooks once and does not supervise them; systemd keeps the dispatcher alive.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
exec systemctl --user start sapphire-agent.service
