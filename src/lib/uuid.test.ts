import { expect } from "chai";
import { normalizeUuid } from "./uuid";

describe("lib/uuid => normalizeUuid()", () => {
	it("expands 16 bit UUIDs", () => {
		for (const input of ["1f10", "1F10", "0x1f10", " 1f10 "]) {
			expect(normalizeUuid(input), input).to.equal(
				"00001f10-0000-1000-8000-00805f9b34fb",
			);
		}
	});

	it("expands 32 bit UUIDs", () => {
		expect(normalizeUuid("0000fcd2")).to.equal(
			"0000fcd2-0000-1000-8000-00805f9b34fb",
		);
	});

	it("adds the dashes to 128 bit UUIDs without them", () => {
		expect(normalizeUuid("00001f1000001000800000805f9b34fb")).to.equal(
			"00001f10-0000-1000-8000-00805f9b34fb",
		);
	});

	it("writes 128 bit UUIDs in lowercase", () => {
		expect(normalizeUuid("00001F10-0000-1000-8000-00805F9B34FB")).to.equal(
			"00001f10-0000-1000-8000-00805f9b34fb",
		);
	});

	it("rejects everything else", () => {
		for (const input of [
			"",
			"1f1",
			"xyz1",
			"1f10-0000",
			undefined,
			0x1f10,
		]) {
			expect(normalizeUuid(input), String(input)).to.be.undefined;
		}
	});
});
