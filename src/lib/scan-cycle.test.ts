import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { ScanCycle } from "./scan-cycle";

describe("Scan cycle", () => {
	let clock: ReturnType<typeof useFakeTimers>;
	beforeEach(() => {
		clock = useFakeTimers();
	});
	afterEach(() => {
		clock.restore();
	});

	it("scans continuously when no interval is configured", async () => {
		const begin = stub().resolves();
		const end = stub().resolves();
		const cycle = new ScanCycle(0, 1000, begin, end, stub());
		await cycle.start();
		await cycle.start();
		await clock.tickAsync(120000);
		expect(begin.callCount).to.equal(1);
		expect(end.callCount).to.equal(0);
		await cycle.stop();
		expect(end.callCount).to.equal(1);
	});

	it("stops after the scan window and starts again at the configured interval", async () => {
		const begin = stub().resolves();
		const end = stub().resolves();
		const cycle = new ScanCycle(10000, 2000, begin, end, stub());
		await cycle.start();
		await clock.tickAsync(1999);
		expect(end.callCount).to.equal(0);
		await clock.tickAsync(1);
		expect(end.callCount).to.equal(1);
		await clock.tickAsync(7999);
		expect(begin.callCount).to.equal(1);
		await clock.tickAsync(1);
		expect(begin.callCount).to.equal(2);
	});

	it("cancels future windows when the driver is turned off", async () => {
		const begin = stub().resolves();
		const cycle = new ScanCycle(
			10000,
			2000,
			begin,
			stub().resolves(),
			stub(),
		);
		await cycle.start();
		await clock.tickAsync(2000);
		await cycle.stop();
		await clock.tickAsync(25000);
		expect(begin.callCount).to.equal(1);
		await cycle.start();
		expect(begin.callCount).to.equal(2);
	});

	it("waits for a pending hardware start before stopping", async () => {
		let completeStart!: () => void;
		const begin = stub().returns(
			new Promise<void>((resolve) => {
				completeStart = resolve;
			}),
		);
		const end = stub().resolves();
		const cycle = new ScanCycle(10000, 2000, begin, end, stub());
		const started = cycle.start();
		await clock.tickAsync(1);
		const stopped = cycle.stop();
		expect(end.callCount).to.equal(0);
		completeStart();
		await Promise.all([started, stopped]);
		await clock.tickAsync(20000);
		expect(begin.callCount).to.equal(1);
		expect(end.callCount).to.equal(1);
	});
});
