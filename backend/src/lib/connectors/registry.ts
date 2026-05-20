// Phase 7: connector registry.
//
// Each connector self-registers on import. The registry is intentionally
// small — it exists so routes don't have to switch on connector id; they
// can look up the connector and ask it to do work. Phase 11 connectors
// (Google Drive, Capital IQ) plug into the same map.

import type { Connector, ConnectorId } from "./types";

const REGISTRY = new Map<ConnectorId, Connector>();

export function registerConnector(connector: Connector): void {
    if (REGISTRY.has(connector.id)) {
        throw new Error(`Connector already registered: ${connector.id}`);
    }
    REGISTRY.set(connector.id, connector);
}

export function getConnector(id: ConnectorId): Connector | null {
    return REGISTRY.get(id) ?? null;
}

export function listConnectors(): Connector[] {
    return Array.from(REGISTRY.values());
}

// Only used by tests.
export function __resetConnectorRegistryForTests(): void {
    REGISTRY.clear();
}
