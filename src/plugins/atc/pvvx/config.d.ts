// Settings of the plugin "atc". Extends the configuration type of the adapter.
declare global {
	namespace ioBroker {
		interface AdapterConfig {
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
// Makes this file a module, so the declaration above extends the global type
export {};
