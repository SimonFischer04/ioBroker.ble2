import { expect } from "chai";
import type { PeripheralInfo } from "../lib/advertisement";
import { DevicePoller, GATEWAY_CHECK_MS } from "./device-poller";

const DEVICE = "a4:c1:38:12:34:56";
const advertisement = { address: DEVICE } as PeripheralInfo;

describe("connections/device-poller => DevicePoller", () => {
	const realNow = Date.now;
	let now: number;
	let warnings: string[];
	let gateway: boolean;
	let polls: number;
	let result: () => Promise<void>;
	let poller: DevicePoller;

	/** Lets the poll and its scheduling settle */
	const settle = (): Promise<void> =>
		new Promise((resolve) => setImmediate(resolve));

	beforeEach(() => {
		now = 1_000_000;
		Date.now = () => now;
		warnings = [];
		gateway = true;
		polls = 0;
		result = () => Promise.resolve();
		poller = new DevicePoller(
			{ warn: (message: string) => warnings.push(message) },
			{
				bestGateway: () =>
					gateway ? { gatewayId: "test.0:og", rssi: -60 } : undefined,
			},
			[DEVICE],
			{ intervalMs: 1000, retryMs: 100, what: "read" },
			() => {
				polls++;
				return result();
			},
		);
	});

	afterEach(() => {
		Date.now = realNow;
	});

	it("polls a device when it is first seen, then after the interval", async () => {
		poller.observe(advertisement);
		await settle();
		poller.observe(advertisement);
		expect(polls).to.equal(1);

		now += 999;
		poller.observe(advertisement);
		expect(polls).to.equal(1);
		now += 1;
		poller.observe(advertisement);
		expect(polls).to.equal(2);
	});

	it("does not poll again while a poll runs", () => {
		result = () => new Promise(() => {});
		poller.observe(advertisement);
		now += 10_000;
		poller.observe(advertisement);
		expect(polls).to.equal(1);
	});

	it("retries after a failed poll and reports it", async () => {
		result = () => Promise.reject(new Error("gone"));
		poller.observe(advertisement);
		await settle();
		expect(warnings).to.deep.equal([`Could not read ${DEVICE}: gone`]);

		now += 100;
		poller.observe(advertisement);
		expect(polls).to.equal(2);
	});

	it("asks for a gateway only now and then while none can connect", () => {
		gateway = false;
		poller.observe(advertisement);
		gateway = true;
		poller.observe(advertisement);
		expect(polls).to.equal(0);

		now += GATEWAY_CHECK_MS;
		poller.observe(advertisement);
		expect(polls).to.equal(1);
	});

	it("ignores devices that are not configured and stops after dispose()", async () => {
		poller.observe({ address: "a4:c1:38:00:00:01" } as PeripheralInfo);
		expect(polls).to.equal(0);

		result = () => Promise.reject(new Error("gone"));
		poller.observe(advertisement);
		poller.dispose();
		await settle();
		expect(poller.disposed).to.equal(true);
		expect(warnings).to.deep.equal([]);
		now += 10_000;
		poller.observe(advertisement);
		expect(polls).to.equal(1);
	});
});
