import { expect } from "chai";
import { stub, useFakeTimers } from "sinon";
import { createGlobalMock } from "../../test/mocks/global";
import { ScannerWatchdog } from "./scanner-watchdog";

describe("Scanner watchdog", () => {
	let clock: ReturnType<typeof useFakeTimers>;
	const adapter = createGlobalMock({}).Global.adapter;

	beforeEach(() => {
		clock = useFakeTimers();
	});
	afterEach(() => {
		clock.restore();
	});

	it("fires once after being idle, including when no packet ever arrives", () => {
		const restart = stub();
		new ScannerWatchdog(adapter, 60_000, restart).activity();
		clock.tick(59_999);
		expect(restart.callCount).to.equal(0);
		clock.tick(120_001);
		expect(restart.callCount).to.equal(1);
	});

	it("waits a full interval after each advertisement", () => {
		const restart = stub();
		const watchdog = new ScannerWatchdog(adapter, 60_000, restart);
		watchdog.activity();
		clock.tick(50_000);
		watchdog.activity();
		clock.tick(59_999);
		expect(restart.callCount).to.equal(0);
		clock.tick(1);
		expect(restart.callCount).to.equal(1);
	});

	it("disarms when scanning stops and honors zero as disabled", () => {
		const restart = stub();
		const watchdog = new ScannerWatchdog(adapter, 60_000, restart);
		watchdog.activity();
		watchdog.stop();
		new ScannerWatchdog(adapter, 0, restart).activity();
		clock.tick(120_000);
		expect(restart.callCount).to.equal(0);
	});
});
