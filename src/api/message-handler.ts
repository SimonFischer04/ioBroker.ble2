import { execFile } from "node:child_process";
import type { ConnectionManager } from "../connections/connection-manager";
import type { DeviceRegistry } from "../devices/device-registry";
import { setCandelaBrightness } from "../drivers/candela";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import { normalizeAddress } from "../lib/advertisement";
import { GatewayError, toErrorResponse } from "../lib/gateway-error";
import {
	GatewayCommands,
	type GattGetServicesResult,
	type GattReadResult,
	type GatewayResponse,
} from "../lib/gateway-protocol";
import { getHciOptions, parseHciPorts } from "../lib/hci-ports";
import { normalizeUuid } from "../lib/uuid";
import {
	BASE64_REGEX,
	type RemoteGatewayTransport,
} from "../transports/remote-gateway";

export interface MessageHandlerContext {
	adapter: ioBroker.Adapter;
	gateways: GatewayRegistry;
	devices: DeviceRegistry;
	remoteGateway: RemoteGatewayTransport;
	connections: ConnectionManager;
}

/** A validated request for one of the GATT commands */
interface GattRequest {
	address: string;
	service: string;
	characteristic: string;
	data: Buffer;
	withResponse: boolean;
}

/**
 * Validates the payload of discoverServices, readCharacteristic and writeCharacteristic
 * before anything is connected. Throws GatewayError("INVALID_PAYLOAD").
 *
 * @param payload
 * @param fields
 * @param fields.characteristic
 * @param fields.data
 */
function parseGattRequest(
	payload: unknown,
	fields: { characteristic: boolean; data: boolean },
): GattRequest {
	const invalid = (message: string): GatewayError =>
		new GatewayError("INVALID_PAYLOAD", message);
	if (payload == null || typeof payload !== "object") {
		throw invalid("The message must be an object");
	}
	const { address, service, characteristic, data, withResponse } =
		payload as Record<string, unknown>;

	const normalizedAddress = normalizeAddress(address);
	if (!normalizedAddress) {
		throw invalid(`"address" must be a MAC address`);
	}
	const request: GattRequest = {
		address: normalizedAddress,
		service: "",
		characteristic: "",
		data: Buffer.alloc(0),
		withResponse: true,
	};
	if (fields.characteristic) {
		const serviceUuid = normalizeUuid(service);
		const characteristicUuid = normalizeUuid(characteristic);
		if (!serviceUuid) {
			throw invalid(`"service" must be a UUID`);
		}
		if (!characteristicUuid) {
			throw invalid(`"characteristic" must be a UUID`);
		}
		request.service = serviceUuid;
		request.characteristic = characteristicUuid;
	}
	if (fields.data) {
		if (typeof data !== "string" || !BASE64_REGEX.test(data)) {
			throw invalid(`"data" must be base64 encoded`);
		}
		if (withResponse !== undefined && typeof withResponse !== "boolean") {
			throw invalid(`"withResponse" must be true or false`);
		}
		request.data = Buffer.from(data, "base64");
		request.withResponse = withResponse ?? true;
	}
	return request;
}

/**
 * Runs a GATT command and turns the result or the error into the answer
 *
 * @param run
 */
async function runGattCommand<T>(
	run: () => Promise<T>,
): Promise<GatewayResponse<T>> {
	try {
		return { error: null, result: await run() };
	} catch (e) {
		return toErrorResponse(e);
	}
}

/**
 * Creates the handler for the messages other adapters and the admin UI send to this adapter
 *
 * @param ctx
 */
export function createMessageHandler(
	ctx: MessageHandlerContext,
): (obj: ioBroker.Message) => void {
	const { adapter } = ctx;

	return (obj) => {
		if (!obj) {
			return;
		}

		// responds to the adapter that sent the original message
		function respond(response: any): void {
			if (obj.callback) {
				adapter.sendTo(obj.from, obj.command, response, obj.callback);
			}
		}

		switch (obj.command) {
			case "getHCIOptions":
			case "getHCIPorts":
				if (!obj.callback) {
					return;
				}
				execFile("hciconfig", { timeout: 3000 }, (error, stdout) => {
					const wantsOptions = obj.command === "getHCIOptions";
					if (error != null) {
						respond(wantsOptions ? [] : { error });
						return;
					}
					const ports = parseHciPorts(stdout);
					respond(
						wantsOptions
							? getHciOptions(ports, adapter.config.hciDevice)
							: { error: null, result: ports },
					);
				});
				return;

			case GatewayCommands.advertisements: {
				// "system.adapter.esphome.0" -> "esphome.0"
				const sender = obj.from.replace(/^system\.adapter\./, "");
				respond(
					ctx.remoteGateway.handleAdvertisements(sender, obj.message),
				);
				return;
			}

			case GatewayCommands.announce: {
				const sender = obj.from.replace(/^system\.adapter\./, "");
				respond(ctx.remoteGateway.handleAnnounce(sender, obj.message));
				return;
			}

			case GatewayCommands.connectionState: {
				const sender = obj.from.replace(/^system\.adapter\./, "");
				ctx.remoteGateway.handleConnectionState(sender, obj.message);
				respond({ error: null, result: {} });
				return;
			}

			case "setCandelaBrightness":
				void runGattCommand<{ brightness: number }>(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const { brightness } = obj.message as {
						brightness?: unknown;
					};
					if (
						typeof brightness !== "number" ||
						!Number.isInteger(brightness) ||
						brightness < 0 ||
						brightness > 100
					) {
						throw new GatewayError(
							"INVALID_PAYLOAD",
							"brightness must be a whole number from 0 to 100",
						);
					}
					const device = ctx.devices
						.getDevices()
						.find((device) => device.address === address);
					if (device?.name?.toLowerCase() !== "yeelight_ms") {
						throw new GatewayError(
							"GATT_ERROR",
							"The device has not advertised as a Yeelight Candela",
						);
					}
					await setCandelaBrightness(
						ctx.connections,
						address,
						brightness,
					);
					return { brightness };
				}).then(respond);
				return;

			case GatewayCommands.notification: {
				const sender = obj.from.replace(/^system\.adapter\./, "");
				ctx.remoteGateway.handleNotification(sender, obj.message);
				respond({ error: null, result: {} });
				return;
			}

			case GatewayCommands.discoverServices:
				void runGattCommand<GattGetServicesResult>(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const services = await ctx.connections.withSession(
						address,
						(session) => session.getServices(),
					);
					return { services };
				}).then(respond);
				return;

			case GatewayCommands.readCharacteristic:
				void runGattCommand<GattReadResult>(async () => {
					const { address, service, characteristic } =
						parseGattRequest(obj.message, {
							characteristic: true,
							data: false,
						});
					const value = await ctx.connections.withSession(
						address,
						(session) => session.read(service, characteristic),
					);
					return { data: value.toString("base64") };
				}).then(respond);
				return;

			case GatewayCommands.writeCharacteristic:
				void runGattCommand<Record<string, never>>(async () => {
					const {
						address,
						service,
						characteristic,
						data,
						withResponse,
					} = parseGattRequest(obj.message, {
						characteristic: true,
						data: true,
					});
					await ctx.connections.withSession(address, (session) =>
						session.write(
							service,
							characteristic,
							data,
							withResponse,
						),
					);
					return {};
				}).then(respond);
				return;

			case GatewayCommands.getGateways:
				respond({ error: null, result: ctx.gateways.list() });
				return;

			case GatewayCommands.getDevices:
				respond({ error: null, result: ctx.devices.getDevices() });
				return;

			default:
				respond({ error: "Unknown command!" });
				return;
		}
	};
}
