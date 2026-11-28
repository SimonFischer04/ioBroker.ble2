import { expect } from "chai";
import { parseDeviceList } from "./device-list";

describe("lib/device-list => parseDeviceList()", () => {
	it("accepts commas, semicolons, spaces and line breaks in any case", () => {
		expect(
			parseDeviceList(
				"A4:C1:38:12:34:56, a4:c1:38:65:43:21;a4:c1:38:00:00:01\na4:c1:38:00:00:02  a4:c1:38:00:00:03",
			),
		).to.deep.equal({
			addresses: [
				"a4:c1:38:12:34:56",
				"a4:c1:38:65:43:21",
				"a4:c1:38:00:00:01",
				"a4:c1:38:00:00:02",
				"a4:c1:38:00:00:03",
			],
			invalid: [],
		});
	});

	it("accepts dashes as separators of the address", () => {
		expect(parseDeviceList("A4-C1-38-12-34-56").addresses).to.deep.equal([
			"a4:c1:38:12:34:56",
		]);
	});

	it("removes duplicates and keeps the order of the first mention", () => {
		expect(
			parseDeviceList(
				"a4:c1:38:65:43:21, a4:c1:38:12:34:56, A4:C1:38:65:43:21",
			).addresses,
		).to.deep.equal(["a4:c1:38:65:43:21", "a4:c1:38:12:34:56"]);
	});

	it("returns invalid entries separately", () => {
		expect(parseDeviceList("a4:c1:38:12:34:56, not-a-mac")).to.deep.equal({
			addresses: ["a4:c1:38:12:34:56"],
			invalid: ["not-a-mac"],
		});
	});

	it("an empty or missing setting is an empty list", () => {
		const empty = { addresses: [], invalid: [] };
		expect(parseDeviceList(undefined)).to.deep.equal(empty);
		expect(parseDeviceList("")).to.deep.equal(empty);
		expect(parseDeviceList(" , ")).to.deep.equal(empty);
	});
});
