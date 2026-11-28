import { expect } from "chai";
import type { PeripheralInfo } from "../../lib/scanProcessInterface";
import plugin = require(".");

function packet(hex: string): PeripheralInfo {
	return {
		address: "aa:bb:cc:dd:ee:ff",
		advertisement: { manufacturerData: Buffer.from(hex, "hex") },
	} as PeripheralInfo;
}

describe("MagicSwitchBot advertisements", () => {
	it("reads the battery and whether the device has a password configured", () => {
		const advertisement = packet("0205aabbccddeeff64010000");
		expect(plugin.isHandling(advertisement)).to.be.true;
		expect(
			plugin.getValues(plugin.createContext(advertisement)!),
		).to.deep.equal({
			battery: 100,
			passwordEnabled: true,
		});
		expect(
			plugin.createContext(packet("0205ffeeddccbbaa00000000")),
		).to.deep.equal({
			battery: 0,
			passwordEnabled: false,
		});
	});

	it("ignores payloads from other companies or addresses and invalid values", () => {
		for (const hex of [
			"0305aabbccddeeff64010000",
			"0205aabbccddeeee64010000",
			"0205aabbccddeeff65010000",
			"0205aabbccddeeff64020000",
			"0205aabbccddeeff640100",
		]) {
			expect(plugin.isHandling(packet(hex))).to.be.false;
		}
	});
});
