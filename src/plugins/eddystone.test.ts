import { expect } from "chai";
import type { PeripheralInfo } from "../lib/scanProcessInterface";
import plugin = require("./eddystone");

function beacon(hex: string): PeripheralInfo {
	return {
		advertisement: {
			serviceData: [{ uuid: "feaa", data: Buffer.from(hex, "hex") }],
		},
	} as PeripheralInfo;
}

describe("Eddystone beacons", () => {
	const cases = [
		[
			"00ee00112233445566778899aabbccddeeff0000",
			{
				namespace: "00112233445566778899",
				instance: "aabbccddeeff",
				txPower: -18,
			},
		],
		[
			"10ee036578616d706c650061",
			{ url: "https://example.com/a", txPower: -18 },
		],
		[
			"20000bb8fa800000000a0000007b",
			{
				batteryVoltage: 3000,
				temperature: -5.5,
				advertisementCount: 10,
				uptime: 12.3,
			},
		],
		[
			"2000000080000000000000000000",
			{
				batteryVoltage: null,
				temperature: null,
				advertisementCount: 0,
				uptime: 0,
			},
		],
		[
			"30f00123456789abcdef",
			{ ephemeralId: "0123456789abcdef", txPower: -16 },
		],
	] as const;

	for (const [hex, values] of cases) {
		it(`decodes frame ${hex}`, () => {
			const peripheral = beacon(hex);
			expect(plugin.isHandling(peripheral)).to.be.true;
			const context = plugin.createContext(peripheral)!;
			expect(plugin.getValues(context)).to.deep.equal(values);
			expect(
				plugin.defineObjects(context)!.states.map(({ id }) => id),
			).to.have.members(Object.keys(values));
		});
	}

	it("rejects truncated frames, invalid URL encodings and encrypted telemetry", () => {
		for (const hex of [
			"003300",
			"10ee04ff",
			"20010bb8fa800000000a0000007b",
			"30f00123",
		]) {
			expect(plugin.isHandling(beacon(hex))).to.be.false;
		}
	});
});
