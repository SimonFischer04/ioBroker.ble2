import { expect } from "chai";
import { createGatewayRegistry } from "../connections/test-fakes";
import { toObjectId } from "./gateway-registry";

describe("gateways/gateway-registry => GatewayRegistry", () => {
	const description = {
		id: "esphome.0:proxy-og",
		type: "remote" as const,
		sender: "esphome.0",
	};

	it("keeps the features of the last announcement", () => {
		const registry = createGatewayRegistry();
		expect(registry.get("esphome.0:proxy-og")).to.equal(undefined);

		registry.announce(description, {
			connect: true,
			features: ["writeSequence"],
		});
		expect(registry.get(description.id)?.features).to.deep.equal([
			"writeSequence",
		]);

		registry.announce(description, { connect: true });
		expect(registry.get(description.id)?.features).to.deep.equal([]);
		registry.dispose();
	});

	it("a gateway that cannot connect has no features", () => {
		const registry = createGatewayRegistry();
		registry.announce(description, {
			connect: false,
			features: ["writeSequence"],
		});
		expect(registry.get(description.id)?.features).to.deep.equal([]);
		registry.dispose();
	});

	it("gateways that never announced themselves have no features", () => {
		const registry = createGatewayRegistry();
		registry.recordAdvertisements(
			{ id: "esphome.0:proxy-eg", type: "remote", sender: "esphome.0" },
			1,
		);
		expect(registry.list().map((g) => g.features)).to.deep.equal([[]]);
		registry.dispose();
	});

	it("gives every gateway ID its own object ID", () => {
		expect(toObjectId("esphome.0:proxy-og")).to.equal("esphome_0_proxy-og");
		expect(toObjectId("server:192.168.1.20:9000")).to.equal(
			"server_192_168_1_20_9000",
		);
		expect(toObjectId("local")).to.equal("local");

		const ids = [
			"esphome.0:proxy.garage",
			"esphome.0:proxy_garage",
			"esphome.0:proxy__garage",
			"esphome.0:proxy garage",
		].map(toObjectId);
		expect(new Set(ids).size).to.equal(ids.length);
		for (const id of ids) {
			expect(id).to.match(/^[A-Za-z0-9_-]+$/);
		}
	});
});
