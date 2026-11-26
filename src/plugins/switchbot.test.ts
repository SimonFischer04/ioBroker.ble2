import { expect } from "chai";
import type { PeripheralInfo } from "../lib/scanProcessInterface";
import plugin = require("./switchbot");

function peripheral(
	uuid: string,
	service: string,
	manufacturer?: string,
): PeripheralInfo {
	return {
		advertisement: {
			serviceData: [{ uuid, data: Buffer.from(service, "hex") }],
			manufacturerData: manufacturer
				? Buffer.from(manufacturer, "hex")
				: undefined,
		},
	} as PeripheralInfo;
}

describe("SwitchBot Meter advertisements", () => {
	it("reads the original Meter service data and masks display flags", () => {
		const p = peripheral("0d00", "5400e40005af");
		expect(plugin.isHandling(p)).to.be.true;
		const context = plugin.createContext(p)!;
		expect(plugin.getValues(context)).to.deep.equal({
			battery: 100,
			temperature: -5,
			humidity: 47,
		});
		expect(
			plugin.defineObjects(context)!.states.map(({ id }) => id),
		).to.have.members(["battery", "temperature", "humidity"]);
	});

	it("pairs Meter Plus service battery data with manufacturer measurements", () => {
		const p = peripheral("fd3d", "690063", "69091122334455660000079638");
		expect(plugin.createContext(p)).to.deep.equal({
			battery: 99,
			temperature: 22.7,
			humidity: 56,
		});
	});

	it("ignores non-meter models and incomplete service headers", () => {
		expect(plugin.isHandling(peripheral("fd3d", "630064048b44"))).to.be
			.false;
		expect(plugin.isHandling(peripheral("fd3d", "54"))).to.be.false;
	});
});
