import { execFile } from "node:child_process";
import type {
	ConnectionManager,
	SessionOptions,
} from "../connections/connection-manager";
import type { DeviceRegistry } from "../devices/device-registry";
import { syncLywsd02Clock } from "../drivers/lywsd02-clock";
import { readCometBlue } from "../drivers/comet-blue";
import { runSwitchBotAction } from "../drivers/switchbot-bot";
import { setCandelaBrightness } from "../drivers/candela";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import { normalizeAddress } from "../lib/advertisement";
import { readSkyrcMc3000Slot } from "../drivers/skyrc-mc3000";
import { GatewayError, toErrorResponse } from "../lib/gateway-error";
import {
	GatewayCommands,
	type GattGetServicesResult,
	type GattReadResult,
	type GatewayResponse,
} from "../lib/gateway-protocol";
import { runMagicSwitchBotAction } from "../drivers/magicswitchbot";
import { getHciOptions, parseHciPorts } from "../lib/hci-ports";
import { normalizeUuid } from "../lib/uuid";
import {
	BASE64_REGEX,
	type RemoteGatewayTransport,
} from "../transports/remote-gateway";

/** The parts of the adapter the message handler answers from */
export interface MessageHandlerContext {
	/** Used to send the answers and to read the configured HCI device */
	adapter: ioBroker.Adapter;
	/** Answers getGateways */
	gateways: GatewayRegistry;
	/** Answers getDevices */
	devices: DeviceRegistry;
	/** Receives the messages remote gateways send */
	remoteGateway: RemoteGatewayTransport;
	/** Runs the GATT commands */
	connections: ConnectionManager;
}

/** A validated request for one of the GATT commands */
interface GattRequest {
	address: string;
	service: string;
	characteristic: string;
	data: Buffer;
	withResponse: boolean;
	options: SessionOptions;
}

/**
 * Validates the payload of discoverServices, readCharacteristic and writeCharacteristic
 * before anything is connected. Throws GatewayError("INVALID_PAYLOAD").
 *
 * @param payload The message as received
 * @param fields Which fields the command needs besides the address
 * @param fields.characteristic Whether service and characteristic are required
 * @param fields.data Whether data (and optionally withResponse) is required
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
	const {
		address,
		service,
		characteristic,
		data,
		withResponse,
		gatewayId,
		addressType,
	} = payload as Record<string, unknown>;

	const normalizedAddress = normalizeAddress(address);
	if (!normalizedAddress) {
		throw invalid(`"address" must be a MAC address`);
	}
	if (
		gatewayId !== undefined &&
		(typeof gatewayId !== "string" || !gatewayId.trim())
	) {
		throw invalid('"gatewayId" must be a gateway identifier');
	}
	if (
		addressType !== undefined &&
		addressType !== "public" &&
		addressType !== "random"
	) {
		throw invalid('"addressType" must be public or random');
	}
	const request: GattRequest = {
		address: normalizedAddress,
		service: "",
		characteristic: "",
		data: Buffer.alloc(0),
		withResponse: true,
		options: { gatewayId, addressType },
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
 * @param run The command, may throw a GatewayError
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
 * @param ctx The parts of the adapter the messages are answered from
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

			case "runMagicSwitchBotAction":
				void runGattCommand(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const { action, pin } = obj.message as Record<
						string,
						unknown
					>;
					if (
						action !== "on" &&
						action !== "off" &&
						action !== "push"
					) {
						throw new GatewayError(
							"INVALID_PAYLOAD",
							"action must be on, off or push",
						);
					}
					if (
						pin !== undefined &&
						(typeof pin !== "string" || !/^\d{6}$/.test(pin))
					) {
						throw new GatewayError(
							"INVALID_PAYLOAD",
							"pin must be a six-digit string",
						);
					}
					await runMagicSwitchBotAction(
						ctx.connections,
						address,
						action,
						pin,
					);
					return { action };
				}).then(respond);
				return;

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

			case "syncLywsd02Clock":
				void runGattCommand<{ timestamp: number }>(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const timestamp = await syncLywsd02Clock(
						ctx.connections,
						address,
					);
					await adapter.setObjectNotExistsAsync(address, {
						type: "device",
						common: { name: address },
						native: { address },
					});
					const id = `${address}.lywsd02LastTimeSync`;
					await adapter.setObjectNotExistsAsync(id, {
						type: "state",
						common: {
							name: "LYWSD02 last time sync",
							type: "number",
							role: "date",
							read: true,
							write: false,
						},
						native: {},
					});
					await adapter.setStateAsync(id, {
						val: timestamp,
						ack: true,
					});
					return { timestamp };
				}).then(respond);
				return;

			case GatewayCommands.discoverServices:
				void runGattCommand<GattGetServicesResult>(async () => {
					const { address, options } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const services = await ctx.connections.withSession(
						address,
						(session) => session.getServices(),
						options,
					);
					return { services };
				}).then(respond);
				return;

			case GatewayCommands.readCharacteristic:
				void runGattCommand<GattReadResult>(async () => {
					const { address, service, characteristic, options } =
						parseGattRequest(obj.message, {
							characteristic: true,
							data: false,
						});
					const value = await ctx.connections.withSession(
						address,
						(session) => session.read(service, characteristic),
						options,
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
						options,
					} = parseGattRequest(obj.message, {
						characteristic: true,
						data: true,
					});
					await ctx.connections.withSession(
						address,
						(session) =>
							session.write(
								service,
								characteristic,
								data,
								withResponse,
							),
						options,
					);
					return {};
				}).then(respond);
				return;

			case "switchBot":
				void runGattCommand(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const { action } = obj.message as { action?: unknown };
					return runSwitchBotAction(ctx.connections, address, action);
				}).then(respond);
				return;

			case "readCometBlue":
				void runGattCommand(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const { pin } = obj.message as { pin?: unknown };
					return readCometBlue(ctx.connections, address, pin);
				}).then(respond);
				return;

			case GatewayCommands.getGateways:
				respond({ error: null, result: ctx.gateways.list() });
				return;

			case GatewayCommands.getDevices:
				respond({ error: null, result: ctx.devices.getDevices() });
				return;

			case "readSkyrcMc3000Slot":
				void runGattCommand(async () => {
					const { address } = parseGattRequest(obj.message, {
						characteristic: false,
						data: false,
					});
					const { slot } = obj.message as { slot?: unknown };
					if (
						typeof slot !== "number" ||
						!Number.isInteger(slot) ||
						slot < 1 ||
						slot > 4
					) {
						throw new GatewayError(
							"INVALID_PAYLOAD",
							"slot must be an integer from 1 to 4",
						);
					}
					return readSkyrcMc3000Slot(ctx.connections, address, slot);
				}).then(respond);
				return;

			default:
				respond({ error: "Unknown command!" });
				return;
		}
	};
}
