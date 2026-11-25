import { expect } from "chai";
import {
	checkPreconditions,
	MAX_BATTERY_AGE_MS,
	type PreconditionInput,
} from "./ota-checks";
import { PvvxUpdateError } from "./update-error";

const NOW = 1_800_000_000_000;
const GOOD: PreconditionInput = {
	address: "a4:c1:38:12:34:56",
	now: NOW,
	battery: { val: 100, ts: NOW - 1000 },
	bestGateway: { gatewayId: "esphome.0:proxy-og", rssi: -60 },
};

function codeOf(input: Partial<PreconditionInput>): string | undefined {
	try {
		checkPreconditions({ ...GOOD, ...input });
	} catch (e) {
		expect(e).to.be.instanceOf(PvvxUpdateError);
		return (e as PvvxUpdateError).code;
	}
	return undefined;
}

describe("drivers/pvvx/ota-checks => checkPreconditions()", () => {
	it("accepts a device in good shape", () => {
		expect(codeOf({})).to.equal(undefined);
	});

	it("NO_GATEWAY without a gateway that can update", () => {
		expect(codeOf({ bestGateway: undefined })).to.equal("NO_GATEWAY");
	});

	it("WEAK_SIGNAL below -80 dBm, -80 is enough", () => {
		expect(
			codeOf({ bestGateway: { gatewayId: "esphome.0:x", rssi: -81 } }),
		).to.equal("WEAK_SIGNAL");
		expect(
			codeOf({ bestGateway: { gatewayId: "esphome.0:x", rssi: -80 } }),
		).to.equal(undefined);
	});

	it("BATTERY_UNKNOWN without a current number", () => {
		expect(codeOf({ battery: undefined })).to.equal("BATTERY_UNKNOWN");
		expect(codeOf({ battery: null })).to.equal("BATTERY_UNKNOWN");
		expect(codeOf({ battery: { val: "100", ts: NOW } })).to.equal(
			"BATTERY_UNKNOWN",
		);
		expect(
			codeOf({ battery: { val: 100, ts: NOW - MAX_BATTERY_AGE_MS - 1 } }),
		).to.equal("BATTERY_UNKNOWN");
		expect(
			codeOf({ battery: { val: 100, ts: NOW - MAX_BATTERY_AGE_MS } }),
		).to.equal(undefined);
	});

	it("BATTERY_LOW below 40 %, 40 % is enough", () => {
		expect(codeOf({ battery: { val: 39, ts: NOW } })).to.equal(
			"BATTERY_LOW",
		);
		expect(codeOf({ battery: { val: 40, ts: NOW } })).to.equal(undefined);
	});

	it("checks the gateway before the battery", () => {
		expect(codeOf({ bestGateway: undefined, battery: undefined })).to.equal(
			"NO_GATEWAY",
		);
	});
});
