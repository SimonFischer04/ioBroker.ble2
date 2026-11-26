import { federation } from "@module-federation/vite";
import { defineConfig } from "vite";

const entry = "./admin/src/BluetoothMap.tsx";

export default defineConfig({
	base: "./",
	plugins: [
		federation({
			name: "Ble2AdminComponents",
			filename: "customComponents.js",
			manifest: true,
			dts: false,
			exposes: { "./Components": entry },
			// Use Admin's React instance. The map uses React APIs shared by 18 and 19.
			shared: {
				react: {
					singleton: true,
					import: false,
					requiredVersion: ">=18.3 <20",
				},
			},
		}),
	],
	build: {
		target: "chrome89",
		outDir: "admin/build",
		rollupOptions: { input: entry },
	},
});
