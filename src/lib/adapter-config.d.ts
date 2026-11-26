// This file extends the AdapterConfig type from "@types/iobroker"
// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			services: string;
			server: string;
			hciDevice: number | string;
			scanIntervalMinutes?: number;
			scanWindowSeconds?: number;
			plugins: string;
			xiaomiBindkeys?: string;
			bthomeBindkeys?: string;
			allowEmptyDevices: boolean;
			discoveryAllowlist?: string;
			presenceDevices?: {
				address: string;
				packets: number;
				absenceSeconds: number;
			}[];
			rssiThrottle: number;
			rssiTimeoutSeconds?: number;
		}
	}
}
// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
