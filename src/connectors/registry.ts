import type { Building } from '../db/schema.js';
import type { ProjectConnector, ConnectorFactory } from './types.js';
import { clickupConnectorFactory } from './clickup.js';
import { githubConnectorFactory } from './github.js';

const factories = new Map<string, ConnectorFactory>([
	[clickupConnectorFactory.type, clickupConnectorFactory],
	[githubConnectorFactory.type, githubConnectorFactory],
]);

/**
 * Build a connector for a building from its connector_type + connector_config.
 * Returns null if the building's connector_type is unknown — the caller
 * should treat that as "no connector" (no polling, no dispatch).
 */
export function connectorForBuilding(building: Building): ProjectConnector | null {
	const factory = factories.get(building.connectorType);
	if (!factory) {
		console.warn(`[connectors] Unknown connector type "${building.connectorType}" for building "${building.slug}"`);
		return null;
	}
	return factory.create((building.connectorConfig ?? {}) as Record<string, unknown>);
}
