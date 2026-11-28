// Settings of the plugin "cycling-power". Extends the configuration type of the adapter.
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** MAC addresses of the Cycling Power sensors whose measurements are subscribed over a gateway */
			cyclingPowerDevices?: string;
		}
	}
}
// Makes this file a module, so the declaration above extends the global type
export {};
