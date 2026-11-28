// @ts-check

const gateway_advertisement_tests = require("./gateway_advertisement_tests");
const gateway_announce_tests = require("./gateway_announce_tests");
const magicswitchbot_action_tests = require("./magicswitchbot_action_tests");
const gateway_lifecycle_tests = require("./gateway_lifecycle_tests");
const candela_tests = require("./candela_tests");
const gatt_tests = require("./gatt_tests");
const lywsd02_clock_tests = require("./lywsd02_clock_tests");
const flower_power_tests = require("./flower_power_tests");
const comet_blue_tests = require("./comet_blue_tests");
const switchbot_tests = require("./switchbot_tests");
const cycling_power_tests = require("./cycling_power_tests");
const igrill_discovery_tests = require("./igrill_discovery_tests");
const hub_mode_tests = require("./hub_mode_tests");
const kettle_pro_tests = require("./kettle_pro_tests");
const mi_flora_battery_tests = require("./mi_flora_battery_tests");
const multi_gateway_tests = require("./multi_gateway_tests");
const skyrc_mc3000_tests = require("./skyrc_mc3000_tests");
const pvvx_ota_tests = require("./pvvx_ota_tests");
const pvvx_time_sync_tests = require("./pvvx_time_sync_tests");
const remote_server_tests = require("./remote_server_tests");

/** @import { IntegrationTestHarness } from "@iobroker/testing" */

// Every suite exports runTests(suite) and is registered here.
//
// All suites run always: they need neither Bluetooth hardware nor a second adapter. The
// advertisements are delivered the way another adapter does it, with sendTo, see helpers.js.
// A harness cannot start the adapter again after stopAdapter(), so every scenario that needs
// its own configuration gets its own suite.

/**
 * Defines all integration test suites
 *
 * @param {(name: string, fn: (getHarness: () => IntegrationTestHarness) => void) => void} suite - Defines a suite with a fresh harness
 */
exports.runTests = function (suite) {
	// The adapter without Bluetooth hardware and without the Bluetooth driver in use
	hub_mode_tests.runTests(suite);

	// Real packets of the supported devices, delivered by a gateway
	gateway_advertisement_tests.runTests(suite);
	igrill_discovery_tests.runTests(suite);

	// Several gateways receiving the same devices
	multi_gateway_tests.runTests(suite);

	// Gateways appearing, going offline and coming back
	gateway_lifecycle_tests.runTests(suite);
	magicswitchbot_action_tests.runTests(suite);

	// Gateways that can connect announcing themselves
	gateway_announce_tests.runTests(suite);

	// Connections to devices through gateways of other adapters
	gatt_tests.runTests(suite);
	mi_flora_battery_tests.runTests(suite);
	flower_power_tests.runTests(suite);
	comet_blue_tests.runTests(suite);
	kettle_pro_tests.runTests(suite);
	switchbot_tests.runTests(suite);
	cycling_power_tests.runTests(suite);
	candela_tests.runTests(suite);

	// Setting the clock of pvvx thermometers through a gateway
	pvvx_time_sync_tests.runTests(suite);
	lywsd02_clock_tests.runTests(suite);

	// Firmware updates of pvvx thermometers through a gateway
	pvvx_ota_tests.runTests(suite);

	// Remote scan servers (bin/blerp.js), played by a fake TCP server
	remote_server_tests.runTests(suite);
	skyrc_mc3000_tests.runTests(suite);
};
