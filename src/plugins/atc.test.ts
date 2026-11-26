import { expect } from "chai";
import type { PeripheralInfo } from "../lib/scanProcessInterface";
import plugin = require("./atc");

function packet(hex: string, address = "a4:c1:38:12:34:56"): PeripheralInfo {
	return {
		address,
		advertisement: {
			serviceData: [{ uuid: "181a", data: Buffer.from(hex, "hex") }],
		},
	} as PeripheralInfo;
}

describe("ATC1441 and PVVX custom advertisements", () => {
	it("reads a signed ATC1441 temperature and the big-endian battery voltage", () => {
		const peripheral = packet("a4c138123456ffe73e640bc238");
		expect(plugin.isHandling(peripheral)).to.be.true;
		expect(plugin.createContext(peripheral)).to.deep.equal({
			temperature: -2.5,
			humidity: 62,
			battery: 100,
			batteryVoltage: 3.01,
		});
	});

	it("reads higher-resolution PVVX data and the little-endian battery voltage", () => {
		const reading = plugin.createContext(
			packet("56341238c1a4290aca16a90b582b01"),
		)!;
		expect(reading).to.deep.equal({
			temperature: 26.01,
			humidity: 58.34,
			battery: 88,
			batteryVoltage: 2.985,
		});
		expect(
			plugin.defineObjects(reading)?.states.map(({ id }) => id),
		).to.have.members([
			"temperature",
			"humidity",
			"battery",
			"batteryVoltage",
		]);
	});

	it("leaves unrelated and truncated Environmental Sensing frames to the default decoder", () => {
		expect(
			plugin.isHandling(
				packet("a4c138123456ffe73e640bc238", "aa:bb:cc:dd:ee:ff"),
			),
		).to.be.false;
		expect(plugin.isHandling(packet("a4c138123456ffe73e640bc2"))).to.be
			.false;
		expect(plugin.isHandling(packet("a4c138123456ffe7ff640bc238"))).to.be
			.false;
	});
});
