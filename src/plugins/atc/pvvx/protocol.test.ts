import { expect } from "chai";
import {
	clockDeviation,
	encodeConfigRequest,
	encodeTimeRequest,
	formatVersion,
	localClockValue,
	parseConfigResponse,
	parseTimeResponse,
} from "./protocol";

const hex = (value: string): Buffer =>
	Buffer.from(value.replace(/ /g, ""), "hex");

describe("plugins/atc/pvvx/protocol", () => {
	describe("localClockValue() and encodeTimeRequest(), docs/pvvx-protocol.md 7.1", () => {
		// Offsets as Date.prototype.getTimezoneOffset() returns them for Europe/Vienna
		const vectors: [string, number, number, number, string][] = [
			[
				"2026-01-15T12:00:00Z",
				1768478400,
				-60,
				1768482000,
				"23 d0 e4 68 69",
			],
			[
				"2026-07-01T10:00:00Z",
				1782900000,
				-120,
				1782907200,
				"23 40 01 45 6a",
			],
			[
				"2026-10-25T00:59:59Z",
				1792889999,
				-120,
				1792897199,
				"23 af 70 dd 6a",
			],
			[
				"2026-10-25T01:00:00Z",
				1792890000,
				-60,
				1792893600,
				"23 a0 62 dd 6a",
			],
			[
				"2027-03-28T00:59:59Z",
				1806195599,
				-60,
				1806199199,
				"23 9f 69 a8 6b",
			],
			[
				"2027-03-28T01:00:00Z",
				1806195600,
				-120,
				1806202800,
				"23 b0 77 a8 6b",
			],
		];
		for (const [iso, unix, offset, value, packet] of vectors) {
			it(`${iso} -> ${value}`, () => {
				expect(Date.parse(iso)).to.equal(unix * 1000);
				// Milliseconds are cut off
				expect(localClockValue(unix * 1000 + 999, offset)).to.equal(
					value,
				);
				expect(encodeTimeRequest(value).toString("hex")).to.equal(
					packet.replace(/ /g, ""),
				);
			});
		}

		it("reads the clock with a single byte", () => {
			expect(encodeTimeRequest().toString("hex")).to.equal("23");
		});
	});

	describe("parseTimeResponse(), 7.2", () => {
		it("reads the clock", () => {
			expect(parseTimeResponse(hex("23 d0 e4 68 69"))).to.deep.equal({
				clock: 1768482000,
			});
		});

		it("reads when the clock was set last", () => {
			expect(
				parseTimeResponse(hex("23 d0 e4 68 69 40 01 45 6a")),
			).to.deep.equal({ clock: 1768482000, lastSet: 1782907200 });
		});

		it("rejects an answer that is too short", () => {
			expect(parseTimeResponse(hex("23 d0 e4 68"))).to.equal(undefined);
		});

		it("rejects other notifications", () => {
			expect(parseTimeResponse(hex("33 0b 0c 2e 09 f4 13 64"))).to.equal(
				undefined,
			);
		});
	});

	describe("parseConfigResponse(), 7.3", () => {
		it("version 5.9 with hardware ID 0", () => {
			expect(
				parseConfigResponse(hex("55 59 00 00 00 00 0a 04 8b 00 37 00")),
			).to.deep.equal({ version: 0x59, hardwareId: 0 });
		});

		it("old firmware with the extended hardware ID", () => {
			expect(
				parseConfigResponse(hex("55 40 00 00 00 00 00 00 00 00 83 0f")),
			).to.deep.equal({ version: 0x40, hardwareId: 19 });
		});

		it("rejects an answer that is too short", () => {
			expect(parseConfigResponse(hex("55 59"))).to.equal(undefined);
		});

		it("rejects other notifications", () => {
			expect(
				parseConfigResponse(hex("33 59 00 00 00 00 0a 04 8b 00 37 00")),
			).to.equal(undefined);
		});

		it("10 bytes carry no hardware ID", () => {
			expect(
				parseConfigResponse(hex("55 59 00 00 00 00 0a 04 8b 00")),
			).to.deep.equal({ version: 0x59 });
		});

		it("masks the hardware ID of firmware before 0x36", () => {
			expect(
				parseConfigResponse(hex("55 30 00 00 00 00 00 00 00 00 00 ff")),
			).to.deep.equal({ version: 0x30, hardwareId: 7 });
		});
	});

	it("formatVersion()", () => {
		expect(formatVersion(0x59)).to.equal("5.9");
		expect(formatVersion(0x4a)).to.equal("4.10");
	});

	it("encodeConfigRequest() is one byte", () => {
		expect(encodeConfigRequest().toString("hex")).to.equal("55");
	});

	it("clockDeviation()", () => {
		expect(clockDeviation(1792897199, 1792893600)).to.equal(3599);
		expect(clockDeviation(1792893600, 1792897199)).to.equal(-3599);
		// Across the overflow of the unsigned 32 bit counter
		expect(clockDeviation(5, 0xfffffffb)).to.equal(10);
	});
});
