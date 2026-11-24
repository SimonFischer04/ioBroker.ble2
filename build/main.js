"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_message_handler = require("./api/message-handler");
var import_connection_manager = require("./connections/connection-manager");
var import_device_registry = require("./devices/device-registry");
var import_gateway_registry = require("./gateways/gateway-registry");
var import_global = require("./lib/global");
var import_object_cache = require("./lib/object-cache");
var import_plugins = __toESM(require("./plugins"));
var import_advertisement_processor = require("./scanner/advertisement-processor");
var import_service_filter = require("./scanner/service-filter");
var import_noble_local = require("./transports/noble-local");
var import_noble_remote = require("./transports/noble-remote");
var import_remote_gateway = require("./transports/remote-gateway");
var import_server_list = require("./transports/server-list");
let processor;
let gateways;
let remoteGateway;
let connections;
let handleMessage;
const transports = [];
const adapter = utils.adapter({
  name: "ble",
  ready: async () => {
    import_global.Global.adapter = adapter;
    import_global.Global.objectCache = new import_object_cache.ObjectCache(6e4);
    const epoch = Date.now();
    await import_global.Global.ensureInstanceObjects();
    const migration = (0, import_server_list.migrateServerSettings)(adapter.config);
    if (migration) {
      adapter.log.info(
        `Moving the remote scan server "${migration.remoteServers}" to the list of remote scan servers. The local Bluetooth adapter stays disabled as before.`
      );
      Object.assign(adapter.config, migration);
      try {
        await adapter.extendForeignObjectAsync(
          `system.adapter.${adapter.namespace}`,
          { native: migration }
        );
      } catch (e) {
        adapter.log.warn(
          `Could not save the migrated settings: ${e.message}`
        );
      }
    }
    import_global.Global.adapter.log.info(
      `loaded plugins: ${import_plugins.default.map((p) => p.name).join(", ")}`
    );
    const enabledPluginNames = (adapter.config.plugins || "").split(",").map((p) => p.trim().toLowerCase()).concat("_default");
    const enabledPlugins = import_plugins.default.filter(
      (p) => enabledPluginNames.indexOf(p.name.toLowerCase()) > -1
    );
    import_global.Global.adapter.log.info(
      `enabled plugins: ${enabledPlugins.map((p) => p.name).join(", ")}`
    );
    let services = [];
    if (adapter.config.services === "*") {
      import_global.Global.adapter.log.info(`monitoring all services`);
    } else {
      services = (adapter.config.services || "").split(",").concat(...enabledPlugins.map((p) => p.advertisedServices)).reduce((acc, s) => acc.concat(s), []).map((s) => (0, import_service_filter.fixServiceName)(s)).filter((s) => s !== "").reduce((acc, s) => {
        if (acc.indexOf(s) === -1)
          acc.push(s);
        return acc;
      }, []);
      import_global.Global.adapter.log.info(`monitored services: ${services.join(", ")}`);
    }
    let rssiUpdateInterval = 0;
    if (adapter.config.rssiThrottle != null) {
      rssiUpdateInterval = Math.max(
        0,
        Math.min(1e4, adapter.config.rssiThrottle)
      );
    }
    const gatewayTimeout = typeof adapter.config.gatewayTimeout === "number" && adapter.config.gatewayTimeout > 0 ? adapter.config.gatewayTimeout : 60;
    gateways = new import_gateway_registry.GatewayRegistry(adapter, {
      remoteTimeoutMs: gatewayTimeout * 1e3
    });
    await gateways.init();
    const devices = new import_device_registry.DeviceRegistry();
    processor = new import_advertisement_processor.AdvertisementProcessor(
      {
        plugins: enabledPlugins,
        allowEmptyDevices: !!adapter.config.allowEmptyDevices,
        rssiUpdateInterval
      },
      devices,
      gateways
    );
    const handleAdvertisement = (peripheral) => {
      processor.process(peripheral).catch((e) => {
        adapter.log.error(
          `Could not handle the advertisement of ${peripheral.address}: ${e.message}`
        );
      });
    };
    const transportContext = {
      adapter,
      gateways,
      onAdvertisement: handleAdvertisement
    };
    adapter.subscribeStates("*");
    adapter.subscribeObjects("*");
    await adapter.setStateAsync("options.allowNewDevices", false, true);
    const filteredContext = {
      ...transportContext,
      onAdvertisement: (peripheral) => {
        devices.track(peripheral);
        if ((0, import_service_filter.matchesServiceFilter)(peripheral, services)) {
          handleAdvertisement(peripheral);
        }
      }
    };
    remoteGateway = new import_remote_gateway.RemoteGatewayTransport(filteredContext, epoch);
    transports.push(remoteGateway);
    gateways.onGatewayOffline = (gatewayId) => remoteGateway == null ? void 0 : remoteGateway.gatewayOffline(gatewayId);
    connections = new import_connection_manager.ConnectionManager({
      log: adapter.log,
      devices,
      gateways,
      provider: remoteGateway,
      setTimeout: (callback, ms) => adapter.setTimeout(callback, ms),
      clearTimeout: (timer) => adapter.clearTimeout(timer)
    });
    handleMessage = (0, import_message_handler.createMessageHandler)({
      adapter,
      gateways,
      devices,
      remoteGateway,
      connections
    });
    const useLocalScanner = adapter.config.localScanner !== false;
    const { servers, invalid } = (0, import_server_list.parseServerList)(
      adapter.config.remoteServers
    );
    for (const entry of invalid) {
      adapter.log.warn(
        `Ignoring the invalid remote scan server "${entry}", expected host or host:port`
      );
    }
    if (useLocalScanner) {
      transports.push(
        new import_noble_local.NobleLocalTransport(transportContext, {
          services,
          hciDevice: adapter.config.hciDevice
        })
      );
    }
    for (const server of servers) {
      transports.push(
        new import_noble_remote.NobleRemoteTransport(filteredContext, server, {
          reportDriverState: !useLocalScanner && servers.length === 1
        })
      );
    }
    if (!useLocalScanner && servers.length === 0) {
      adapter.log.info(
        "The local Bluetooth adapter is not used, waiting for advertisements from external gateways"
      );
    }
    for (const transport of transports)
      transport.start();
  },
  unload: (callback) => {
    try {
      connections == null ? void 0 : connections.dispose();
      for (const transport of transports)
        transport.stop();
      processor == null ? void 0 : processor.dispose();
      gateways == null ? void 0 : gateways.dispose();
    } catch {
    }
    callback();
  },
  objectChange: (id, obj) => {
    if (!!obj) {
      import_global.Global.objectCache.updateObject(obj);
    } else {
      import_global.Global.objectCache.invalidateObject(id);
    }
  },
  stateChange: (id, state) => {
    if (/options\.allowNewDevices$/.test(id) && id.startsWith(adapter.namespace) && state != void 0 && !state.ack) {
      if (typeof state.val === "boolean") {
        import_global.Global.adapter.setState(id, state.val, true);
        processor == null ? void 0 : processor.setAllowNewDevices(state.val);
      }
      return;
    }
    remoteGateway == null ? void 0 : remoteGateway.handleStateChange(id, state);
  },
  message: (obj) => {
    if (handleMessage) {
      handleMessage(obj);
    } else if (obj == null ? void 0 : obj.callback) {
      adapter.sendTo(
        obj.from,
        obj.command,
        { error: "The adapter is not ready yet" },
        obj.callback
      );
    }
  }
});
//# sourceMappingURL=main.js.map
