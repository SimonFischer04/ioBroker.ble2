import { expect } from "chai";
import { DeviceRegistry } from "../devices/device-registry";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import type { PeripheralInfo } from "../lib/advertisement";
import { GatewayError } from "../lib/gateway-error";
import { ConnectionManager } from "./connection-manager";
import type { GattSession } from "./gatt-session";
import {
	FakeLink,
	FakeProvider,
	createGatewayRegistry,
	deferred,
} from "./test-fakes";

const DEVICE = "a4:c1:38:12:34:56";
const OTHER = "a4:c1:38:00:00:01";
const OG = "esphome.0:proxy-og";
const KELLER = "esphome.0:proxy-keller";

function reception(
	address: string,
	gatewayId: string,
	rssi: number,
): PeripheralInfo {
	const id = address.replace(/:/g, "");
	return {
		id,
		uuid: id,
		address,
		addressType: "unknown",
		rssi,
		gatewayId,
		advertisement: {},
	};
}

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
	try {
		await promise;
	} catch (e) {
		expect(e).to.be.instanceOf(GatewayError);
		return e as GatewayError;
	}
	throw new Error("the promise did not reject");
}

/** Lets pending promise callbacks run */
const tick = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

describe("connections/connection-manager => ConnectionManager", () => {
	let devices: DeviceRegistry;
	let gateways: GatewayRegistry;
	let provider: FakeProvider;
	let manager: ConnectionManager;

	function announce(
		id: string,
		capabilities: { connect: boolean; freeSlots?: number } = {
			connect: true,
		},
	): void {
		gateways.announce(
			{ id, type: "remote", sender: "esphome.0" },
			capabilities,
		);
	}

	beforeEach(() => {
		devices = new DeviceRegistry();
		gateways = createGatewayRegistry();
		provider = new FakeProvider();
		manager = new ConnectionManager({
			log: { debug() {}, info() {}, warn() {} },
			devices,
			gateways,
			provider,
			setTimeout: (callback, ms) => setTimeout(callback, ms),
			clearTimeout: (timer) => clearTimeout(timer),
		});
		announce(OG);
		announce(KELLER);
		devices.track(reception(DEVICE, KELLER, -85));
		devices.track(reception(DEVICE, OG, -55));
	});

	afterEach(() => manager.dispose());

	it("connects through the gateway with the best signal, runs the job and disconnects", async () => {
		const result = await manager.withSession(DEVICE, async (session) => {
			expect(session.gatewayId).to.equal(OG);
			return "done";
		});
		expect(result).to.equal("done");
		expect(provider.connects).to.deep.equal([`${OG} ${DEVICE} public`]);
		expect(provider.links[0].disconnects).to.equal(1);
	});

	it("passes the address type the device reported", async () => {
		devices.track({ ...reception(DEVICE, OG, -55), addressType: "random" });
		await manager.withSession(DEVICE, async () => undefined);
		expect(provider.connects).to.deep.equal([`${OG} ${DEVICE} random`]);
	});

	it("passes an error of the job on and disconnects anyway", async () => {
		const error = await rejection(
			manager.withSession(DEVICE, () =>
				Promise.reject(new GatewayError("GATT_ERROR", "rejected")),
			),
		);
		expect(error.message).to.equal("rejected");
		expect(provider.links[0].disconnects).to.equal(1);
	});

	it("runs two jobs for the same device one after the other", async () => {
		const first = deferred<void>();
		const order: string[] = [];
		const one = manager.withSession(DEVICE, async () => {
			order.push("first started");
			await first.promise;
			order.push("first done");
		});
		const two = manager.withSession(DEVICE, async () => {
			order.push(
				`second started, first link disconnected: ${provider.links[0].disconnects}`,
			);
		});
		await tick();
		expect(provider.connects).to.have.length(1);
		first.resolve();
		await Promise.all([one, two]);
		expect(order).to.deep.equal([
			"first started",
			"first done",
			"second started, first link disconnected: 1",
		]);
	});

	it("runs jobs for different devices at the same time", async () => {
		devices.track(reception(OTHER, OG, -60));
		const block = deferred<void>();
		const one = manager.withSession(DEVICE, () => block.promise);
		const two = manager.withSession(OTHER, async () => "other");
		expect(await two).to.equal("other");
		block.resolve();
		await one;
	});

	it("runs a waiting job with high priority before older normal ones", async () => {
		const block = deferred<void>();
		const order: string[] = [];
		const running = manager.withSession(DEVICE, () => block.promise);
		const normal = manager.withSession(DEVICE, async () => {
			order.push("normal");
		});
		const high = manager.withSession(
			DEVICE,
			async () => {
				order.push("high");
			},
			{ priority: "high" },
		);
		block.resolve();
		await Promise.all([running, normal, high]);
		expect(order).to.deep.equal(["high", "normal"]);
	});

	it("tries the next gateway when the best one fails", async () => {
		provider.behaviour.set(OG, "CONNECT_FAILED");
		await manager.withSession(DEVICE, async (session) => {
			expect(session.gatewayId).to.equal(KELLER);
		});
		expect(provider.connects).to.deep.equal([
			`${OG} ${DEVICE} public`,
			`${KELLER} ${DEVICE} public`,
		]);
	});

	it("rejects with the error of the last gateway when all fail", async () => {
		provider.behaviour.set(OG, "CONNECT_FAILED");
		provider.behaviour.set(KELLER, "NO_FREE_SLOT");
		const error = await rejection(
			manager.withSession(DEVICE, async () => undefined),
		);
		expect(error.code).to.equal("NO_FREE_SLOT");
	});

	it("does not try gateways that cannot connect, are offline or have no free slot", async () => {
		const passive = "esphome.0:proxy-passive";
		const offline = "esphome.0:proxy-offline";
		const full = "esphome.0:proxy-full";
		announce(passive, { connect: false });
		announce(offline);
		gateways.setConnected(
			{ id: offline, type: "remote", sender: "esphome.0" },
			false,
		);
		announce(full, { connect: true, freeSlots: 0 });
		for (const id of [passive, offline, full]) {
			devices.track(reception(DEVICE, id, -30));
		}

		await manager.withSession(DEVICE, async () => undefined);
		expect(provider.connects).to.deep.equal([`${OG} ${DEVICE} public`]);
	});

	it("tries only the given gateways, in their order", async () => {
		provider.behaviour.set(KELLER, "CONNECT_FAILED");
		const error = await rejection(
			manager.withSession(DEVICE, async () => undefined, {
				gateways: [KELLER],
			}),
		);
		expect(error.code).to.equal("CONNECT_FAILED");
		// OG receives the device better, but was not given
		expect(provider.connects).to.deep.equal([`${KELLER} ${DEVICE} public`]);
	});

	it("uses a given gateway that never reported the device", async () => {
		await manager.withSession(OTHER, async () => undefined, {
			gateways: [KELLER],
		});
		expect(provider.connects).to.deep.equal([`${KELLER} ${OTHER} public`]);
	});

	it("skips given gateways that cannot connect", async () => {
		const passive = "esphome.0:proxy-passive";
		announce(passive, { connect: false });
		await manager.withSession(DEVICE, async () => undefined, {
			gateways: [passive, "esphome.0:unknown", KELLER],
		});
		expect(provider.connects).to.deep.equal([`${KELLER} ${DEVICE} public`]);
	});

	it("reports NO_GATEWAY for an empty or useless gateway list", async () => {
		for (const list of [[], ["esphome.0:unknown"]]) {
			const error = await rejection(
				manager.withSession(DEVICE, async () => undefined, {
					gateways: list,
				}),
			);
			expect(error.code).to.equal("NO_GATEWAY");
		}
		expect(provider.connects).to.deep.equal([]);
	});

	it("reports NO_GATEWAY without trying when no gateway can connect", async () => {
		const error = await rejection(
			manager.withSession("a4:c1:38:99:99:99", async () => undefined),
		);
		expect(error.code).to.equal("NO_GATEWAY");
		expect(error.message).to.equal(
			"No gateway that can connect receives a4:c1:38:99:99:99",
		);
		expect(provider.connects).to.deep.equal([]);
	});

	it("closes a session that takes too long and starts the next job", async () => {
		const hanging = manager.withSession(
			DEVICE,
			() => new Promise<void>(() => {}),
			{ timeoutMs: 50 },
		);
		const next = manager.withSession(DEVICE, async () => "next");
		const error = await rejection(hanging);
		expect(error.code).to.equal("TIMEOUT");
		expect(error.message).to.equal(
			`Session with ${DEVICE} took longer than 50 ms`,
		);
		expect(await next).to.equal("next");
		expect(provider.links[0].disconnects).to.equal(1);
	});

	it("disconnects a link that arrives after the time is up", async () => {
		const late = deferred<FakeLink>();
		provider.behaviour.set(OG, () => late.promise);
		const error = await rejection(
			manager.withSession(DEVICE, async () => "never", { timeoutMs: 50 }),
		);
		expect(error.code).to.equal("TIMEOUT");
		const link = new FakeLink(OG, DEVICE);
		late.resolve(link);
		await tick();
		await tick();
		expect(link.disconnects).to.equal(1);
	});

	it("starts the next job only after a late link was closed", async () => {
		const late = deferred<FakeLink>();
		provider.behaviour.set(OG, () => late.promise);
		const first = manager.withSession(DEVICE, async () => "never", {
			timeoutMs: 50,
		});
		const second = manager.withSession(DEVICE, async (s) => s.gatewayId);
		expect((await rejection(first)).code).to.equal("TIMEOUT");
		await tick();
		// The first connection attempt is still running
		expect(provider.connects).to.have.lengthOf(1);

		provider.behaviour.delete(OG);
		const link = new FakeLink(OG, DEVICE);
		late.resolve(link);
		expect(await second).to.equal(OG);
		expect(link.disconnects).to.equal(1);
		expect(provider.connects).to.have.lengthOf(2);
		expect(provider.links[1]).to.not.equal(link);
	});

	it("tries no further gateway once the job has expired", async () => {
		const failing = deferred<FakeLink>();
		provider.behaviour.set(OG, () => failing.promise);
		const error = await rejection(
			manager.withSession(DEVICE, async () => "never", { timeoutMs: 50 }),
		);
		expect(error.code).to.equal("TIMEOUT");

		failing.reject(new GatewayError("CONNECT_FAILED", "no answer"));
		await tick();
		await tick();
		// KELLER would be next, but the job is over
		expect(provider.connects).to.deep.equal([`${OG} ${DEVICE} public`]);
		// The queue is free again
		provider.behaviour.delete(OG);
		await manager.withSession(DEVICE, async () => undefined);
		expect(provider.connects).to.have.lengthOf(2);
	});

	it("reception() tells the newest signal of a gateway and its age, even if it cannot connect", () => {
		announce(OG, { connect: true, freeSlots: 0 });
		const reception = manager.reception("A4-C1-38-12-34-56", OG);
		expect(reception?.rssi).to.equal(-55);
		expect(reception?.ageMs).to.be.within(0, 1000);
		expect(manager.reception(DEVICE, "esphome.0:unknown")).to.equal(
			undefined,
		);
		expect(manager.reception("not a mac", OG)).to.equal(undefined);
	});

	it("rejects an invalid address", async () => {
		const error = await rejection(
			manager.withSession("not a mac", async () => undefined),
		);
		expect(error.code).to.equal("INVALID_PAYLOAD");
	});

	it("accepts addresses in any notation", async () => {
		await manager.withSession("A4-C1-38-12-34-56", async () => undefined);
		expect(provider.connects).to.deep.equal([`${OG} ${DEVICE} public`]);
	});

	it("fails waiting jobs and closes the running session on dispose()", async () => {
		let session: GattSession | undefined;
		const started = deferred<void>();
		const running = manager.withSession(DEVICE, async (s) => {
			session = s;
			started.resolve();
			await s.read("1f10", "1f1f");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return s.read("1f10", "1f1f");
		});
		const waiting = manager.withSession(DEVICE, async () => undefined);
		await started.promise;

		manager.dispose();

		expect((await rejection(waiting)).code).to.equal("NOT_CONNECTED");
		expect((await rejection(running)).code).to.equal("NOT_CONNECTED");
		expect(session?.closed).to.be.true;
		expect(provider.links[0].disconnects).to.equal(1);
		expect(
			(
				await rejection(
					manager.withSession(DEVICE, async () => undefined),
				)
			).message,
		).to.equal("The adapter is stopping");
	});

	it("candidates() lists the gateways that can connect, strongest first", () => {
		gateways.announce(
			{ id: KELLER, type: "remote", sender: "esphome.0" },
			{ connect: true, features: ["writeSequence"] },
		);
		const passive = "esphome.0:proxy-passive";
		announce(passive, { connect: false });
		devices.track(reception(DEVICE, passive, -30));

		expect(manager.candidates("A4-C1-38-12-34-56")).to.deep.equal([
			{ gatewayId: OG, rssi: -55, features: [] },
			{ gatewayId: KELLER, rssi: -85, features: ["writeSequence"] },
		]);
		expect(manager.candidates(OTHER)).to.deep.equal([]);
		expect(manager.candidates("not a mac")).to.deep.equal([]);
	});
});
