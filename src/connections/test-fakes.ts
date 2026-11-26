// Fakes for the unit tests of the connection layer. Not used by the adapter itself.

import { GatewayRegistry } from "../gateways/gateway-registry";
import { GatewayError } from "../lib/gateway-error";
import type {
	GatewayErrorCode,
	GattServiceInfo,
} from "../lib/gateway-protocol";
import type { GattLink, GattLinkProvider } from "./gatt-link";

/** Service 0x1f10 with the characteristic 0x1f1f at handle 32, like the pvvx thermometers */
export const FAKE_SERVICES: GattServiceInfo[] = [
	{
		uuid: "00001f10-0000-1000-8000-00805f9b34fb",
		handle: 30,
		characteristics: [
			{
				uuid: "00001f1f-0000-1000-8000-00805f9b34fb",
				handle: 32,
				properties: 0x16,
				descriptors: [
					{
						uuid: "00002902-0000-1000-8000-00805f9b34fb",
						handle: 33,
					},
				],
			},
		],
	},
];

/** A link that records what is called on it */
export class FakeLink implements GattLink {
	public constructor(
		public readonly gatewayId: string,
		public readonly address: string,
		public readonly mtu: number = 23,
	) {}

	public services: GattServiceInfo[] = FAKE_SERVICES;
	public readonly values = new Map<number, Buffer>();
	/** Every call, e.g. "getServices", "read 32", "write 32 0102 true", "subscribe 32", "disconnect" */
	public readonly calls: string[] = [];
	public disconnects = 0;
	private readonly listeners = new Map<number, (data: Buffer) => void>();
	private disconnectListeners: (() => void)[] = [];

	public getServices(): Promise<GattServiceInfo[]> {
		this.calls.push("getServices");
		return Promise.resolve(this.services);
	}

	public read(handle: number): Promise<Buffer> {
		this.calls.push(`read ${handle}`);
		return Promise.resolve(this.values.get(handle) ?? Buffer.alloc(0));
	}

	public write(
		handle: number,
		data: Buffer,
		withResponse: boolean,
	): Promise<void> {
		this.calls.push(
			`write ${handle} ${data.toString("hex")} ${withResponse}`,
		);
		this.values.set(handle, data);
		return Promise.resolve();
	}

	public async writeSequence(
		handle: number,
		data: Buffer[],
		withResponse: boolean,
		readAfter: boolean,
	): Promise<Buffer | undefined> {
		this.calls.push(
			`writeSequence ${handle} ${data.length} ${withResponse} ${readAfter}`,
		);
		for (const entry of data) {
			await this.write(handle, entry, withResponse);
		}
		return readAfter ? this.read(handle) : undefined;
	}

	public subscribe(
		handle: number,
		listener: (data: Buffer) => void,
	): Promise<void> {
		this.calls.push(`subscribe ${handle}`);
		this.listeners.set(handle, listener);
		return Promise.resolve();
	}

	public disconnect(): Promise<void> {
		this.calls.push("disconnect");
		this.disconnects++;
		return Promise.resolve();
	}

	public onDisconnect(listener: () => void): void {
		this.disconnectListeners.push(listener);
	}

	/**
	 * The device sends a notification
	 *
	 * @param handle
	 * @param data
	 */
	public notify(handle: number, data: Buffer): void {
		this.listeners.get(handle)?.(data);
	}

	/** The connection ends without disconnect() being called */
	public simulateDisconnect(): void {
		for (const listener of this.disconnectListeners.splice(0)) {
			listener();
		}
	}
}

/** What a gateway of the FakeProvider does on connect */
export type FakeConnectBehaviour =
	"ok" | GatewayErrorCode | (() => Promise<FakeLink>);

/** Opens FakeLinks, as configured per gateway */
export class FakeProvider implements GattLinkProvider {
	public readonly behaviour = new Map<string, FakeConnectBehaviour>();
	/** Every connect call: "<gatewayId> <address> <addressType>" */
	public readonly connects: string[] = [];
	public readonly links: FakeLink[] = [];

	public async connect(
		gatewayId: string,
		address: string,
		addressType: "public" | "random",
	): Promise<FakeLink> {
		this.connects.push(`${gatewayId} ${address} ${addressType}`);
		const behaviour = this.behaviour.get(gatewayId) ?? "ok";
		let link: FakeLink;
		if (behaviour === "ok") {
			link = new FakeLink(gatewayId, address);
		} else if (typeof behaviour === "function") {
			link = await behaviour();
		} else {
			throw new GatewayError(behaviour, `${gatewayId} failed`);
		}
		this.links.push(link);
		return link;
	}
}

/** A GatewayRegistry on a minimal adapter that accepts all writes */
export function createGatewayRegistry(): GatewayRegistry {
	const adapter = {
		namespace: "ble.0",
		FORBIDDEN_CHARS: /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu,
		log: { debug() {}, info() {}, warn() {}, error() {} },
		setState() {},
		setStateAsync: () => Promise.resolve(),
		setObjectNotExistsAsync: () => Promise.resolve(),
		getStatesAsync: () => Promise.resolve({}),
	};
	return new GatewayRegistry(adapter as unknown as ioBroker.Adapter);
}

/** A promise with its resolve and reject functions */
export function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
