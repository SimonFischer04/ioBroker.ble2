# AGENTS.md – ioBroker.ble2

Guide for AI coding agents working in this repository. Read it completely before changing anything.

## What this adapter does

It turns Bluetooth Low Energy advertisements into ioBroker objects and states. Advertisements come from several
sources ("gateways"): the Bluetooth adapter of the host, a remote scan server, and other adapters that deliver the
advertisements they received (e.g. ioBroker.esphome for ESPHome Bluetooth proxies). Decoder plugins (BTHome, Xiaomi,
RuuviTag, default) translate the payload into states.

The adapter is being extended into the central Bluetooth layer of ioBroker (connections to devices, device drivers).
That work is planned in `docs/`:

| Document                                | Content                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `docs/plan-bluetooth-infrastructure.md` | Architecture, decisions (E1 – E8) and the phases. German. Read sections 2 and 7 first. |
| `docs/spec-phase-2-gatt.md`             | Implementation specification of phase 2 (GATT connections). German. Follow it literally. |
| `docs/pvvx-protocol.md`                 | GATT protocol of the pvvx thermometer firmware (time, version, firmware update), with test vectors. German. |
| `docs/spec-phase-3-pvvx-time.md`        | Implementation specification of phase 3 (time sync of pvvx thermometers). German. Follow it literally. |
| `docs/spec-phase-4-pvvx-ota.md`          | Implementation specification of phase 4 (firmware update of pvvx thermometers, `gatt:writeSequence`), both repos. German. Follow it literally. |

**If you implement a phase, the specification of that phase is binding.** Where it does not answer a question, stop
and ask instead of guessing. Do not implement a phase that has no specification.

## Layout

```
src/main.ts                           wiring only: reads the config, creates the parts below, starts the transports
src/scanProcess.ts                    child process that runs the Bluetooth driver (noble). Nothing else may import noble.
src/lib/advertisement.ts              PeripheralInfo: the adapter's own model of a received advertisement
src/lib/ad-parser.ts                  parses raw advertisement payload (AD structures) into PeripheralInfo.advertisement
src/lib/gateway-protocol.ts           types of the gateway interface "ble-gateway/1". No imports, other adapters copy it.
src/lib/scanProcessInterface.ts       messages between main process and scanProcess
src/lib/iobroker-objects.ts           extendDevice / extendChannel / extendState
src/lib/object-cache.ts, global.ts    object cache and the global adapter reference (`Global as _`)
src/transports/transport.ts           Transport and TransportContext
src/transports/noble-local.ts         gateway "local": forks scanProcess
src/transports/noble-remote.ts        gateways "server:<host>:<port>": TCP client for a remote scanProcess (bin/blerp.js)
src/transports/server-list.ts         parses the setting remoteServers, migrates the setting `server` of 0.14
src/transports/remote-gateway.ts      gateways delivered by other adapters: validates "gateway:advertisements"
src/transports/scan-errors.ts         classifies errors of the Bluetooth driver
src/gateways/gateway-registry.ts      all gateways, whether they are active, states `gateways.*` and `info.connection`
src/devices/device-registry.ts        which gateway receives which device how well, deduplication across gateways
src/scanner/advertisement-processor.ts  advertisement -> plugin -> objects and states (the former onDiscover)
src/scanner/service-filter.ts         filter for the monitored services
src/connections/connection-manager.ts one job per device, gateway selection, time limit, always disconnects
src/connections/gatt-session.ts       UUIDs on top of a link; gatt-link.ts: GattLink and GattLinkProvider
src/connections/test-fakes.ts         FakeLink, FakeProvider for the unit tests (not used by the adapter)
src/transports/remote-gatt-link.ts    a link through a gateway of another adapter (gatt:* commands)
src/lib/uuid.ts, gateway-error.ts     normalizeUuid(), GatewayError / toErrorResponse()
src/lib/send-request.ts               sendTo with timeout and the answer format of the gateway interface
src/api/message-handler.ts            sendTo commands of the core; unknown commands go to the plugins
src/lib/plugin-host.ts                starts the active parts of the plugins, hands them advertisements, own state changes
                                      and their sendTo commands. The core knows no manufacturer.
src/lib/gatt-request.ts, device-list.ts  parseGattRequest() and parseDeviceList(), also for plugins
src/plugins/                          one plugin per manufacturer or device family (plugin.ts: the interface). A plugin
                                      has a decoder for advertisements and optionally an active part (start(): GATT,
                                      timers, buttons, commands). Both run only when the plugin is selected (setting
                                      plugins); an alias (mi-flora) shares the active part of its plugin. Plugins with an active part have their own folder:
                                      atc/ (decoder + pvvx/: time sync and firmware update of the pvvx firmware),
                                      xiaomi/ (Mi Flora battery, LYWSD02 clock), switchbot/, magicswitchbot/, parrot/,
                                      cycling-power/, comet-blue/, yeelight/, skyrc/. Their settings are typed in
                                      <folder>/config.d.ts. Do not change a decoder unless the task is about it.
admin/jsonConfig.json                 native settings UI, translations in admin/i18n
test/integration.js                   entry point of the integration tests
test/integrationTests/                integration suites, see below
```

Path of an advertisement: transport -> `GatewayRegistry.recordAdvertisements()` -> (service filter for delivered
advertisements) -> `AdvertisementProcessor.process()` -> `DeviceRegistry.observe()` (duplicate?) -> plugin -> states.

## Rules that are easy to break

- **Device IDs are MAC addresses in lowercase with colons** (`a4:c1:38:12:34:56`), also as object IDs. Existing
  installations depend on it. Use `normalizeAddress()` from `src/lib/advertisement.ts` for anything that comes from outside.
- **The decoder plugins get `PeripheralInfo` in the shape noble produces**: 16 bit UUIDs as 4 lowercase hex chars
  (`"fcd2"`), longer UUIDs as lowercase hex without dashes, `manufacturerData` including the two bytes of the company ID.
- **The main process must not load native code.** `@stoprocent/noble` is an optional dependency and is only required
  in `src/scanProcess.ts`. Type-only imports of noble are allowed there, nowhere else.
- **A problem with one gateway must not stop the adapter.** No `process.exit()`, no `adapter.terminate()` outside of
  the "rebuild required" case in `src/transports/noble-local.ts`.
- **`ble2` knows no other adapter.** No code that refers to ioBroker.esphome or any other adapter by name. Other
  adapters use the gateway interface.
- **`src/lib/gateway-protocol.ts` has no imports** and only additive changes within `ble-gateway/1`: do not rename or
  remove fields or commands, do not change the meaning of existing ones.
- **Answers to sendTo commands** of the gateway interface have the form `{ error: null, result }` or
  `{ error: { code, message } }`. `getHCIPorts` and unknown commands keep their old form.
- **Build output is generated.** Run `npm run build` after changing `src/`. The standalone scanner bundle is produced by
  `npm run build:server`.
- Tabs for indentation, formatted with prettier (`prettier.config.mjs`). Comments in English.
- New settings: `native` in `io-package.json`, `src/lib/adapter-config.d.ts`, and (if the user may change them)
  `admin/jsonConfig.json` and translations in `admin/i18n/`. Old instance configurations do not have the new key:
  code must treat a missing value like the default.

## Commands

```bash
npm ci                    # install
npm run check             # type check (tsc --noEmit)
npm run lint              # eslint over source and tests
npx prettier --check "src/**/*.ts" "test/integration.js" "test/integrationTests/*.js"
npm run build             # compiles src/ to build/
npm run test:unit           # unit tests, src/**/*.test.ts
npm run test:package      # package.json / io-package.json checks
npm run test:integration  # starts the built adapter in a test ioBroker installation (about 2 minutes)
```

All of them have to pass before a commit. Known pitfalls:

- **The integration tests run `build/`, not `src/`.** Run `npm run build` first.
- Set `TMPDIR` to a fresh temporary directory if you need an isolated ioBroker installation.
- The test scripts pass the pattern to mocha in quotes (`mocha "src/**/*.test.ts"`), so mocha finds tests at any
  depth. Without the quotes the shell expands `**` like `*` and tests two directories below `src/` silently do not run
  (that hid 15 decoder tests until November 2026). Keep the quotes.

## Tests

Unit tests live next to the code (`src/devices/device-registry.test.ts`), use `chai` (`expect`) and take the current
time as a parameter instead of faking timers.

Integration tests follow the structure of ioBroker.esphome: one file per scenario in `test/integrationTests/`, each
exports `runTests(suite)` and is registered in `test/integrationTests/index.js`. `helpers.js` has everything they share:

- `startAdapter(harness, native)` / `stopAdapter(harness)`. The local Bluetooth adapter is off unless the test says so.
- `deliver(harness, gatewayId, items)` delivers advertisements like another adapter does. The sender is `test.0`, so
  the gateway is called `test.0:<gatewayId>` and its states are in `gateways.test_0_<gatewayId>`.
- `PACKETS` are real advertisement payloads, `buildAdvertisement()` builds new ones.
- `sendToAdapter(harness, command, message)` sends a command and returns the answer. `getMessageClient(harness)`
  also answers the requests the adapter sends to `test.0` (`onRequest()`). Never use `harness.sendTo()` directly.
- `waitForValue()` / `waitFor()` poll. Do not use fixed delays to wait for something that can be polled.

A harness cannot start the adapter again after `stopAdapter()`. A scenario that needs its own configuration or a
restart gets its own `suite`. A suite must work without Bluetooth hardware and without any other adapter.

Every new behaviour needs a test that fails without the change. Tests assert concrete values (state values, exact
messages), not just "no error".

## Git

- Commit messages: `feat: …`, `fix: …`, `test: …`, `docs: …`, `chore: …`, in English, imperative.
- Changelog: add a line under `### __WORK IN PROGRESS__` in `README.md` for everything a user notices.
- Do not change the version number and do not edit `news` in `io-package.json`, the release script does that.
- This repository is a fork of `AlCalzone/ioBroker.ble`. Do not open pull requests against upstream.
