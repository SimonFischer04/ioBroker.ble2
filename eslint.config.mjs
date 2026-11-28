import config, { reactConfig } from "@iobroker/eslint-config";

const [, jsdocOptions] = config.findLast(
	(entry) => entry.rules?.["jsdoc/require-jsdoc"],
).rules["jsdoc/require-jsdoc"];

export default [
	...config,
	{
		rules: {
			// Report missing docs without generating empty blocks during --fix.
			"jsdoc/require-jsdoc": [
				"warn",
				{ ...jsdocOptions, enableFixer: false },
			],
		},
	},
	{
		ignores: [
			"build/**",
			"admin/build/**",
			"bin/blerp.js",
			"coverage/**",
			".nyc_output/**",
			".dev-server/**",
		],
	},
	{
		languageOptions: {
			parserOptions: {
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	...reactConfig.map((entry) => ({
		...entry,
		files: ["admin/src/**/*.{ts,tsx}"],
	})),
	{
		files: ["**/*.test.ts"],
		// src/tsconfig.json deliberately excludes unit tests from compilation.
		languageOptions: {
			parserOptions: {
				projectService: false,
				project: "./tsconfig.json",
			},
		},
	},
	{
		files: ["**/*.test.ts", "test/mocks/**/*.ts"],
		rules: {
			"@typescript-eslint/explicit-function-return-type": "off",
			// Let fixture factories expose their inferred stub types.
			"@typescript-eslint/explicit-module-boundary-types": "off",
		},
	},
	{
		files: ["test/integrationTests/*.js"],
		languageOptions: {
			globals: {
				before: "readonly",
				beforeEach: "readonly",
				after: "readonly",
				it: "readonly",
			},
		},
	},
	{
		files: [
			"src/connections/connection-manager.test.ts",
			"src/transports/remote-gatt-link.test.ts",
		],
		rules: {
			// Async stubs implement promise-returning interfaces.
			"@typescript-eslint/require-await": "off",
		},
	},
	{
		files: ["**/*.ts"],
		rules: {
			// The adapter is compiled to CommonJS and uses typed import assignments.
			"@typescript-eslint/no-require-imports": [
				"error",
				{ allowAsImport: true },
			],
		},
	},
];
