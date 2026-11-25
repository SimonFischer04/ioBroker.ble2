import type { GattLinkProvider } from "../connections/gatt-link";
import { parseAdvertisementData } from "../lib/ad-parser";
import { normalizeAddress, type PeripheralInfo } from "../lib/advertisement";
import { GatewayError } from "../lib/gateway-error";
import {
	GATEWAY_FEATURES,
	GATEWAY_PROTOCOL,
	GattCommands,
	MAX_ADVERTISEMENTS_PER_MESSAGE,
	type GattConnectResult,
	type GatewayAdvertisementsResult,
	type GatewayAnnounceResult,
	type GatewayFeature,
	type GatewayResponse,
} from "../lib/gateway-protocol";
import { sendRequest, type RequestSender } from "../lib/send-request";
import { GATT_TIMEOUTS_MS, RemoteGattLink } from "./remote-gatt-link";
import type { Transport, TransportContext } from "./transport";

const GATEWAY_ID_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;
/** Base64 as the gateway interface transports binary data */
export const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;
/** At most this many gateways in one "gateway:announce" */
const MAX_ANNOUNCED_GATEWAYS = 100;
/** Extended advertisements can be up to 1650 bytes long */
const MAX_DATA_LENGTH = 1650;
const ALIVE_REGEX = /^system\.adapter\.(.+)\.alive$/;

export interface ParsedGatewayMessage {
	/** The ID of the gateway, unique across all senders: "<sender>:<gatewayId>" */
	gatewayId: string;
	peripherals: PeripheralInfo[];
	/** How many items were skipped because they were invalid */
	rejected: number;
}

function invalid(message: string): GatewayResponse<never> {
	return { error: { code: "INVALID_PAYLOAD", message } };
}

/** A gateway as "gateway:announce" reports it, with its full ID */
export interface AnnouncedGateway {
	/** "<sender>:<gatewayId>" */
	id: string;
	connect: boolean;
	freeSlots?: number;
	slotLimit?: number;
	features: GatewayFeature[];
}

function isCount(value: unknown): boolean {
	return (
		value === undefined ||
		(Number.isInteger(value) && (value as number) >= 0)
	);
}

/** Validates the payload of "gateway:announce" */
export function parseAnnounceMessage(
	sender: string,
	payload: unknown,
): { gateways: AnnouncedGateway[] } | GatewayResponse<never> {
	if (payload == null || typeof payload !== "object") {
		return invalid("The message must be an object");
	}
	const { protocol, gateways } = payload as Record<string, unknown>;
	if (protocol !== GATEWAY_PROTOCOL) {
		return {
			error: {
				code: "UNSUPPORTED_PROTOCOL",
				message: `Only the protocol "${GATEWAY_PROTOCOL}" is supported`,
			},
		};
	}
	if (!Array.isArray(gateways)) {
		return invalid(`"gateways" must be an array`);
	}
	if (gateways.length > MAX_ANNOUNCED_GATEWAYS) {
		return invalid(
			`"gateways" must not contain more than ${MAX_ANNOUNCED_GATEWAYS} gateways`,
		);
	}

	const result: AnnouncedGateway[] = [];
	for (const entry of gateways) {
		if (entry == null || typeof entry !== "object") {
			return invalid("Every gateway must be an object");
		}
		const { gatewayId, connect, freeSlots, slotLimit, features } =
			entry as Record<string, unknown>;
		if (
			typeof gatewayId !== "string" ||
			!GATEWAY_ID_REGEX.test(gatewayId)
		) {
			return invalid(
				`"gatewayId" must consist of 1 to 64 letters, digits, "_", "-" or "."`,
			);
		}
		if (typeof connect !== "boolean") {
			return invalid(`"connect" of ${gatewayId} must be true or false`);
		}
		if (!isCount(freeSlots) || !isCount(slotLimit)) {
			return invalid(
				`"freeSlots" and "slotLimit" of ${gatewayId} must be whole numbers from 0`,
			);
		}
		if (
			features !== undefined &&
			(!Array.isArray(features) ||
				features.some((f) => typeof f !== "string"))
		) {
			return invalid(
				`"features" of ${gatewayId} must be an array of strings`,
			);
		}
		result.push({
			id: `${sender}:${gatewayId}`,
			connect,
			freeSlots: freeSlots as number | undefined,
			slotLimit: slotLimit as number | undefined,
			// Only known features, without duplicates. A gateway that cannot connect has none.
			features: connect
				? GATEWAY_FEATURES.filter((known) =>
						(features as string[] | undefined)?.includes(known),
					)
				: [],
		});
	}
	return { gateways: result };
}

/**
 * Validates the payload of "gateway:advertisements" and converts the advertisements into the
 * form the decoder plugins work with. Invalid items are skipped, so a single broken packet
 * does not discard the whole batch.
 */
export function parseGatewayMessage(
	sender: string,
	payload: unknown,
): ParsedGatewayMessage | GatewayResponse<never> {
	if (payload == null || typeof payload !== "object") {
		return invalid("The message must be an object");
	}
	const { gatewayId, items } = payload as Record<string, unknown>;
	if (typeof gatewayId !== "string" || !GATEWAY_ID_REGEX.test(gatewayId)) {
		return invalid(
			`"gatewayId" must consist of 1 to 64 letters, digits, "_", "-" or "."`,
		);
	}
	if (!Array.isArray(items)) {
		return invalid(`"items" must be an array`);
	}
	if (items.length > MAX_ADVERTISEMENTS_PER_MESSAGE) {
		return invalid(
			`"items" must not contain more than ${MAX_ADVERTISEMENTS_PER_MESSAGE} advertisements`,
		);
	}

	const fullGatewayId = `${sender}:${gatewayId}`;
	const peripherals: PeripheralInfo[] = [];
	let rejected = 0;
	for (const item of items) {
		const peripheral = parseItem(item, fullGatewayId);
		if (peripheral) {
			peripherals.push(peripheral);
		} else {
			rejected++;
		}
	}
	return { gatewayId: fullGatewayId, peripherals, rejected };
}

function parseItem(
	item: unknown,
	gatewayId: string,
): PeripheralInfo | undefined {
	if (item == null || typeof item !== "object") return;
	const { address, addressType, rssi, data, connectable } = item as Record<
		string,
		unknown
	>;

	const normalizedAddress = normalizeAddress(address);
	if (!normalizedAddress) return;
	if (typeof rssi !== "number" || !Number.isFinite(rssi)) return;
	if (
		typeof data !== "string" ||
		data.length > Math.ceil(MAX_DATA_LENGTH / 3) * 4 ||
		!BASE64_REGEX.test(data)
	) {
		return;
	}

	const id = normalizedAddress.replace(/:/g, "");
	return {
		id,
		uuid: id,
		address: normalizedAddress,
		addressType:
			addressType === "public" || addressType === "random"
				? addressType
				: "unknown",
		connectable: typeof connectable === "boolean" ? connectable : undefined,
		advertisement: parseAdvertisementData(Buffer.from(data, "base64")),
		rssi,
		gatewayId,
	};
}

/**
 * Receives advertisements other adapters deliver via sendTo ("gateway:advertisements").
 * Each sender can deliver for several gateways, e.g. one per ESPHome Bluetooth proxy.
 */
export class RemoteGatewayTransport implements Transport, GattLinkProvider {
	public constructor(
		private readonly ctx: TransportContext,
		/** When this adapter was started, see GatewayAnnounceResult.epoch */
		private readonly epoch: number,
	) {
		const adapter = ctx.adapter;
		this.requestSender = {
			sendTo: (instance, command, message, callback) =>
				adapter.sendTo(
					instance,
					command,
					message as ioBroker.MessagePayload,
					callback as ioBroker.MessageCallback,
				),
			setTimeout: (callback, ms) => adapter.setTimeout(callback, ms),
			clearTimeout: (timer) => adapter.clearTimeout(timer),
		};
	}

	private readonly senders = new Set<string>();
	private readonly requestSender: RequestSender;
	/** Open links by "<full gateway ID>|<address>" */
	private readonly links = new Map<string, RemoteGattLink>();

	public start(): void {
		// Nothing to do, the advertisements are pushed to us
	}

	public stop(): void {
		for (const link of [...this.links.values()]) link.handleEnded();
	}

	/**
	 * Opens a connection to a device through a gateway another adapter provides
	 * @param gatewayId Full ID of the gateway, e.g. "esphome.0:proxy-og"
	 */
	public async connect(
		gatewayId: string,
		address: string,
		addressType: "public" | "random",
	): Promise<RemoteGattLink> {
		const separator = gatewayId.indexOf(":");
		if (separator < 1) {
			throw new GatewayError(
				"UNKNOWN_GATEWAY",
				`${gatewayId} is not a gateway of another adapter`,
			);
		}
		const instance = gatewayId.slice(0, separator);
		const localGatewayId = gatewayId.slice(separator + 1);

		const result = await sendRequest<GattConnectResult>(
			this.requestSender,
			instance,
			GattCommands.connect,
			{
				gatewayId: localGatewayId,
				address,
				addressType,
				epoch: this.epoch,
			},
			GATT_TIMEOUTS_MS.connect,
		);
		const mtu =
			Number.isInteger(result?.mtu) && result.mtu >= 23 ? result.mtu : 23;

		const key = `${gatewayId}|${address}`;
		// A link that is still known is stale: the gateway opened a new connection
		this.links.get(key)?.handleEnded();
		const link = new RemoteGattLink(
			this.requestSender,
			this.ctx.adapter.log,
			gatewayId,
			instance,
			localGatewayId,
			address,
			mtu,
			() => {
				if (this.links.get(key) === link) this.links.delete(key);
			},
		);
		this.links.set(key, link);
		return link;
	}

	/**
	 * Handles a "gateway:connectionState" message: a connection ended without being asked to
	 * @param sender The instance that sent the message, e.g. "esphome.0"
	 */
	public handleConnectionState(sender: string, payload: unknown): void {
		const target = this.parseTarget(sender, payload);
		if (!target) {
			this.ctx.adapter.log.debug(
				`Ignoring an invalid gateway:connectionState from ${sender}`,
			);
			return;
		}
		const link = this.links.get(target);
		if (!link) return;
		this.ctx.adapter.log.debug(
			`The connection ${target} was ended by the gateway`,
		);
		link.handleEnded();
	}

	/**
	 * Handles a "gateway:notification" message
	 * @param sender The instance that sent the message, e.g. "esphome.0"
	 */
	public handleNotification(sender: string, payload: unknown): void {
		const target = this.parseTarget(sender, payload);
		if (!target) return;
		const { handle, data } = payload as Record<string, unknown>;
		if (
			!Number.isInteger(handle) ||
			(handle as number) < 0 ||
			typeof data !== "string" ||
			!BASE64_REGEX.test(data)
		) {
			return;
		}
		this.links
			.get(target)
			?.handleNotification(handle as number, Buffer.from(data, "base64"));
	}

	/** Ends all links of a gateway that went offline, without telling the gateway */
	public gatewayOffline(gatewayId: string): void {
		for (const [key, link] of [...this.links]) {
			if (key.startsWith(`${gatewayId}|`)) link.handleEnded();
		}
	}

	/** The key of the link a message is about, undefined if the message is invalid */
	private parseTarget(sender: string, payload: unknown): string | undefined {
		if (payload == null || typeof payload !== "object") return undefined;
		const { gatewayId, address } = payload as Record<string, unknown>;
		if (
			typeof gatewayId !== "string" ||
			!GATEWAY_ID_REGEX.test(gatewayId)
		) {
			return undefined;
		}
		const normalized = normalizeAddress(address);
		if (!normalized) return undefined;
		return `${sender}:${gatewayId}|${normalized}`;
	}

	/**
	 * Handles a "gateway:advertisements" message
	 * @param sender The instance that sent the message, e.g. "esphome.0"
	 */
	public handleAdvertisements(
		sender: string,
		payload: unknown,
	): GatewayResponse<GatewayAdvertisementsResult> {
		const parsed = parseGatewayMessage(sender, payload);
		if ("error" in parsed) return parsed;

		this.watchSender(sender);
		this.ctx.gateways.recordAdvertisements(
			{ id: parsed.gatewayId, type: "remote", sender },
			parsed.peripherals.length,
		);
		for (const peripheral of parsed.peripherals) {
			this.ctx.onAdvertisement(peripheral);
		}

		return {
			error: null,
			result: {
				accepted: parsed.peripherals.length,
				rejected: parsed.rejected,
			},
		};
	}

	/**
	 * Handles a "gateway:announce" message
	 * @param sender The instance that sent the message, e.g. "esphome.0"
	 */
	public handleAnnounce(
		sender: string,
		payload: unknown,
	): GatewayResponse<GatewayAnnounceResult> {
		const parsed = parseAnnounceMessage(sender, payload);
		if ("error" in parsed) return parsed;

		this.watchSender(sender);
		for (const { id, ...capabilities } of parsed.gateways) {
			this.ctx.gateways.announce(
				{ id, type: "remote", sender },
				capabilities,
			);
		}
		return {
			error: null,
			result: { protocol: GATEWAY_PROTOCOL, epoch: this.epoch },
		};
	}

	/** When the sending instance stops, its gateways are offline immediately */
	private watchSender(sender: string): void {
		if (this.senders.has(sender)) return;
		this.senders.add(sender);
		this.ctx.adapter.subscribeForeignStates(
			`system.adapter.${sender}.alive`,
		);
	}

	/** Must be called for the state changes the adapter receives */
	public handleStateChange(
		id: string,
		state: ioBroker.State | null | undefined,
	): void {
		const sender = ALIVE_REGEX.exec(id)?.[1];
		if (!sender || !this.senders.has(sender)) return;
		if (state?.val === false) {
			this.ctx.adapter.log.info(
				`${sender} was stopped, its gateways are offline`,
			);
			this.ctx.gateways.senderOffline(sender);
		}
	}
}
