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
var gatt_session_exports = {};
__export(gatt_session_exports, {
  GattSession: () => GattSession
});
module.exports = __toCommonJS(gatt_session_exports);
var import_gateway_error = require("../lib/gateway-error");
var import_uuid = require("../lib/uuid");
class GattSession {
  constructor(link) {
    this.link = link;
    this.address = link.address;
    this.gatewayId = link.gatewayId;
    this.mtu = link.mtu;
    link.onDisconnect(() => {
      this._closed = true;
    });
  }
  address;
  gatewayId;
  mtu;
  _closed = false;
  disconnected = false;
  services;
  get closed() {
    return this._closed;
  }
  ensureOpen() {
    if (this._closed) {
      throw new import_gateway_error.GatewayError(
        "NOT_CONNECTED",
        `The connection to ${this.address} is closed`
      );
    }
  }
  async getServices() {
    this.ensureOpen();
    if (!this.services) {
      this.services = this.link.getServices();
      this.services.catch(() => {
        this.services = void 0;
      });
    }
    return this.services;
  }
  async findCharacteristic(service, characteristic) {
    var _a;
    this.ensureOpen();
    const serviceUuid = (0, import_uuid.normalizeUuid)(service);
    const characteristicUuid = (0, import_uuid.normalizeUuid)(characteristic);
    if (!serviceUuid) {
      throw new import_gateway_error.GatewayError(
        "INVALID_PAYLOAD",
        `"${String(service)}" is not a UUID`
      );
    }
    if (!characteristicUuid) {
      throw new import_gateway_error.GatewayError(
        "INVALID_PAYLOAD",
        `"${String(characteristic)}" is not a UUID`
      );
    }
    const services = await this.getServices();
    const found = (_a = services.find((s) => s.uuid === serviceUuid)) == null ? void 0 : _a.characteristics.find((c) => c.uuid === characteristicUuid);
    if (!found) {
      throw new import_gateway_error.GatewayError(
        "GATT_ERROR",
        `Characteristic ${characteristicUuid} of service ${serviceUuid} not found`
      );
    }
    return found;
  }
  async read(service, characteristic) {
    const { handle } = await this.findCharacteristic(
      service,
      characteristic
    );
    this.ensureOpen();
    return this.link.read(handle);
  }
  async write(service, characteristic, data, withResponse = true) {
    const { handle } = await this.findCharacteristic(
      service,
      characteristic
    );
    this.ensureOpen();
    return this.link.write(handle, data, withResponse);
  }
  async subscribe(service, characteristic, listener) {
    const { handle } = await this.findCharacteristic(
      service,
      characteristic
    );
    this.ensureOpen();
    return this.link.subscribe(handle, listener);
  }
  async close() {
    this._closed = true;
    if (this.disconnected)
      return;
    this.disconnected = true;
    await this.link.disconnect();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GattSession
});
//# sourceMappingURL=gatt-session.js.map
