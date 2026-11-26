import { expect } from "chai";
import { useFakeTimers } from "sinon";
import { createGlobalMock } from "../../test/mocks/global";
import { ScannerIdleMonitor } from "./scanner-idle-monitor";

describe("local scanner idle recovery", () => {
	it("accumulates quiet scan windows and ignores scheduled pauses", () => {
		const clock = useFakeTimers();
		try {
			let restarts = 0;
			const monitor = new ScannerIdleMonitor(
				createGlobalMock({}).Global.adapter,
				1000,
				() => restarts++,
				() => Date.now(),
			);
			monitor.startWindow();
			clock.tick(400);
			monitor.endWindow();
			clock.tick(5000);
			expect(restarts).to.equal(0);
			monitor.startWindow();
			clock.tick(599);
			expect(restarts).to.equal(0);
			clock.tick(1);
			expect(restarts).to.equal(1);
		} finally {
			clock.restore();
		}
	});

	it("resets the budget after an advertisement and cancels on shutdown", () => {
		const clock = useFakeTimers();
		try {
			let restarts = 0;
			const monitor = new ScannerIdleMonitor(
				createGlobalMock({}).Global.adapter,
				1000,
				() => restarts++,
				() => Date.now(),
			);
			monitor.startWindow();
			clock.tick(700);
			monitor.packet();
			clock.tick(999);
			expect(restarts).to.equal(0);
			monitor.stop();
			clock.tick(10_000);
			expect(restarts).to.equal(0);
		} finally {
			clock.restore();
		}
	});
});
