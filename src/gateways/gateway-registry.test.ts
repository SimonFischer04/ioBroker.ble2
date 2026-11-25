import { expect } from "chai";
import { createGatewayRegistry } from "../connections/test-fakes";

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
});
