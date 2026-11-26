import { expect } from "chai";
import type { PeripheralInfo } from "../lib/scanProcessInterface";
import plugin = require("./govee");

function packet(hex: string): PeripheralInfo {
	return {
		advertisement: { manufacturerData: Buffer.from(hex, "hex") },
	} as PeripheralInfo;
}

describe("Govee H5072/H5075 advertisements", () => {
	it("reads the EC88 measurement before a concatenated iBeacon block", () => {
		const peripheral = packet(
			"88ec000341c264004c000215494e54454c4c495f524f434b535f48575075f2ff0c",
		);
		expect(plugin.isHandling(peripheral)).to.be.true;
		const context = plugin.createContext(peripheral)!;
		expect(plugin.getValues(context)).to.deep.equal({
			temperature: 21.3,
			humidity: 44.2,
			battery: 100,
		});
		expect(
			plugin.defineObjects(context)?.states.map(({ id }) => id),
		).to.have.members(["temperature", "humidity", "battery"]);
	});

	it("decodes a stand-alone EC88 packet with a negative temperature", () => {
		expect(plugin.createContext(packet("88ec0080cbc43e27"))).to.deep.equal({
			temperature: -5.2,
			humidity: 16.4,
			battery: 62,
		});
	});

	it("keeps valid battery on error and ignores the iBeacon-only and short packets", () => {
		expect(plugin.createContext(packet("88ec000341c2b200"))).to.deep.equal({
			battery: 50,
		});
		expect(
			plugin.isHandling(
				packet("4c000215494e54454c4c495f524f434b535f48575075f2ff0c"),
			),
		).to.be.false;
		expect(plugin.isHandling(packet("88ec000341c2"))).to.be.false;
		expect(plugin.isHandling(packet("88ec000341c2640000"))).to.be.false;
	});
});
