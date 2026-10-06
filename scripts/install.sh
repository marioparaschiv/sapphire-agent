#!/bin/sh
# Links the plugin, puts `sapphire` on PATH and installs both systemd user units. Safe to run again.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
units="$HOME/.config/systemd/user"

"$HOME/.local/bin/herdr" plugin link "$root" >/dev/null
ln -sf "$root/scripts/ctl.sh" "$HOME/.local/bin/sapphire"
mkdir -p "$units"
cp "$root/systemd/herdr-server.service" "$root/systemd/sapphire-agent.service" "$units/"
systemctl --user daemon-reload
systemctl --user enable herdr-server.service sapphire-agent.service
