import type { ProjectConnector, ConnectorFactory, ConnectorConfig, StatusGroup } from './types.js';
import { fetchListTasks, addTaskComment, normalizeListIds, type ClickUpConfig } from './clickupClient.js';

class ClickUpConnector implements ProjectConnector {
	readonly type = 'clickup';
	private config: ClickUpConfig | null;

	constructor(rawConfig: ConnectorConfig) {
		const apiToken = rawConfig.apiToken as string | undefined;
		const listIds = normalizeListIds(rawConfig as Record<string, unknown>);
		this.config = (apiToken && listIds.length > 0) ? { apiToken, listIds } : null;
	}

	isConfigured(): boolean {
		return this.config !== null;
	}

	async fetchTickets(): Promise<StatusGroup[]> {
		if (!this.config) return [];
		// Native ClickUpStatusGroup has same shape as StatusGroup.
		return fetchListTasks(this.config) as unknown as StatusGroup[];
	}

	async addComment(ticketId: string, body: string): Promise<void> {
		if (!this.config) throw new Error('ClickUp connector is not configured');
		await addTaskComment(this.config, ticketId, body);
	}
}

export const clickupConnectorFactory: ConnectorFactory = {
	type: 'clickup',
	create(config) {
		return new ClickUpConnector(config);
	},
};
