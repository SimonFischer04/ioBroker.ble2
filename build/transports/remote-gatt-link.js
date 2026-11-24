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
var remote_gatt_link_exports = {};
__export(remote_gatt_link_exports, {
  GATT_TIMEOUTS_MS: () => GATT_TIMEOUTS_MS,
  RemoteGattLink: () => RemoteGattLink
});
module.exports = __toCommonJS(remote_gatt_link_exports);
var import_gateway_error = require("../lib/gateway-error");
var import_gateway_protocol = require("../lib/gateway-protocol");
var import_send_request = require("../lib/send-request");
const GATT_TIMEOUTS_MS = {
  connect: 25e3,
  disconnect: 1e4,
  getServices: 15e3,
  read: 1e4,
  write: 1e4,
  subscribe: 1e4
};
class RemoteGattLink {
  constructor(sender, log, gatewayId, instance, localGatewayId, address, mtu, onEnd) {
    this.sender = sender;
    this.log = log;
    this.gatewayId = gatewayId;
    this.instance = instance;
    this.localGatewayId = localGatewayId;
    this.address = address;
    this.mtu = mtu;
    this.onEnd = onEnd;
  }
  ended = false;
  pending = /* @__PURE__ */ new Set();
  listeners = /* @__PURE__ */ new Map();
  disconnectListeners = [];
  notConnected() {
    return new import_gateway_error.GatewayError(
      "NOT_CONNECTED",
      `The connection to ${this.address} through ${this.gatewayId} has ended`
    );
  }
  request(command, payload, timeoutMs) {
    if (this.ended)
      return Promise.reject(this.notConnected());
    return new Promise((resolve, reject) => {
      const abort = (error) => reject(error);
      this.pending.add(abort);
      (0, import_send_request.sendRequest)(
        this.sender,
        this.instance,
        command,
        {
          gatewayId: this.localGatewayId,
          address: this.address,
          ...payload
        },
        timeoutMs
      ).then(
        (result) => {
          if (this.pending.delete(abort))
            resolve(result);
        },
        (error) => {
          if (this.pending.delete(abort))
            reject(error);
        }
      );
    });
  }
  async getServices() {
    const result = await this.request(
      import_gateway_protocol.GattCommands.getServices,
      {},
      GATT_TIMEOUTS_MS.getServices
    );
    if (!Array.isArray(result == null ? void 0 : result.services)) {
      throw new import_gateway_error.GatewayError(
        "GATT_ERROR",
        `Unexpected answer to ${import_gateway_protocol.GattCommands.getServices}`
      );
    }
    return result.services;
  }
  async read(handle) {
    const result = await this.request(
      import_gateway_protocol.GattCommands.read,
      { handle },
      GATT_TIMEOUTS_MS.read
    );
    if (typeof (result == null ? void 0 : result.data) !== "string") {
      throw new import_gateway_error.GatewayError(
        "GATT_ERROR",
        `Unexpected answer to ${import_gateway_protocol.GattCommands.read}`
      );
    }
    return Buffer.from(result.data, "base64");
  }
  async write(handle, data, withResponse) {
    await this.request(
      import_gateway_protocol.GattCommands.write,
      { handle, data: data.toString("base64"), withResponse },
      GATT_TIMEOUTS_MS.write
    );
  }
  async subscribe(handle, listener) {
    if (this.ended)
      throw this.notConnected();
    this.listeners.set(handle, listener);
    try {
      await this.request(
        import_gateway_protocol.GattCommands.subscribe,
        { handle },
        GATT_TIMEOUTS_MS.subscribe
      );
    } catch (e) {
      if (this.listeners.get(handle) === listener) {
        this.listeners.delete(handle);
      }
      throw e;
    }
  }
  async disconnect() {
    if (this.ended)
      return;
    this.finish();
    try {
      await (0, import_send_request.sendRequest)(
        this.sender,
        this.instance,
        import_gateway_protocol.GattCommands.disconnect,
        { gatewayId: this.localGatewayId, address: this.address },
        GATT_TIMEOUTS_MS.disconnect
      );
    } catch (e) {
      this.log.debug(
        `Disconnecting ${this.address} through ${this.gatewayId} failed: ${e.message}`
      );
    }
  }
  onDisconnect(listener) {
    this.disconnectListeners.push(listener);
  }
  handleNotification(handle, data) {
    var _a;
    (_a = this.listeners.get(handle)) == null ? void 0 : _a(data);
  }
  handleEnded() {
    if (this.ended)
      return;
    this.finish();
    for (const listener of this.disconnectListeners.splice(0)) {
      try {
        listener();
      } catch {
      }
    }
  }
  finish() {
    this.ended = true;
    this.listeners.clear();
    const error = this.notConnected();
    for (const abort of [...this.pending])
      abort(error);
    this.pending.clear();
    this.onEnd();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GATT_TIMEOUTS_MS,
  RemoteGattLink
});
//# sourceMappingURL=remote-gatt-link.js.map
