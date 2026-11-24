import * as utils from "@iobroker/adapter-core";
import { createMessageHandler } from "./api/message-handler";
import { DeviceRegistry } from "./devices/device-registry";
import { GatewayRegistry } from "./gateways/gateway-registry";
import type { PeripheralInfo } from "./lib/advertisement";
import { Global as _ } from "./lib/global";
import { ObjectCache } from "./lib/object-cache";
// Load all registered plugins
import plugins from "./plugins";
import { AdvertisementProcessor } from "./scanner/advertisement-processor";
import { fixServiceName, matchesServiceFilter } from "./scanner/service-filter";
import { NobleLocalTransport } from "./transports/noble-local";
import { NobleRemoteTransport } from "./transports/noble-remote";
import { RemoteGatewayTransport } from "./transports/remote-gateway";
import {
	migrateServerSettings,
	parseServerList,
} from "./transports/server-list";
import type { Transport, TransportContext } from "./transports/transport";

let processor: AdvertisementProcessor | undefined;
let gateways: GatewayRegistry | undefined;
let remoteGateway: RemoteGatewayTransport | undefined;
let handleMessage: ((obj: ioBroker.Message) => void) | undefined;
/** The sources of advertisements that are in use */
const transports: Transport[] = [];

// Adapter-Objekt erstellen
const adapter = utils.adapter({
	name: "ble",
	// is called when databases are connected and adapter received configuration.
	// start here!
	ready: async () => {
		// Adapter-Instanz global machen
		_.adapter = adapter;

		// Cache objects for 1 minute
		_.objectCache = new ObjectCache(60000);

		// When this start happened. Gateways that keep connections for us learn from it that we restarted.
		const epoch = Date.now();

		// Workaround für fehlende InstanceObjects nach update
		await _.ensureInstanceObjects();

		// Up to 0.14 there was a single remote scan server, which disabled the local Bluetooth adapter
		const migration = migrateServerSettings(adapter.config);
		if (migration) {
			adapter.log.info(
				`Moving the remote scan server "${migration.remoteServers}" to the list of remote scan servers. The local Bluetooth adapter stays disabled as before.`,
			);
			Object.assign(adapter.config, migration);
			try {
				await adapter.extendForeignObjectAsync(
					`system.adapter.${adapter.namespace}`,
					{ native: migration },
				);
			} catch (e) {
				adapter.log.warn(
					`Could not save the migrated settings: ${(e as Error).message}`,
				);
			}
		}

		// Plugins laden
		_.adapter.log.info(
			`loaded plugins: ${plugins.map((p) => p.name).join(", ")}`,
		);
		const enabledPluginNames: string[] = (
			(adapter.config.plugins as string) || ""
		)
			.split(",")
			.map((p: string) => p.trim().toLowerCase())
			.concat("_default");
		const enabledPlugins = plugins.filter(
			(p) => enabledPluginNames.indexOf(p.name.toLowerCase()) > -1,
		);
		_.adapter.log.info(
			`enabled plugins: ${enabledPlugins.map((p) => p.name).join(", ")}`,
		);

		// Bring the monitored service names into the correct form
		let services: string[] = [];
		if (adapter.config.services === "*") {
			_.adapter.log.info(`monitoring all services`);
		} else {
			services = ((adapter.config.services as string) || "")
				.split(",") // get manually defined services
				.concat(...enabledPlugins.map((p) => p.advertisedServices)) // concat with plugin-defined ones
				.reduce((acc, s) => acc.concat(s), [] as string[]) // flatten the arrays
				.map((s) => fixServiceName(s)) // cleanup the names
				.filter((s) => s !== "")
				.reduce((acc: any[], s) => {
					// filter out duplicates
					if (acc.indexOf(s) === -1) acc.push(s);
					return acc;
				}, []);
			_.adapter.log.info(`monitored services: ${services.join(", ")}`);
		}

		// Limit RSSI updates
		let rssiUpdateInterval = 0;
		if (adapter.config.rssiThrottle != null) {
			rssiUpdateInterval = Math.max(
				0,
				Math.min(10000, adapter.config.rssiThrottle),
			);
		}

		// The gateways are the sources of advertisements: the local Bluetooth adapter,
		// a remote scan server, and those other adapters deliver advertisements for
		const gatewayTimeout =
			typeof adapter.config.gatewayTimeout === "number" &&
			adapter.config.gatewayTimeout > 0
				? adapter.config.gatewayTimeout
				: 60;
		gateways = new GatewayRegistry(adapter, {
			remoteTimeoutMs: gatewayTimeout * 1000,
		});
		await gateways.init();

		const devices = new DeviceRegistry();
		processor = new AdvertisementProcessor(
			{
				plugins: enabledPlugins,
				allowEmptyDevices: !!adapter.config.allowEmptyDevices,
				rssiUpdateInterval,
			},
			devices,
			gateways,
		);
		const handleAdvertisement = (peripheral: PeripheralInfo): void => {
			processor!.process(peripheral).catch((e) => {
				adapter.log.error(
					`Could not handle the advertisement of ${peripheral.address}: ${
						(e as Error).message
					}`,
				);
			});
		};
		const transportContext: TransportContext = {
			adapter,
			gateways,
			onAdvertisement: handleAdvertisement,
		};

		// monitor our own states and objects
		adapter.subscribeStates("*");
		adapter.subscribeObjects("*");

		// Beim Start des Adapters sicher stellen, dass keine neuen Geräte erfasst werden,
		// bis der User es explizit erlaubt.
		await adapter.setStateAsync("options.allowNewDevices", false, true);

		// The local scanner applies the service filter while scanning. Advertisements from other
		// adapters and from remote scan servers are filtered here, so every source behaves the same.
		const filteredContext: TransportContext = {
			...transportContext,
			onAdvertisement: (peripheral) => {
				// Connections need to know every device in range, also the ones that are not decoded
				devices.track(peripheral);
				if (matchesServiceFilter(peripheral, services)) {
					handleAdvertisement(peripheral);
				}
			},
		};

		// Other adapters can always deliver advertisements
		remoteGateway = new RemoteGatewayTransport(filteredContext, epoch);
		transports.push(remoteGateway);
		// Connections through a gateway that went offline have ended
		gateways.onGatewayOffline = (gatewayId) =>
			remoteGateway?.gatewayOffline(gatewayId);
		handleMessage = createMessageHandler({
			adapter,
			gateways,
			devices,
			remoteGateway,
		});

		// And start scanning: with the Bluetooth adapter of this host and with the remote scan
		// servers, all at the same time
		const useLocalScanner = adapter.config.localScanner !== false;
		const { servers, invalid } = parseServerList(
			adapter.config.remoteServers,
		);
		for (const entry of invalid) {
			adapter.log.warn(
				`Ignoring the invalid remote scan server "${entry}", expected host or host:port`,
			);
		}
		if (useLocalScanner) {
			transports.push(
				new NobleLocalTransport(transportContext, {
					services,
					hciDevice: adapter.config.hciDevice,
				}),
			);
		}
		for (const server of servers) {
			transports.push(
				new NobleRemoteTransport(filteredContext, server, {
					// info.driverState has a single source: the local Bluetooth adapter, or the only
					// remote scan server, as up to 0.14
					reportDriverState: !useLocalScanner && servers.length === 1,
				}),
			);
		}
		if (!useLocalScanner && servers.length === 0) {
			adapter.log.info(
				"The local Bluetooth adapter is not used, waiting for advertisements from external gateways",
			);
		}
		for (const transport of transports) transport.start();
	},

	// is called when adapter shuts down - callback has to be called under any circumstances!
	unload: (callback) => {
		try {
			for (const transport of transports) transport.stop();
			processor?.dispose();
			gateways?.dispose();
		} catch {}
		callback();
	},

	// is called if a subscribed object changes
	objectChange: (id, obj) => {
		if (!!obj) {
			// it has just been changed, so update the cached object
			_.objectCache.updateObject(obj);
		} else {
			// it has been deleted, so delete it from the cache
			_.objectCache.invalidateObject(id);
		}
	},

	// is called if a subscribed state changes
	stateChange: (id, state) => {
		if (
			/options\.allowNewDevices$/.test(id) &&
			id.startsWith(adapter.namespace) &&
			state != undefined &&
			!state.ack
		) {
			if (typeof state.val === "boolean") {
				// ACK the state change
				_.adapter.setState(id, state.val, true);
				processor?.setAllowNewDevices(state.val);
			}
			return;
		}

		// When an instance that delivers advertisements stops, its gateways are offline
		remoteGateway?.handleStateChange(id, state);
	},

	message: (obj) => {
		if (handleMessage) {
			handleMessage(obj);
		} else if (obj?.callback) {
			// The adapter is still starting
			adapter.sendTo(
				obj.from,
				obj.command,
				{ error: "The adapter is not ready yet" },
				obj.callback,
			);
		}
	},
});
