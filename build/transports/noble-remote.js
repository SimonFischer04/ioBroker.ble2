"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var noble_remote_exports = {};
__export(noble_remote_exports, {
  NobleRemoteTransport: () => NobleRemoteTransport
});
module.exports = __toCommonJS(noble_remote_exports);
var import_net = require("net");
var import_scanProcessInterface = require("../lib/scanProcessInterface");
const RECONNECT_INTERVAL_MS = 1e4;
class NobleRemoteTransport {
  constructor(ctx, server, options) {
    this.ctx = ctx;
    this.server = server;
    this.options = options;
    this.gateway = { id: server.gatewayId, type: "server" };
  }
  gateway;
  socket;
  stopped = false;
  reconnectTimer;
  failing = false;
  lastDriverState;
  get name() {
    return this.server.host.includes(":") ? `[${this.server.host}]:${this.server.port}` : `${this.server.host}:${this.server.port}`;
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  connect() {
    const { adapter, gateways } = this.ctx;
    const socket = new import_net.Socket();
    this.socket = socket;
    const reviver = (0, import_scanProcessInterface.getMessageReviver)(
      (message) => this.handleMessage(message)
    );
    let receiveBuffer = "";
    let connected = false;
    socket.on("close", () => {
      var _a;
      if (connected) {
        adapter.log.info(
          `Disconnected from BLE server ${this.name}`
        );
      }
      gateways.setConnected(this.gateway, false);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          (_a = this.options.reconnectIntervalMs) != null ? _a : RECONNECT_INTERVAL_MS
        );
      }
    }).on("error", (e) => {
      var _a;
      const message = `Connection to BLE server ${this.name} failed: ${e.message}`;
      if (this.failing) {
        adapter.log.debug(message);
      } else {
        adapter.log.warn(
          `${message}. Trying again every ${Math.round(
            ((_a = this.options.reconnectIntervalMs) != null ? _a : RECONNECT_INTERVAL_MS) / 1e3
          )} seconds.`
        );
        this.failing = true;
      }
    }).on("connect", () => {
      connected = true;
      this.failing = false;
      adapter.log.info(`Connected to BLE server ${this.name}`);
      gateways.setConnected(this.gateway, true);
    }).on("data", (data) => {
      receiveBuffer += data.toString();
      let newlineIndex;
      while ((newlineIndex = receiveBuffer.indexOf("\n")) > -1) {
        const line = receiveBuffer.slice(0, newlineIndex);
        receiveBuffer = receiveBuffer.slice(newlineIndex + 1);
        try {
          const msg = JSON.parse(line);
          reviver(msg);
        } catch (e) {
          adapter.log.debug(
            `Invalid message from BLE server ${this.name}: ${line}`
          );
        }
      }
    });
    adapter.log.debug(`connecting to BLE server ${this.name}...`);
    socket.connect({ host: this.server.host, port: this.server.port });
  }
  stop() {
    var _a;
    this.stopped = true;
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer);
    try {
      (_a = this.socket) == null ? void 0 : _a.destroy();
    } catch {
    }
  }
  handleMessage(message) {
    var _a;
    const { adapter, gateways } = this.ctx;
    switch (message.type) {
      case "connected":
        gateways.setConnected(this.gateway, true);
        break;
      case "disconnected":
        gateways.setConnected(this.gateway, false);
        break;
      case "discover":
        if (message.peripheral == null)
          break;
        gateways.recordAdvertisements(this.gateway, 1);
        this.ctx.onAdvertisement({
          ...message.peripheral,
          gatewayId: this.gateway.id
        });
        break;
      case "driverState":
        if (message.driverState !== this.lastDriverState) {
          this.lastDriverState = message.driverState;
          adapter.log.info(
            `Bluetooth driver of BLE server ${this.name} is ${message.driverState}`
          );
        }
        if (this.options.reportDriverState) {
          adapter.setState(
            "info.driverState",
            message.driverState,
            true
          );
        }
        break;
      case "error":
      case "fatal":
        adapter.log.error(
          `BLE server ${this.name}: ${message.error.message}`
        );
        break;
      case "log":
        adapter.log[(_a = message.level) != null ? _a : "info"](
          `BLE server ${this.name}: ${message.message}`
        );
        break;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NobleRemoteTransport
});
//# sourceMappingURL=noble-remote.js.map
