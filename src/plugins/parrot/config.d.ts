// Settings of the plugin "parrot". Extends the configuration type of the adapter.
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** MAC addresses of the Parrot Flower Power sensors that are read over a gateway */
			flowerPowerDevices?: string;
		}
	}
}
// Makes this file a module, so the declaration above extends the global type
export {};
