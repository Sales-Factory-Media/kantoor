import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PEERS_BROKER_URL } from './constants.js';

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const MCP_CONFIG_PATH = path.join(SETTINGS_DIR, 'peers-mcp-config.json');

export interface ConferenceState {
	id: string;
	topic: string;
	agent1Id: string;
	agent2Id: string;
	agent1SessionId: string;
	agent2SessionId: string;
	startedAt: string;
	status: 'launching' | 'active' | 'ended';
}

const activeConferences = new Map<string, ConferenceState>();

export function ensureMcpConfig(): string {
	if (!fs.existsSync(SETTINGS_DIR)) {
		fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	}
	const vendorPath = path.resolve(__dirname, '..', 'vendor', 'claude-peers-mcp');
	const config = {
		mcpServers: {
			peers: {
				command: 'bun',
				args: ['run', path.join(vendorPath, 'server.ts')],
				env: { PEERS_BROKER_URL },
			},
		},
	};
	fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
	return MCP_CONFIG_PATH;
}

export function getMcpConfigPath(): string {
	return MCP_CONFIG_PATH;
}

export function startConference(state: ConferenceState): void {
	activeConferences.set(state.id, state);
}

export function endConference(id: string): ConferenceState | undefined {
	const conf = activeConferences.get(id);
	if (conf) {
		conf.status = 'ended';
		activeConferences.delete(id);
	}
	return conf;
}

export function getActiveConferences(): Map<string, ConferenceState> {
	return activeConferences;
}
