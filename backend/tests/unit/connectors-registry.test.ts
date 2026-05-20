import { describe, it, expect, beforeEach } from "vitest";
import {
    registerConnector,
    getConnector,
    listConnectors,
    __resetConnectorRegistryForTests,
} from "../../src/lib/connectors/registry";

describe("connector registry", () => {
    beforeEach(() => __resetConnectorRegistryForTests());

    it("registers and retrieves a connector by id", () => {
        registerConnector({ id: "edgar", displayName: "SEC EDGAR" });
        expect(getConnector("edgar")?.displayName).toBe("SEC EDGAR");
        expect(listConnectors().length).toBe(1);
    });

    it("returns null for an unknown connector id", () => {
        expect(getConnector("does-not-exist")).toBeNull();
    });

    it("throws on duplicate registration", () => {
        registerConnector({ id: "edgar", displayName: "SEC EDGAR" });
        expect(() =>
            registerConnector({ id: "edgar", displayName: "Other" }),
        ).toThrow(/already registered/);
    });
});
