import { expect } from "chai";
import type { PeripheralInfo } from "../lib/scanProcessInterface";
import plugin = require("./mi-scale");

describe("Xiaomi Mi Scale advertisements", () => {
	const cases = [
		["181d", "20b036e3070703121633", 70, true],
		["181d", "21e803e3070703121633", 4.536, true],
		["181d", "30e803e3070703121633", 5, true],
		["181b", "0204e30707031216330000f81b", 35.8, false],
		["181b", "0224e30707031216330000f81b", 35.8, true],
		["181b", "02a4e30707031216330000f81b", 0, false],
	] as const;

	for (const [uuid, hex, weight, stabilized] of cases) {
		it(`decodes ${uuid} frame ${hex}`, () => {
			const peripheral = {
				advertisement: {
					serviceData: [{ uuid, data: Buffer.from(hex, "hex") }],
				},
			} as PeripheralInfo;
			expect(plugin.isHandling(peripheral)).to.be.true;
			const context = plugin.createContext(peripheral)!;
			expect(plugin.getValues(context)).to.deep.equal({
				weight,
				stabilized,
			});
			expect(
				plugin.defineObjects(context)!.states.map(({ id }) => id),
			).to.deep.equal(["weight", "stabilized"]);
		});
	}

	it("ignores truncated scale service data", () => {
		const peripheral = {
			advertisement: {
				serviceData: [{ uuid: "181b", data: Buffer.alloc(12) }],
			},
		} as PeripheralInfo;
		expect(plugin.isHandling(peripheral)).to.be.false;
	});
});
