# <img src="admin/ble2.png" height="48" /> ioBroker.ble2

[![Test and Release](https://github.com/SimonFischer04/ioBroker.ble2/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/SimonFischer04/ioBroker.ble2/actions/workflows/test-and-release.yml)
[![npm version](https://img.shields.io/npm/v/iobroker.ble2.svg)](https://www.npmjs.com/package/iobroker.ble2)

This is SimonFischer04's maintained fork of [ioBroker.ble](https://github.com/AlCalzone/ioBroker.ble), published independently as `iobroker.ble2`. The original authors and MIT license are retained.

Monitor Bluetooth Low Energy (BLE) beacons and record their information. 
Currently, only recording *advertised* service data is supported. You can monitor which services are advertised by using the nRF Connect app (service data UUIDs).
Connecting and reading/writing service chararcteristics will be supported in a future version.

## Installation

Requires Node.js 22.19 or newer, js-controller 7.2.2 or newer, and admin 7.6.20 or newer.

![Number of Installations](http://iobroker.live/badges/ble2-installed.svg?break_cache=1) ![Number of Installations](http://iobroker.live/badges/ble2-stable.svg?break_cache=1)

This adapter needs additional libraries to compile. See https://github.com/sandeepmistry/noble#prerequisites for detailed instructions.
On Raspberry Pi and similar, this should do it: `sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev libcap2-bin`

If the adapter starts but won't connect to your bluetooth hardware, please check the `info.driverState` state in ioBroker. If it is `unauthorized`, you need to give `node` additional permissions. For Linux, this is as simple as
```bash
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
```
which requires `libcap2-bin` to be installed.

If `info.driverState` is `driverError`, check the instance log for the scanner's Node.js version, OS, architecture, and load error. A missing native file or a `NODE_MODULE_VERSION` mismatch indicates a driver built for a different environment or an incomplete installation. On Linux, install the packages above and reinstall the `ble2` adapter through ioBroker using the Node.js installation that runs js-controller. A standalone scanner prints the same diagnosis to stderr.

## Configuration

**Reset RSSI after inactivity [s]** sets a device's `rssi` to `0` after the configured time without an advertisement. A fresh advertisement restores the measured value. Use a timeout longer than the device's normal advertising interval. The default `0` disables the reset.

Select the local Bluetooth adapter by its HCI name and bus type, such as `hci0 (USB)`. If the list is unavailable, enter the index manually using the number after `hci`.
In the textbox below, enter all UUIDs of the advertised services you want to record (as found in the nRF Connect app).

### Moving from ble to ble2

Install `iobroker.ble2` and create a new `ble2` instance. Copy your settings from the old `ble` instance. If both instances use the same Bluetooth device or remote scanner, disable the old instance before starting the new one.

The new adapter creates its own objects and states under `ble2.<instance>.*`. Existing `ble.<instance>.*` objects and history are not renamed or deleted. Enable **Accept new devices** in the new instance to discover your sensors, then update scripts, aliases, and dashboards to use the new state IDs.

Remote scanner command-line flags and the TCP protocol are unchanged. For scanner configuration supplied through environment variables, rename the `IOB_BLE_` prefix to `IOB_BLE2_`.

### Periodic scans

Set **Local scan interval [min]** and **Local scan duration [s]** to leave the Bluetooth adapter idle between scan windows. The first scan starts immediately. The duration must be shorter than the interval. An interval of `0` keeps continuous scanning. The scanner's connection indicator follows the active scan windows. On a standalone remote scanner, use `--scanInterval` and `--scanDuration`, both in seconds.

### Running without Bluetooth hardware
The Bluetooth adapter of the host is optional. Disable **Use the Bluetooth adapter of this host** in the settings to run the adapter as a hub that only handles the advertisements other adapters deliver (see below). In this mode the Bluetooth driver is not loaded, so neither Bluetooth hardware, nor the `setcap` command above, nor host mode networking in Docker are needed.

If the option is enabled but the Bluetooth adapter cannot be used (no hardware, missing permissions, driver not installed), the adapter logs an error and keeps running, so it can still receive advertisements from other adapters.

### Remote scan servers
A Linux computer with Bluetooth in another room, e.g. a Raspberry Pi, can scan for the adapter. It runs the scanner of this adapter as a small server, `bin/blerp.js`, without ioBroker:

```bash
mkdir blerp && cd blerp
# Run npm run build:server in the source checkout, then copy bin/blerp.js here.
npm install @stoprocent/noble
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
node blerp.js --listenPort 8734 --hciDevice 0
```

Enter it under **Remote scan servers** in the settings as `host` or `host:port` (default port 8734), one per line. Several servers can be used at the same time, together with the Bluetooth adapter of the ioBroker host and with other adapters that deliver advertisements. Every server is a gateway of its own (`server:<host>:<port>`): a packet that several of them receive is decoded once, and when a server is unreachable the adapter tries again every 10 seconds.

Things to know:
* A server serves one adapter instance at a time.
* The connection is neither authenticated nor encrypted. Only use it in a network you trust, and do not make the port reachable from outside.
* The servers only receive advertisements, they cannot connect to devices.
* The monitored services and plugin manufacturer IDs also apply to what the servers deliver. On the server, `--services` and `--manufacturerIds` can reduce traffic.
* `info.driverState` shows the state of the Bluetooth driver of the local Bluetooth adapter, or of the server if it is the only source.

Up to version 0.14 there was a single server (setting "Use remote server"), which disabled the Bluetooth adapter of the host. Such a configuration is moved to the new setting when the adapter starts, and the Bluetooth adapter of the host stays disabled.

## Receiving advertisements from other adapters
Other adapters can deliver the BLE advertisements they receive, e.g. from ESPHome Bluetooth proxies distributed in the house. They are handled exactly like the ones received by the local Bluetooth adapter: the same plugins, the same objects and states. The device ID is the MAC address in lowercase, no matter which receiver delivered the advertisement.

```js
const response = await adapter.sendToAsync("ble2.0", "gateway:advertisements", {
	// Identifies the receiver within the sending instance
	gatewayId: "proxy-og",
	items: [
		{
			address: "a4:c1:38:12:34:56",
			rssi: -67,
			// The raw payload of the advertisement (the AD structures), base64 encoded
			data: "AgEGDhbS/EAApQFkAsQJA78T",
			// optional: addressType ("public" | "random"), connectable
		},
	],
});
// => { error: null, result: { accepted: 1, rejected: 0 } }
// or { error: { code: "INVALID_PAYLOAD", message: "..." } }
```

* There is no registration. A gateway is created with the first message, its ID is `<sender>:<gatewayId>`, e.g. `esphome.0:proxy-og`.
* Deliver the advertisements in batches (at most 500 per message), a few times per second at most.
* A gateway is offline when it delivered nothing for 60 seconds, or when the delivering instance is stopped. An empty batch is enough to keep it online.
* When several gateways receive the same packet, it is decoded once. The `rssi` state of a device is the signal strength measured by the gateway that receives it best.
* The monitored services from the settings also apply to delivered advertisements, and new devices are only recorded while **Accept new devices** is enabled.

The types of the interface are defined in [`src/lib/gateway-protocol.ts`](src/lib/gateway-protocol.ts). The file has no dependencies and can be copied.

| Command | Result |
|---|---|
| `gateway:advertisements` | Delivers advertisements, see above |
| `gateway:announce` | Announces gateways that can connect to devices, see below |
| `getGateways` | All sources of advertisements: `[{ id, type, sender, connected, lastAdvertisement, advertisements, duplicates, connect, freeSlots, slotLimit, features }]` |
| `getDevices` | The devices received in the last 10 minutes: `[{ address, name, gateways: [{ id, rssi, lastSeen }] }]`, strongest gateway first |
| `discoverServices` | `{ address }` → `{ services: [{ uuid, handle, characteristics: [{ uuid, handle, properties, descriptors }] }] }` |
| `readCharacteristic` | `{ address, service, characteristic }` → `{ data }` (base64) |
| `writeCharacteristic` | `{ address, service, characteristic, data, withResponse? }` → `{}`. `withResponse` defaults to `true` |

For every gateway the states `gateways.<id>.connected` and `gateways.<id>.lastAdvertisement` are created, for gateways that can connect also `gateways.<id>.freeSlots`. `info.connection` is `true` while at least one source of advertisements is active.

### Connecting to devices
`discoverServices`, `readCharacteristic` and `writeCharacteristic` connect to a device, do their work and disconnect again. UUIDs can be given short (`"1f10"`, `"0x1F10"`) or in full, with or without dashes. The adapter connects through the gateway that receives the device best and can connect, tries the next one if that fails, and runs only one request per device at a time. Errors come as `{ error: { code, message } }`, e.g. `NO_GATEWAY` when no gateway that can connect receives the device.

So far, only gateways of other adapters can connect, e.g. ESPHome Bluetooth proxies through ioBroker.esphome, not the Bluetooth adapter of the host or the remote scan servers.

An adapter that provides such gateways announces them with `gateway:announce` (`{ protocol: "ble-gateway/1", gateways: [{ gatewayId, connect: true, freeSlots, slotLimit, features }] }`). `features` lists optional commands, so far `"writeSequence"`: `gatt:writeSequence` writes up to 64 values to one handle and reads it afterwards, the firmware update needs it. The providing adapter answers the `gatt:*` commands this adapter sends to it and reports ended connections and notifications with `gateway:connectionState` and `gateway:notification`. The details are in [`docs/spec-phase-2-gatt.md`](docs/spec-phase-2-gatt.md), part A, for `gatt:writeSequence` in [`docs/spec-phase-4-pvvx-ota.md`](docs/spec-phase-4-pvvx-ota.md), part A, and the types in `src/lib/gateway-protocol.ts`.

## Reading the Mi Flora battery level

Enter the addresses of your Mi Flora sensors in **Mi Flora battery polling (MAC addresses)**. When a connection-capable gateway sees a configured plant, the adapter reads its battery level and writes `<mac>.battery`. The first reading is due immediately. After a successful read, another is due the next day. A failed read can be retried after 15 minutes when the gateway sees the sensor again.

## Reading Parrot Flower Power sensors

Enter your sensor addresses in **Parrot Flower Power sensors (MAC addresses)**. When a connection-capable gateway receives an advertisement from a configured sensor, the adapter reads the available calibrated moisture, air temperature, sunlight and battery characteristics. The first reading is due immediately. Further readings are due every 15 minutes, or after one minute following an unsuccessful read. The firmware must expose the calibrated Flower Power Live service for the plant measurements.

## Reading a Comet Blue thermostat

Use `sendToAsync("ble2.0", "readCometBlue", { address, pin })` with the thermostat's Bluetooth MAC address and its PIN as a string. A connecting gateway must be in range. The command returns the ambient temperature, manual, eco and comfort setpoints in °C, and a battery percentage when the device provides it. It authenticates using the supplied PIN for the current session.

## Controlling a SwitchBot Bot

Use the `switchBot` command to press, switch on, switch off, or stop a SwitchBot Bot that a connection-capable gateway can reach. The supported actions are `press`, `on`, `off`, and `stop`. This command uses the standard unencrypted Bot protocol.

```js
const result = await adapter.sendToAsync("ble2.0", "switchBot", {
    address: "aa:bb:cc:dd:ee:ff",
    action: "press",
});
```

A successful reply contains `{ error: null, result: {} }` after the Bot confirms the action. Rejection and timeout return a gateway error. For protected or other devices, the gateway interface also provides generic `discoverServices`, `readCharacteristic`, and `writeCharacteristic` commands.

## Setting the clock of pvvx thermometers
Thermometers with the [pvvx firmware](https://github.com/pvvx/ATC_MiThermometer) (e.g. Xiaomi LYWSD03MMC) have a clock that drifts and does not know summer time. The adapter can set it to the local time of the ioBroker host, through a gateway that can connect, e.g. an ESPHome Bluetooth proxy with `bluetooth_proxy: active: true` and ioBroker.esphome.

* **pvvx thermometers (MAC addresses):** the devices whose clock is set, separated by commas, spaces or line breaks.
* **Time sync interval [h]:** hours between two syncs of a device, default 24. `0` = only at start, after a change between summer and winter time and with the button.

The clock is set one minute after the start, in the interval, within two minutes after each change between summer and winter time and with the button. When a device cannot be reached, it is tried again after 5, 15 and 60 minutes, then in the normal interval. One device is synced at a time.

For every device these states are created below `<mac>.pvvx`:

| State | Content |
|---|---|
| `syncTime` | Button: sets the clock now |
| `lastTimeSync` | When the clock was set last |
| `timeDeviation` | How far the clock was off before it was set, in seconds. Positive = it was ahead |
| `firmwareVersion` | Version of the firmware, e.g. `5.9` |
| `hardwareId` | Hardware ID the firmware reports |
| `lastError` | Empty after a successful sync, otherwise `<CODE>: <message>`, e.g. `NO_GATEWAY: ...` |

The device must be received by a gateway that can connect. Devices protected with a PIN code are not supported.

## Setting the Xiaomi LYWSD02 clock

After a connection-capable gateway has seen the thermometer, call
`sendTo("ble2.0", "syncLywsd02Clock", { address: "AA:BB:CC:11:22:33" }, callback)`
to set the factory firmware clock from the adapter host. On success,
`<mac>.lywsd02LastTimeSync` stores the timestamp in milliseconds. Call the same command
from a scheduled ioBroker JavaScript script to update the clock periodically.

LYWSD02 firmware stores the time zone as a whole-hour UTC offset.

## Updating the firmware of pvvx thermometers
The adapter can also install a newer [pvvx firmware](https://github.com/pvvx/ATC_MiThermometer) on the thermometers configured above, through a gateway. **A firmware update is done at your own risk.** According to pvvx, an interrupted update leaves the old firmware in place, but nobody can guarantee that for every device.

* Once a day (setting **Check daily for new pvvx firmware**, on by default) and with the button `pvvx.checkFirmware`, the adapter looks up the newest firmware in [`firmware.json`](https://github.com/pvvx/ATC_MiThermometer/blob/master/firmware.json) of the pvvx repository on GitHub and shows it in `<mac>.pvvx.firmwareAvailable`. This needs the version and hardware ID from a time sync. Nothing is installed by this check.
* `<mac>.pvvx.firmwareUpdate` installs it on one device, `pvvx.updateAll` on all devices with a newer firmware, one after the other.
* Only the BLE firmware of pvvx for the hardware ID the device reports is installed, never the original firmware of the manufacturer, never an older or the same version, and no image over 128 KiB.

Before an update the adapter checks:

* a gateway that supports firmware updates receives the device (`features: ["writeSequence"]`, e.g. ESPHome Bluetooth proxies with a current ioBroker.esphome),
* with at least −80 dBm,
* the battery is at 40 % or more, read from `<mac>.battery`. The device must send its battery level, e.g. in the BTHome format.

An update takes a few minutes. The states below `<mac>.pvvx`:

| State | Content |
|---|---|
| `firmwareAvailable` | Newer version that can be installed, e.g. `6.0`. Empty if there is none |
| `firmwareUpdate` | Button: installs it |
| `firmwareProgress` | Progress in % |
| `firmwareStatus` | `idle`, `queued`, `checking`, `transferring`, `verifying`, `done` or `failed` |
| `firmwareError` | Empty after a successful update, otherwise `<CODE>: <message>`, e.g. `BATTERY_LOW: ...` |

After the update the adapter connects again, checks the new version and sets the clock. A failed update is not repeated automatically. Devices with a PIN code are not supported.

## Plugin system
Build the adapter from source with `npm ci` followed by `npm run build`. The generated backend `build/` directory is not tracked in Git. Published npm packages include the generated files; installation directly from Git is disabled with `common.nogit`.

For a standalone remote scanner, `npm run build:server` generates `bin/blerp.js`. This generated bundle is also ignored by Git; it loads the installed `@stoprocent/noble` driver at runtime.

The admin interface is provided by ioBroker JSONConfig (`admin/jsonConfig.json`) and requires admin 7.6.20 or newer. The optional Bluetooth device map is built with the adapter. **Accept new devices** controls the live `options.allowNewDevices` state and resets after five minutes.

Choose one or more entries from the **Active plugins** dropdown. Existing plugin settings are loaded automatically; the basic advertisement handler stays enabled even when no plugin is selected.

Add a device's MAC address to **Presence tracking** to create a boolean `present` state for that recorded device. Each advertisement adds a point to a score. The score loses one point for each elapsed share of the decay time. Presence becomes true at the configured packet count and returns to false when the score reaches zero. The defaults are three packets and 60 seconds for a full score to decay.

Run `npm run lint` to check the adapter, tests, and JavaScript helpers using the shared ioBroker ESLint configuration. Use `npm run lint -- --fix` to apply automatic fixes.

The adapter supports extension via plugins. Those define which advertised services should be listened to and how to translate the data. The plugin structure is defined in https://github.com/SimonFischer04/ioBroker.ble2/blob/master/src/plugins/plugin.ts and an example of a working plugin is defined here https://github.com/SimonFischer04/ioBroker.ble2/blob/master/src/plugins/_default.ts

Plugins can also declare `manufacturerIds`, an optional list of Bluetooth company identifiers, to receive manufacturer data from devices that do not advertise a matching service. The Ruuvi Tag plugin uses company identifier `0x0499`. When running a remote scanner, include `--manufacturerIds 1177` alongside its service filters to receive these packets.

If you have any device transmitting specially encoded information via advertisements, feel free to create a PR with a new plugin for that.

### Supported plugins
* `"xiaomi"`: All xiaomi bluetooth sensors, including 
  * [Flower Care plant sensor](https://xiaomi-mi.com/sockets-and-sensors/xiaomi-huahuacaocao-flower-care-smart-monitor/)
  * [Mijia Temperature and Humidity sensor](https://www.banggood.com/Xiaomi-Mijia-Bluetooth-Thermometer-Hygrometer-with-LCD-Screen-Magnetic-Suction-Wall-Stickers-p-1232396.html?cur_warehouse=USA)
  * [Mosquito Repellent](https://www.aliexpress.com/item/32883859984.html)
* `"mi-flora"`: Original plugin for the flower care plant sensor, now aliased to `"xiaomi"`
* `"eddystone"`: Eddystone UID, URL, and EID identifiers and unencrypted telemetry (`feaa`).
* `"ruuvi-tag"`: [Ruuvi Tag](https://tag.ruuvi.com/) multisensor with firmware versions v1 and v2. **Untested, please give feedback!** 
* `"atc"`: Temperature, humidity, battery level, and voltage from unencrypted ATC1441 and PVVX Custom advertisements (`181a`).
* `"magicswitchbot"`: Battery level and password status from MagicSwitchBot advertisements. For remote scanners with filters, include manufacturer ID 1282.
* `"switchbot"`: SwitchBot Meter-family temperature, humidity, and battery advertisements (`fd3d` or `0d00`).
* `"bthome"`: Sensors using [BTHome v2](https://bthome.io), including encrypted advertisements.
* `"mi-scale"`: Mi Scale V1 and V2 broadcast weight in kilograms and a stabilized flag (`181d` and `181b`).
* `"govee"`: Govee H5072 and H5075 temperature, humidity, and battery from EC88 manufacturer data.
* `"mopeka"`: Mopeka Pro Check LPG tank sensors (standard sensor type `0x03`).

For an encrypted BTHome sensor, select **BTHome** under **Active plugins** and add its Bluetooth MAC address and bindkey under **BTHome bindkeys**. Enter the 16-byte key as 32 hexadecimal digits or in UUID format. Enable **Accept new devices** when adding a new sensor. A remote scanner using service filters must forward service `fcd2`. Decryption requires the actual Bluetooth MAC address, which some local scanners (such as macOS CoreBluetooth) do not expose.

ioBroker encrypts the bindkeys in the instance configuration. JSON configuration exports from Admin contain the keys in plaintext.

For a device with a bindkey, measurement and event updates require an authenticated BTHome packet with a counter greater than the last accepted counter. The adapter keeps these counters in memory. If a sensor resets its counter, restart the adapter instance to start tracking it again.

To read authenticated Xiaomi MiBeacon v4 or v5 advertisements, enable **Xiaomi** and add the device's Bluetooth MAC address and 32-digit hexadecimal bindkey under **Xiaomi MiBeacon bindkeys**. Use the bindkey assigned when the sensor was paired or configured. ioBroker encrypts the stored configuration. Admin configuration exports include the bindkeys.

For MiBeacon v2 or v3 thermometers, use a 24-digit Xiaomi bindkey. These firmware versions send encrypted readings without an authentication tag. The adapter checks the packet structure and accepts only temperature, humidity, and battery readings within their normal ranges.

The original LYWSD02 alarm clock broadcasts temperature and humidity using the **Xiaomi** plugin. A packet can carry just one measurement. Wait for subsequent packets for the other values.

The Xiaomi Door and Window Sensor 2 (MCCGQ02HL) publishes `contactOpen` and `doorLeftOpen` from contact events. Configure its bindkey to decode encrypted broadcasts. A status-only packet does not carry the door state.

With pvvx firmware, choose **ATC1441** or **PVVX (Custom)** in the firmware settings and enable **ATC1441 and PVVX** in the adapter. These formats carry temperature, humidity, and battery in the same packet. The scanner must expose the Bluetooth MAC address and forward `181a` service data. The **Xiaomi** plugin remains available for MiBeacon mode, where a battery packet may arrive separately from temperature and humidity.

For a Govee H5072 or H5075, enable **Govee H5072/H5075** under **Active plugins**. The scanner must deliver the `EC88` manufacturer data containing the measurements. The separate Apple iBeacon block beginning with `4c000215` contains no Govee sensor readings. A gateway that forwards the raw advertisement and scan response preserves separate manufacturer data blocks. For devices handled by the default decoder, `services.manufacturerDataBlocks` lists those blocks as a JSON array of hexadecimal strings. A local Noble backend may supply only the last block. For a supported remote scanner with service filters, forward service `ec88` or add `--manufacturerIds 60552`.

For Mopeka, add `mopeka` to **Active plugins** and enable **Accept new devices** while discovering the sensor. Local scanning includes its manufacturer identifier automatically. A remote scanner with service filters also needs `--manufacturerIds 89` to forward manufacturer-only advertisements.

The plugin creates `mopeka_level_raw` (uncalibrated ultrasonic reading), `mopeka_temperature` (°C), `mopeka_battery_v` (V), `mopeka_battery_percent` (CR2032 estimate), and `mopeka_reading_quality` (0: no valid echo, 1: low, 2: medium, 3: high). A reading with quality 0 clears the raw level to `null`; battery and temperature still update. Converting the raw reading to fill percentage, volume, or weight requires calibration for the tank and its contents.

The standard Pro Check layout is verified against [ESPHome](https://github.com/esphome/esphome/blob/dev/esphome/components/mopeka_pro_check/mopeka_pro_check.cpp) and [mopeka-iot-ble](https://github.com/Bluetooth-Devices/mopeka-iot-ble/blob/main/src/mopeka_iot_ble/parser.py). Other Mopeka sensor types are not handled by this plugin.

#### Xiaomi LYWSD03MMC temperature and humidity monitor

The stock firmware can send encrypted Xiaomi measurements. For passive readings with ble2, use compatible custom firmware configured for unencrypted BTHome v2.

1. Check the sensor's hardware revision against the [pvvx ATC_MiThermometer device list](https://github.com/pvvx/ATC_MiThermometer). Follow the firmware project's instructions for that revision, including any special steps for the first update.
2. On a device with Bluetooth, open [TelinkMiFlasher](https://pvvx.github.io/ATC_MiThermometer/TelinkMiFlasher.html) in a Web Bluetooth browser. Connect to the thermometer and follow the [firmware update instructions](https://github.com/pvvx/ATC_MiThermometer#flashing-or-updating-the-firmware-ota).
3. Reconnect in the flasher after the sensor restarts. Set the advertising type to **BTHome v2**, leave advertising encryption disabled, and save the settings.
4. In the ble2 instance settings, enable **BTHome** under **Active plugins** and save. Turn on **Accept new devices** and wait for the sensor's next advertisement. ble2 creates the temperature, humidity, and battery states under the device's Bluetooth address as the readings arrive.

Keep the sensor near the scanner during discovery. If you run a remote scanner with an explicit service filter, include `fcd2` so BTHome advertisements reach the adapter.

## Publishing releases

The npm package is `iobroker.ble2`; its ioBroker adapter name is `ble2`. The GitHub repository is `SimonFischer04/ioBroker.ble2`.

For the first publication of this new package, sign in to npm with your own account and build and verify the package locally:

```sh
npm login
npm ci
npm run build
npm test
npm run test:integration
npm publish --access public
```

This creates `iobroker.ble2` under the publishing account. Publishing a new package is subject to npm's package-name availability checks; no access to `iobroker.ble` is required.

After that initial publication, configure a GitHub Actions trusted publisher in the npm settings for `iobroker.ble2`. Subsequent releases use [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) through `ioBroker/testing-action-deploy@v1`:

| npm setting | Value for this fork |
| --- | --- |
| Organization or user | `SimonFischer04` |
| Repository | `ioBroker.ble2` |
| Workflow filename | `test-and-release.yml` |
| Environment | Leave blank |

The npm account configuring this must have publish rights for `iobroker.ble2`. The package's `repository.url` must match the repository running the release workflow; update both the npm publisher settings and this field if publishing from another repository.

For an intended release, update `package.json` and `io-package.json` to the new version, merge the release changes, and push the matching `v<version>` tag to run the checks, build, and publish jobs. The Git tag does not rewrite the version in these files. Use `npm version <version> --no-git-tag-version` to update `package.json` and `package-lock.json`, then set `common.version` in `io-package.json` to the same value before committing. Each npm version must be new; changing the npm dist-tag does not allow an existing version to be published again. The deploy action uses Node.js 24 and updates npm to version 11 for OIDC authentication. It builds the adapter before publication and includes JSONConfig and its translations in the npm package. Pre-release tags such as `v1.0.0-beta.0` publish under the npm `next` dist-tag.

No `NPM_TOKEN` secret is needed. The deploy job has `id-token: write` for npm authentication and `contents: write` for creating the GitHub release. Pull requests run the checks and tests and skip publishing. Verify the first intended release succeeds before removing any old npm publish token.

## Changelog
<!--
	Placeholder for next release:
	### __WORK IN PROGRESS__
* **BREAKING:** Require js-controller 7.2.2 or newer; update adapter-core and release tools, repository metadata, and Dependabot configuration.
-->
### __WORK IN PROGRESS__
* Read Mi Flora battery levels through a connecting gateway.
* Read calibrated Parrot Flower Power data through a connecting gateway.
* Read protected temperature and battery data from Comet Blue thermostats.
* Add the SwitchBot Bot `switchBot` command for external GATT gateways.
* Other adapters can deliver BLE advertisements they received, e.g. from ESPHome Bluetooth proxies (`gateway:advertisements`). Several receivers can be used at the same time.
* The adapter can run without Bluetooth hardware: the Bluetooth adapter of the host can be disabled in the settings, and the Bluetooth driver is an optional dependency now
* A problem with the Bluetooth adapter of the host no longer terminates the adapter
* Several remote scan servers (`bin/blerp.js`) can be used at the same time, together with the Bluetooth adapter of the host. The setting of version 0.14 is migrated, its behaviour stays the same.
* The connection to a remote scan server is re-established when it was lost, a server that is down is reported once instead of every 10 seconds
* The monitored services also apply to the advertisements of remote scan servers
* Connections to devices through gateways of other adapters, e.g. ESPHome Bluetooth proxies: `discoverServices`, `readCharacteristic` and `writeCharacteristic`
* The clock of pvvx thermometers can be set automatically through such gateways: at start, in an interval, after each change between summer and winter time and with a button. Firmware version, hardware ID and the deviation of the clock are shown
* Set the Xiaomi LYWSD02 factory firmware clock and record its last successful sync.
* Newer pvvx firmware can be installed on the thermometers through gateways that support it (`gatt:writeSequence`), after checks of battery and signal. The newest version is looked up once a day
* Support encrypted BTHome v2 advertisements with per-device bindkeys.
* Replace manual plugin names with a multi-select dropdown, preserving existing plugin settings.
* Add Mopeka Pro Check support with raw level, temperature, battery, and reading quality states.
* Replace the custom React settings page with responsive native JSONConfig (requires admin 7.6.20 or newer), preserving settings and the live discovery switch.
* **BREAKING:** Rename the maintained fork to `iobroker.ble2` with the `ble2` adapter namespace.
* **BREAKING:** Require Node.js 22.19 or newer; test Node.js 22, 24, and 26 on Linux, Windows, and macOS.
* Added BTHome signed counters, signed power, volume storage, and direction measurements.
* Fixed discovery and decoding of Ruuvi Tag manufacturer-only advertisements, including packets received after empty or unrelated frames.
* Preserve separate manufacturer data blocks in raw gateway advertisements and decode Govee readings alongside iBeacon data.
* Ignore invalid Mi Flora soil moisture readings above 100% to preserve the last valid measurement.

### 0.14.2-beta.1 (2026-11-21)
* Prepare a fresh prerelease version to verify npm Trusted Publishing.

### 0.14.1 (2025-02-09)
* Fixed compatibility issues with newer OS and Node.js versions (#874)

### 0.14.0 (2023-12-11)
* **BREAKING:** Dropped support for Node.js 16 and below
* Add support for the BTHome v2 protocol (unencrypted packets only)

### 0.13.4 (2023-07-06)
* Very experimental support for scanning on a remote host (#793)
* Another attempt at updating `noble`. Hopefully this version works now...

### 0.13.3 (2023-02-05)
* Updated `noble` again. This should fix the automatic rebuild after Node.js upgrades and the previous performance issues.

### 0.13.2 (2023-01-02)
* Downgraded the `noble` dependency again because of performance issues

### 0.13.1 (2022-12-19)
* Updated the `noble` dependency. This should fix the automatic rebuild after Node.js upgrades.

### 0.13.0 (2022-04-27)
* The option to allow recording new devices is now available in the config dialog. When the adapter starts, it will be disabled, and when enabled, it will be automatically disabled after 5 minutes (#730, #729)
* Fix: RSSI will now be updated, even if it was unchanged (#493)
* Dependency updates, lots of dependency updates...

Older entries are available in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License
The MIT License (MIT)

Copyright (c) 2026 SimonFischer04 <simi.fischa@gmail.com>; 2017-2025 AlCalzone <d.griesel@gmx.net>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
