import { expect } from "chai";
import { createGatewayRegistry } from "../connections/test-fakes";
import { GatewayError } from "../lib/gateway-error";
import type { RemoteGattLink } from "./remote-gatt-link";
import { RemoteGatewayTransport } from "./remote-gateway";

const EPOCH = 1790000000000;
const DEVICE = "a4:c1:38:12:34:56";
const OG = "esphome.0:proxy-og";

interface SentRequest {
	instance: string;
	command: string;
	message: any;
	callback: (response: unknown) => void;
}

/** An adapter that records the requests and lets the test answer them */
class FakeAdapter {
	public readonly sent: SentRequest[] = [];
	public readonly timers = new Map<number, () => void>();
	private nextTimer = 1;
	public readonly log = { debug() {}, info() {}, warn() {}, error() {} };

	public sendTo(
		instance: string,
		command: string,
		message: unknown,
		callback: (response: unknown) => void,
	): void {
		this.sent.push({ instance, command, message, callback });
	}

	public setTimeout(callback: () => void): number {
		const id = this.nextTimer++;
		this.timers.set(id, callback);
		return id;
	}

	public clearTimeout(timer: number): void {
		this.timers.delete(timer);
	}

	public subscribeForeignStates(): void {}

	/**
	 * The last request with this command
	 *
	 * @param command
	 */
	public last(command: string): SentRequest {
		const request = [...this.sent]
			.reverse()
			.find((r) => r.command === command);
		if (!request) {
			throw new Error(`${command} was not sent`);
		}
		return request;
	}

	public answer(command: string, result: unknown): void {
		this.last(command).callback({ error: null, result });
	}

	public fail(command: string, code: string, message = "failed"): void {
		this.last(command).callback({ error: { code, message } });
	}

	public expireTimers(): void {
		for (const [id, callback] of [...this.timers]) {
			this.timers.delete(id);
			callback();
		}
	}
}

/** Lets pending promise callbacks run */
const tick = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
	try {
		await promise;
	} catch (e) {
		expect(e).to.be.instanceOf(GatewayError);
		return e as GatewayError;
	}
	throw new Error("the promise did not reject");
}

describe("transports/remote-gateway => links through gateways of other adapters", () => {
	let adapter: FakeAdapter;
	let transport: RemoteGatewayTransport;

	beforeEach(() => {
		adapter = new FakeAdapter();
		transport = new RemoteGatewayTransport(
			{
				adapter: adapter as unknown as ioBroker.Adapter,
				gateways: createGatewayRegistry(),
				onAdvertisement: () => {},
			},
			EPOCH,
		);
	});

	async function connect(
		gatewayId = OG,
		address = DEVICE,
	): Promise<RemoteGattLink> {
		const promise = transport.connect(gatewayId, address, "random");
		adapter.answer("gatt:connect", { mtu: 185 });
		return promise;
	}

	it("sends gatt:connect to the instance that owns the gateway", async () => {
		const link = await connect();
		expect(adapter.sent[0].instance).to.equal("esphome.0");
		expect(adapter.sent[0].message).to.deep.equal({
			gatewayId: "proxy-og",
			address: DEVICE,
			addressType: "random",
			epoch: EPOCH,
		});
		expect(link).to.include({ gatewayId: OG, address: DEVICE, mtu: 185 });
	});

	it("splits the gateway ID at the first colon", async () => {
		const promise = transport.connect("test.0:a:b", DEVICE, "public");
		expect(adapter.sent[0].instance).to.equal("test.0");
		expect(adapter.sent[0].message.gatewayId).to.equal("a:b");
		adapter.answer("gatt:connect", {});
		// No MTU reported: the minimum
		expect((await promise).mtu).to.equal(23);
	});

	it("sends the command of every link method", async () => {
		const link = await connect();
		const target = { gatewayId: "proxy-og", address: DEVICE };

		const services = link.getServices();
		expect(adapter.last("gatt:getServices").message).to.deep.equal(target);
		adapter.answer("gatt:getServices", { services: [] });
		expect(await services).to.deep.equal([]);

		const read = link.read(32);
		expect(adapter.last("gatt:read").message).to.deep.equal({
			...target,
			handle: 32,
		});
		adapter.answer("gatt:read", { data: "IwECAwQ=" });
		const value = await read;
		expect(Buffer.isBuffer(value)).to.be.true;
		expect(value.toString("hex")).to.equal("2301020304");

		const write = link.write(32, Buffer.from("0102", "hex"), false);
		expect(adapter.last("gatt:write").message).to.deep.equal({
			...target,
			handle: 32,
			data: "AQI=",
			withResponse: false,
		});
		adapter.answer("gatt:write", {});
		await write;

		const subscribe = link.subscribe(32, () => {});
		expect(adapter.last("gatt:subscribe").message).to.deep.equal({
			...target,
			handle: 32,
		});
		adapter.answer("gatt:subscribe", {});
		await subscribe;

		const disconnect = link.disconnect();
		expect(adapter.last("gatt:disconnect").message).to.deep.equal(target);
		adapter.answer("gatt:disconnect", {});
		await disconnect;
	});

	it("passes on the error code of the gateway", async () => {
		const promise = transport.connect(OG, DEVICE, "public");
		adapter.fail("gatt:connect", "NO_FREE_SLOT", "all slots in use");
		const error = await rejection(promise);
		expect(error.code).to.equal("NO_FREE_SLOT");
		expect(error.message).to.equal("all slots in use");

		const link = await connect();
		const read = link.read(32);
		adapter.fail("gatt:read", "GATT_ERROR");
		expect((await rejection(read)).code).to.equal("GATT_ERROR");
	});

	it("delivers a notification to the listener of its handle only", async () => {
		const link = await connect();
		const received: string[] = [];
		const subscribe32 = link.subscribe(32, (data) =>
			received.push(`32 ${data.toString("hex")}`),
		);
		adapter.answer("gatt:subscribe", {});
		await subscribe32;
		const subscribe40 = link.subscribe(40, (data) =>
			received.push(`40 ${data.toString("hex")}`),
		);
		adapter.answer("gatt:subscribe", {});
		await subscribe40;

		transport.handleNotification("esphome.0", {
			gatewayId: "proxy-og",
			address: DEVICE,
			handle: 32,
			data: "VQ==",
		});
		// Another device, another gateway, another instance: not for this link
		transport.handleNotification("esphome.0", {
			gatewayId: "proxy-og",
			address: "a4:c1:38:00:00:01",
			handle: 32,
			data: "AQ==",
		});
		transport.handleNotification("esphome.0", {
			gatewayId: "proxy-eg",
			address: DEVICE,
			handle: 32,
			data: "AQ==",
		});
		transport.handleNotification("esphome.1", {
			gatewayId: "proxy-og",
			address: DEVICE,
			handle: 32,
			data: "AQ==",
		});
		expect(received).to.deep.equal(["32 55"]);
	});

	it("removes the listener when subscribing fails", async () => {
		const link = await connect();
		const received: string[] = [];
		const subscribe = link.subscribe(32, (data) =>
			received.push(data.toString("hex")),
		);
		adapter.fail("gatt:subscribe", "GATT_ERROR");
		await rejection(subscribe);
		transport.handleNotification("esphome.0", {
			gatewayId: "proxy-og",
			address: DEVICE,
			handle: 32,
			data: "VQ==",
		});
		expect(received).to.deep.equal([]);
	});

	it("ends the link when the gateway reports the connection ended", async () => {
		const link = await connect();
		let ended = 0;
		link.onDisconnect(() => ended++);
		const pending = link.read(32);

		transport.handleConnectionState("esphome.0", {
			gatewayId: "proxy-og",
			address: DEVICE.toUpperCase(),
			connected: false,
		});

		expect(ended).to.equal(1);
		// The waiting request fails at once, not after its timeout
		expect((await rejection(pending)).code).to.equal("NOT_CONNECTED");
		const sent = adapter.sent.length;
		expect((await rejection(link.read(32))).code).to.equal("NOT_CONNECTED");
		expect(adapter.sent.length).to.equal(sent);
		// Ended by the gateway: nothing to disconnect
		await link.disconnect();
		expect(adapter.sent.length).to.equal(sent);
	});

	it("ignores reports about unknown links and invalid reports", async () => {
		expect(() => {
			transport.handleConnectionState("esphome.0", {
				gatewayId: "proxy-og",
				address: DEVICE,
				connected: false,
			});
			transport.handleConnectionState("esphome.0", { address: "x" });
			transport.handleConnectionState("esphome.0", undefined);
			transport.handleNotification("esphome.0", {
				gatewayId: "proxy-og",
				address: DEVICE,
				handle: 32,
				data: "AQ==",
			});
			transport.handleNotification("esphome.0", {
				gatewayId: "proxy-og",
				address: DEVICE,
				handle: -1,
				data: "not base64!",
			});
		}).not.to.throw();
	});

	it("never rejects disconnect(), even without an answer", async () => {
		const link = await connect();
		let ended = 0;
		link.onDisconnect(() => ended++);
		const disconnect = link.disconnect();
		adapter.expireTimers();
		await disconnect;
		// Disconnecting on purpose is not an unexpected end
		expect(ended).to.equal(0);
		expect((await rejection(link.read(32))).code).to.equal("NOT_CONNECTED");
	});

	it("ends the links of a gateway that went offline, without telling the gateway", async () => {
		const og = await connect(OG);
		const eg = await connect("esphome.0:proxy-eg");
		let ogEnded = 0;
		let egEnded = 0;
		og.onDisconnect(() => ogEnded++);
		eg.onDisconnect(() => egEnded++);
		const sent = adapter.sent.length;

		transport.gatewayOffline(OG);

		expect(ogEnded).to.equal(1);
		expect(egEnded).to.equal(0);
		expect(adapter.sent.length).to.equal(sent);
		expect((await rejection(og.read(32))).code).to.equal("NOT_CONNECTED");
		const read = eg.read(32);
		adapter.answer("gatt:read", { data: "AQ==" });
		expect((await read).toString("hex")).to.equal("01");
	});

	it("ends all links on stop()", async () => {
		const link = await connect();
		let ended = 0;
		link.onDisconnect(() => ended++);
		transport.stop();
		await tick();
		expect(ended).to.equal(1);
	});

	it("sends gatt:writeSequence and returns the value read afterwards", async () => {
		const link = await connect();

		const result = link.writeSequence(
			42,
			[Buffer.from("0102", "hex"), Buffer.from("03", "hex")],
			false,
			true,
		);
		expect(adapter.last("gatt:writeSequence").message).to.deep.equal({
			gatewayId: "proxy-og",
			address: DEVICE,
			handle: 42,
			data: ["AQI=", "Aw=="],
			withResponse: false,
			readAfter: true,
		});
		adapter.answer("gatt:writeSequence", { written: 2, data: "AA==" });
		expect((await result)?.toString("hex")).to.equal("00");
	});

	it("returns nothing without readAfter", async () => {
		const link = await connect();
		const result = link.writeSequence(42, [Buffer.from([1])], true, false);
		expect(
			adapter.last("gatt:writeSequence").message.withResponse,
		).to.equal(true);
		adapter.answer("gatt:writeSequence", { written: 1 });
		expect(await result).to.equal(undefined);
	});

	it("rejects an empty or too long sequence without sending it", async () => {
		const link = await connect();
		const sent = adapter.sent.length;
		expect(
			(await rejection(link.writeSequence(42, [], false, false))).code,
		).to.equal("INVALID_PAYLOAD");
		expect(
			(
				await rejection(
					link.writeSequence(
						42,
						new Array(65).fill(Buffer.from([1])),
						false,
						false,
					),
				)
			).code,
		).to.equal("INVALID_PAYLOAD");
		expect(adapter.sent).to.have.lengthOf(sent);
	});

	it("rejects an answer without the value read", async () => {
		const link = await connect();
		const result = link.writeSequence(42, [Buffer.from([1])], false, true);
		adapter.answer("gatt:writeSequence", { written: 1 });
		expect((await rejection(result)).code).to.equal("GATT_ERROR");
	});

	it("rejects a read answer that is not base64", async () => {
		const link = await connect();
		const result = link.read(32);
		adapter.answer("gatt:read", { data: "%%%" });
		expect((await rejection(result)).code).to.equal("GATT_ERROR");
	});
});
