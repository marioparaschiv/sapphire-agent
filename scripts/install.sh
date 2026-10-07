#!/bin/sh
# Puts `sapphire` on PATH and installs the systemd user unit. Safe to run again.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
units="$HOME/.config/systemd/user"

ln -sf "$root/scripts/ctl.sh" "$HOME/.local/bin/sapphire"
mkdir -p "$units"
cp "$root/systemd/sapphire-agent.service" "$units/"
systemctl --user daemon-reload
systemctl --user enable sapphire-agent.service
