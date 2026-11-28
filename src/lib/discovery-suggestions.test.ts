import { expect } from "chai";
import { DiscoverySuggestions } from "./discovery-suggestions";

describe("discovery suggestions", () => {
	const address = "aa:bb:cc:dd:ee:ff";

	it("needs three separate observations and only keeps recent sightings", () => {
		const suggestions = new DiscoverySuggestions();
		for (const timestamp of [0, 25, 100, 10_000]) {
			suggestions.observe(address, "Thermometer", timestamp);
		}
		expect(suggestions.list(19_999)).to.deep.equal([]);
		suggestions.observe(address, undefined, 20_000);
		expect(suggestions.list(20_000)).to.deep.equal([
			{ address, name: "Thermometer", sightings: 3 },
		]);
		expect(suggestions.list(620_001)).to.deep.equal([]);
	});

	it("removes devices as they are recorded and bounds retained addresses", () => {
		const suggestions = new DiscoverySuggestions();
		for (const timestamp of [0, 10_000, 20_000]) {
			suggestions.observe(address, undefined, timestamp);
		}
		expect(suggestions.list(20_000)).to.have.length(1);
		suggestions.remove(address);
		expect(suggestions.list(20_000)).to.deep.equal([]);
		for (const timestamp of [30_000, 40_000, 50_000]) {
			suggestions.observe(address, undefined, timestamp);
		}
		for (let i = 0; i < 256; i++) {
			const suffix = i.toString(16).padStart(2, "0");
			suggestions.observe(
				`11:22:33:44:55:${suffix}`,
				undefined,
				51_000 + i,
			);
		}
		expect(suggestions.list(52_000)).to.deep.equal([]);
	});
});
