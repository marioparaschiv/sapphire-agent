#!/bin/sh
# Links the plugin and installs both systemd user units. Safe to run again.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
units="$HOME/.config/systemd/user"

"$HOME/.local/bin/herdr" plugin link "$root" >/dev/null
mkdir -p "$units"
cp "$root/systemd/herdr-server.service" "$root/systemd/sapphire-agent.service" "$units/"
systemctl --user daemon-reload
systemctl --user enable herdr-server.service sapphire-agent.service
