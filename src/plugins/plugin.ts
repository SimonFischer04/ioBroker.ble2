import type { ConnectionManager } from "../connections/connection-manager";
import type { DeviceRegistry } from "../devices/device-registry";
import type { PeripheralInfo as ReceivedPeripheral } from "../lib/advertisement";
import type { PeripheralInfo } from "../lib/scanProcessInterface";

export type DeviceObjectDefinition = Partial<
	Pick<ioBroker.DeviceObject, "common" | "native">
>;
export type ChannelObjectDefinition = Partial<
	Pick<ioBroker.ChannelObject, "common" | "native">
> & {
	id: string;
};
export type StateObjectDefinition = Partial<
	Pick<ioBroker.StateObject, "common" | "native">
> & {
	id: string;
};

/**
 * Defines the object structure for a handled peripheral.
 * RSSI is created by default
 */
export interface PeripheralObjectStructure {
	/**
	 * How the device object should look like.
	 */
	device: DeviceObjectDefinition;
	/**
	 * Which channels to create.
	 * May be undefined if the plugin knows that the objects exist or none should be created.
	 */
	channels: ChannelObjectDefinition[] | undefined;
	/**
	 * Which states to create.
	 */
	states: StateObjectDefinition[];
}

/** Defines the interface a plugin has to expose */
export interface Plugin<TContext = any> {
	/** Name of the plugin */
	name: string;
	/** Description of the plugin */
	description: string;
	/** A list of services to include in the scan */
	advertisedServices: string[];
	/** Bluetooth company identifiers to include even without advertised services */
	manufacturerIds?: number[];
	/** Loads instance configuration before scanning starts. */
	initialize?: () => void;

	/** Determines whether this plugin is handling a peripheral or not */
	isHandling: (peripheral: PeripheralInfo) => boolean;
	/** Creates an object used by @see{defineObjects} and @see{getValues} to create their return values */
	createContext: (peripheral: PeripheralInfo) => TContext | undefined;
	/** Defines the object structure for a handled peripheral. */
	defineObjects: (context: TContext) => PeripheralObjectStructure | undefined;
	/** Returns the values extracted from the peripheral */
	getValues: (context: TContext) => Record<string, any> | undefined;

	/**
	 * Optional active part: talks to the devices of the manufacturer, e.g. over GATT. Started once
	 * when the adapter starts, independent of the setting "plugins", which only selects the decoders.
	 * It does nothing until it is configured (e.g. a list of devices) or one of its commands is used.
	 */
	start?: (ctx: PluginContext) => PluginInstance | Promise<PluginInstance>;
}

/** What the core of the adapter gives the active part of a plugin */
export interface PluginContext {
	/** The adapter: configuration, objects, states, timers and log */
	adapter: ioBroker.Adapter;
	/** Opens GATT sessions through the gateways that can connect */
	connections: ConnectionManager;
	/** Which gateways receive which devices, and the names the devices advertise */
	devices: DeviceRegistry;
}

/** A started active part of a plugin */
export interface PluginInstance {
	/** Called for every received advertisement of any device, before the service filter */
	observe?: (peripheral: ReceivedPeripheral) => void;
	/**
	 * Own sendTo commands. The handler gets the message payload and resolves with the result;
	 * a thrown GatewayError becomes an error answer with its code.
	 */
	commands?: Record<string, (message: unknown) => Promise<unknown>>;
	/** Called for changes of the adapter's own states. Returns true if the state belongs to the plugin. */
	handleStateChange?: (
		id: string,
		state: ioBroker.State | null | undefined,
	) => boolean;
	/** Called when the adapter stops, before the connections are closed */
	dispose?: () => void;
}

/** Decoder of a plugin that has only an active part: it handles no advertisement */
export const NO_DECODER: Pick<
	Plugin<undefined>,
	| "advertisedServices"
	| "isHandling"
	| "createContext"
	| "defineObjects"
	| "getValues"
> = {
	advertisedServices: [],
	isHandling: () => false,
	createContext: () => undefined,
	defineObjects: () => undefined,
	getValues: () => undefined,
};

export function getServiceData(
	peripheral: PeripheralInfo,
	uuid: string,
): Buffer | undefined {
	for (const entry of peripheral.advertisement?.serviceData ?? []) {
		if (entry.uuid === uuid) {
			return entry.data;
		}
	}
}

/**
 * Aliases an existing plugin with a new name
 *
 * @param newName Name of the alias
 * @param oldPlugin Plugin to reuse
 */
export function alias(newName: string, oldPlugin: Plugin): Plugin {
	// The active part runs once, for the original plugin
	const { name, start, ...plugin } = oldPlugin;
	return {
		name: newName,
		...plugin,
	};
}
