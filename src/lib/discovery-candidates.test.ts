import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { createGlobalMock } from "../../test/mocks/global";
import type { PeripheralInfo } from "./scanProcessInterface";
import { DiscoveryCandidates } from "./discovery-candidates";

const first = "aa:bb:cc:dd:ee:ff";
const second = "aa:bb:cc:dd:ee:01";

function advertisement(address: string, name?: string, rssi = -60) {
	return {
		address,
		rssi,
		advertisement: { localName: name },
	} as PeripheralInfo;
}

describe("Reviewing new devices", () => {
	const adapter = createGlobalMock({}).Global.adapter;
	const publish = stub().resolves();
	const record = stub().resolves();
	let clock: ReturnType<typeof useFakeTimers>;
	let candidates: DiscoveryCandidates;

	beforeEach(() => {
		clock = useFakeTimers({ now: 10_000 });
		publish.resetHistory();
		record.resetHistory();
		candidates = new DiscoveryCandidates(adapter, publish, 100, 1);
	});

	afterEach(async () => {
		await candidates.dispose();
		clock.restore();
	});

	it("bounds the preview and refreshes a candidate's expiry on another packet", async () => {
		candidates.observe(advertisement(first, "Desk"));
		await clock.tickAsync(75);
		candidates.observe(advertisement(first));
		candidates.observe(advertisement(second, "Other"));
		await clock.tickAsync(25);
		expect(candidates.list()).to.deep.equal([
			{ address: first, name: "Desk" },
		]);
		expect(publish.lastCall.args[0]).to.deep.equal(candidates.list());
		await clock.tickAsync(75);
		expect(candidates.list()).to.be.empty;
		expect(publish.lastCall.args[0]).to.deep.equal([]);
	});

	it("passes the latest advertisement to approval and records a device once", async () => {
		candidates.observe(advertisement(first, "Desk"));
		const latest = advertisement(first, "Desk", -50);
		candidates.observe(latest);

		const pending = candidates.approve(first, record);
		expect(await candidates.approve(first, record)).to.be.false;
		expect(await pending).to.be.true;
		expect(await candidates.approve(first, record)).to.be.true;
		expect(record.calledOnceWithExactly(latest)).to.be.true;
		expect(candidates.list()).to.be.empty;
	});

	it("allows a failed approval to be retried within the discovery lifetime", async () => {
		const packet = advertisement(first);
		candidates.observe(packet);
		const failingRecord = stub().rejects(
			new Error("Controller unavailable"),
		);

		await expect(
			candidates.approve(first, failingRecord),
		).to.be.rejectedWith("Controller unavailable");
		expect(candidates.isPending(first)).to.be.true;
		expect(await candidates.approve(first, record)).to.be.true;
		expect(record.calledOnceWithExactly(packet)).to.be.true;
	});
});
