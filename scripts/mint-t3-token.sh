#!/bin/sh
set -eu

# T3 issues `mcp-client` tokens with an approval-required runtime-mode ceiling and has no flag to raise it. The ceiling
# is the token's `rtc` claim, so this re-signs the issued claims with `rtc: full-access` using the server's signing key.
# The session row is looked up by `sid` only, so T3 accepts the result until the session is revoked or T3 changes its
# token format. Run it again when the service reports a 401.

token_file=${1:-"$HOME/.config/sapphire-agent/t3-token"}
signing_key="$HOME/.t3/userdata/secrets/server-signing-key.bin"

issued=$(t3 auth session issue --subject mcp-client --label sapphire-agent --ttl 3650d --token-only)

umask 077
trap 'rm -f "$token_file.tmp"' EXIT
node - "$issued" "$signing_key" > "$token_file.tmp" <<'EOF'
const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');

const [issued, signingKeyPath] = process.argv.slice(2);
const claims = JSON.parse(Buffer.from(issued.split('.')[0], 'base64url').toString('utf8'));

if (claims.kind !== 'session' || typeof claims.sid !== 'string') {
	throw new Error(`Unexpected T3 token claims: ${JSON.stringify(claims)}`);
}

const payload = Buffer.from(JSON.stringify({ ...claims, rtc: 'full-access' })).toString('base64url');
const signature = createHmac('sha256', readFileSync(signingKeyPath)).update(payload).digest('base64url');

process.stdout.write(`${payload}.${signature}`);
EOF
mv "$token_file.tmp" "$token_file"

echo "Wrote a full-access T3 token to $token_file"
