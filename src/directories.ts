import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the config and the state are unless SAPPHIRE_AGENT_CONFIG_DIR and SAPPHIRE_AGENT_STATE_DIR say otherwise. Only
// node built-ins, so the agent hook can import it and still start in milliseconds.
export const defaultConfigDirectory = join(homedir(), '.config/sapphire-agent');

export const defaultStateDirectory = join(homedir(), '.local/state/sapphire-agent');

// Where command threads run: a checkout of the comment's repo at `<directory>/<repo>`, or the directory itself for a
// repo the service has no clone of.
export const commandsDirectory = (stateDirectory: string) => join(stateDirectory, 'commands');

export const ctlPath = fileURLToPath(new URL('../scripts/ctl.sh', import.meta.url));

const handoffPrefix = 'sapphire-agent-handoff-';

// The doc a run's session, or one of its subagents, hands its work over in.
export const handoffPath = (identifier: string, sessionOrAgentId: string) => join(tmpdir(), `${handoffPrefix}${identifier}-${sessionOrAgentId}.md`);

export const isHandoffPath = (path: string) => dirname(path) === tmpdir() && basename(path).startsWith(handoffPrefix) && path.endsWith('.md');
