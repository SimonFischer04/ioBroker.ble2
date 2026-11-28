// Settings of the plugin "xiaomi". Extends the configuration type of the adapter.
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** MAC addresses of the Mi Flora sensors whose battery is read over a gateway */
			miFloraBatteryDevices?: string;
		}
	}
}
// Makes this file a module, so the declaration above extends the global type
export {};
