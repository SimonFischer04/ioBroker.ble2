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
			hciDevice: number | string;
			scanIntervalMinutes?: number;
			scanWindowSeconds?: number;
			scannerIdleRestartMinutes?: number;
			plugins: string;
			xiaomiBindkeys?: string;
			bthomeBindkeys?: string;
			allowEmptyDevices: boolean;
			presenceDevices?: {
				address: string;
				packets: number;
				absenceSeconds: number;
			}[];
			rssiThrottle: number;
			rssiTimeoutSeconds?: number;
			/**
			 * Whether the Bluetooth adapter of this host is used. When disabled, the adapter only
			 * handles advertisements other adapters deliver. Missing in old configurations = true.
			 */
			localScanner?: boolean;
			/** After how many seconds without advertisements an external gateway is offline */
			gatewayTimeout?: number;
			// Settings of the plugins are declared in their folders (src/plugins/*/config.d.ts)
		}
	}
}
// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
