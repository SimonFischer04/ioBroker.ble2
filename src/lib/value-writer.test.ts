import { expect } from "chai";
import { VALUE_REFRESH_MS, ValueWriter } from "./value-writer";

describe("lib/value-writer => ValueWriter", () => {
	let now: number;
	let values: Map<string, ioBroker.StateValue>;
	let writes: string[];
	let writer: ValueWriter;

	beforeEach(() => {
		now = 1790000000000;
		values = new Map();
		writes = [];
		writer = new ValueWriter(
			{
				setStateAsync: (id, value) => {
					values.set(id, value);
					writes.push(`set ${id}=${String(value)}`);
					return Promise.resolve({ id });
				},
				setStateChangedAsync: (id, value) => {
					if (values.get(id) === value) {
						return Promise.resolve({ id, notChanged: true });
					}
					values.set(id, value);
					writes.push(`changed ${id}=${String(value)}`);
					return Promise.resolve({ id, notChanged: false });
				},
			},
			() => now,
		);
	});

	it("writes the first value, changes at once and repeats only after the refresh time", async () => {
		await writer.write("ble.0.dev.battery", 100);
		now += 1000;
		await writer.write("ble.0.dev.battery", 100);
		await writer.write("ble.0.dev.battery", 99);
		now += VALUE_REFRESH_MS - 1;
		await writer.write("ble.0.dev.battery", 99);
		expect(writes).to.deep.equal([
			"set ble.0.dev.battery=100",
			"changed ble.0.dev.battery=99",
		]);

		now += 1;
		await writer.write("ble.0.dev.battery", 99);
		expect(writes).to.have.lengthOf(3);
		expect(writes[2]).to.equal("set ble.0.dev.battery=99");
	});
});
