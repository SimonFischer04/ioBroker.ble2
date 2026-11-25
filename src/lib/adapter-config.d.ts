// This file extends the AdapterConfig type from "@types/iobroker"
// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			services: string;
			/**
			 * Up to version 0.14: a single remote scan server ("host:port"). Moved to remoteServers
			 * when the adapter starts, see migrateServerSettings().
			 */
			server?: string;
			/**
			 * Remote scan servers (bin/blerp.js): "host", "host:port" or "[ipv6]:port", separated by
			 * commas, semicolons, spaces or line breaks. Missing in old configurations.
			 */
			remoteServers?: string;
			hciDevice: number;
			plugins: string;
			allowEmptyDevices: boolean;
			rssiThrottle: number;
			/**
			 * Whether the Bluetooth adapter of this host is used. When disabled, the adapter only
			 * handles advertisements other adapters deliver. Missing in old configurations = true.
			 */
			localScanner?: boolean;
			/** After how many seconds without advertisements an external gateway is offline */
			gatewayTimeout?: number;
			/**
			 * MAC addresses of pvvx thermometers whose clock is set, separated by commas, semicolons,
			 * spaces or line breaks. Missing in old configurations.
			 */
			pvvxDevices?: string;
			/** Hours between two time syncs of a pvvx device, 0 = no periodic sync. Missing in old configurations = 24. */
			pvvxSyncInterval?: number;
			/** Whether the newest pvvx firmware is looked up once a day. Missing in old configurations = true. */
			pvvxFirmwareCheck?: boolean;
			/**
			 * Base URL of firmware.json and the images of the pvvx firmware. Not in the admin, for
			 * tests and mirrors. Missing or empty = GitHub.
			 */
			pvvxFirmwareUrl?: string;
		}
	}
}
// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
