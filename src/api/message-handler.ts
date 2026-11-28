import { execFile } from "node:child_process";
import type { ConnectionManager } from "../connections/connection-manager";
import type { DeviceRegistry } from "../devices/device-registry";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import { toResponse } from "../lib/gateway-error";
import {
	GatewayCommands,
	type GattGetServicesResult,
	type GattReadResult,
} from "../lib/gateway-protocol";
import { parseGattRequest } from "../lib/gatt-request";
import { getHciOptions, parseHciPorts } from "../lib/hci-ports";
import type { PluginHost } from "../lib/plugin-host";
import type { RemoteGatewayTransport } from "../transports/remote-gateway";

/** The commands of the core. Plugins cannot take them over. */
export const CORE_COMMANDS: readonly string[] = [
	"getHCIOptions",
	"getHCIPorts",
	...Object.values(GatewayCommands),
];

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
	/** Answers the commands of the plugins, e.g. of a manufacturer */
	plugins: PluginHost;
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

		// The instance that sent the message: "system.adapter.esphome.0" -> "esphome.0"
		const sender = obj.from.replace(/^system\.adapter\./, "");

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
				respond(
					ctx.remoteGateway.handleAdvertisements(sender, obj.message),
				);
				return;
			}

			case GatewayCommands.announce: {
				respond(ctx.remoteGateway.handleAnnounce(sender, obj.message));
				return;
			}

			case GatewayCommands.connectionState: {
				ctx.remoteGateway.handleConnectionState(sender, obj.message);
				respond({ error: null, result: {} });
				return;
			}

			case GatewayCommands.notification: {
				ctx.remoteGateway.handleNotification(sender, obj.message);
				respond({ error: null, result: {} });
				return;
			}

			case GatewayCommands.discoverServices:
				void toResponse<GattGetServicesResult>(async () => {
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
				void toResponse<GattReadResult>(async () => {
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
				void toResponse<Record<string, never>>(async () => {
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

			case GatewayCommands.getGateways:
				respond({ error: null, result: ctx.gateways.list() });
				return;

			case GatewayCommands.getDevices:
				respond({ error: null, result: ctx.devices.getDevices() });
				return;

			default:
				// Commands of the plugins, e.g. actions of a manufacturer's devices
				void (
					ctx.plugins.runCommand(obj.command, obj.message) ??
					Promise.resolve({ error: "Unknown command!" })
				).then(respond);
				return;
		}
	};
}
