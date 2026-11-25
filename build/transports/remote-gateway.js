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
var remote_gateway_exports = {};
__export(remote_gateway_exports, {
  BASE64_REGEX: () => BASE64_REGEX,
  RemoteGatewayTransport: () => RemoteGatewayTransport,
  parseAnnounceMessage: () => parseAnnounceMessage,
  parseGatewayMessage: () => parseGatewayMessage
});
module.exports = __toCommonJS(remote_gateway_exports);
var import_ad_parser = require("../lib/ad-parser");
var import_advertisement = require("../lib/advertisement");
var import_gateway_error = require("../lib/gateway-error");
var import_gateway_protocol = require("../lib/gateway-protocol");
var import_send_request = require("../lib/send-request");
var import_remote_gatt_link = require("./remote-gatt-link");
const GATEWAY_ID_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_ANNOUNCED_GATEWAYS = 100;
const MAX_DATA_LENGTH = 1650;
const ALIVE_REGEX = /^system\.adapter\.(.+)\.alive$/;
function invalid(message) {
  return { error: { code: "INVALID_PAYLOAD", message } };
}
function isCount(value) {
  return value === void 0 || Number.isInteger(value) && value >= 0;
}
function parseAnnounceMessage(sender, payload) {
  if (payload == null || typeof payload !== "object") {
    return invalid("The message must be an object");
  }
  const { protocol, gateways } = payload;
  if (protocol !== import_gateway_protocol.GATEWAY_PROTOCOL) {
    return {
      error: {
        code: "UNSUPPORTED_PROTOCOL",
        message: `Only the protocol "${import_gateway_protocol.GATEWAY_PROTOCOL}" is supported`
      }
    };
  }
  if (!Array.isArray(gateways)) {
    return invalid(`"gateways" must be an array`);
  }
  if (gateways.length > MAX_ANNOUNCED_GATEWAYS) {
    return invalid(
      `"gateways" must not contain more than ${MAX_ANNOUNCED_GATEWAYS} gateways`
    );
  }
  const result = [];
  for (const entry of gateways) {
    if (entry == null || typeof entry !== "object") {
      return invalid("Every gateway must be an object");
    }
    const { gatewayId, connect, freeSlots, slotLimit, features } = entry;
    if (typeof gatewayId !== "string" || !GATEWAY_ID_REGEX.test(gatewayId)) {
      return invalid(
        `"gatewayId" must consist of 1 to 64 letters, digits, "_", "-" or "."`
      );
    }
    if (typeof connect !== "boolean") {
      return invalid(`"connect" of ${gatewayId} must be true or false`);
    }
    if (!isCount(freeSlots) || !isCount(slotLimit)) {
      return invalid(
        `"freeSlots" and "slotLimit" of ${gatewayId} must be whole numbers from 0`
      );
    }
    if (features !== void 0 && (!Array.isArray(features) || features.some((f) => typeof f !== "string"))) {
      return invalid(
        `"features" of ${gatewayId} must be an array of strings`
      );
    }
    result.push({
      id: `${sender}:${gatewayId}`,
      connect,
      freeSlots,
      slotLimit,
      features: connect ? import_gateway_protocol.GATEWAY_FEATURES.filter(
        (known) => features == null ? void 0 : features.includes(known)
      ) : []
    });
  }
  return { gateways: result };
}
function parseGatewayMessage(sender, payload) {
  if (payload == null || typeof payload !== "object") {
    return invalid("The message must be an object");
  }
  const { gatewayId, items } = payload;
  if (typeof gatewayId !== "string" || !GATEWAY_ID_REGEX.test(gatewayId)) {
    return invalid(
      `"gatewayId" must consist of 1 to 64 letters, digits, "_", "-" or "."`
    );
  }
  if (!Array.isArray(items)) {
    return invalid(`"items" must be an array`);
  }
  if (items.length > import_gateway_protocol.MAX_ADVERTISEMENTS_PER_MESSAGE) {
    return invalid(
      `"items" must not contain more than ${import_gateway_protocol.MAX_ADVERTISEMENTS_PER_MESSAGE} advertisements`
    );
  }
  const fullGatewayId = `${sender}:${gatewayId}`;
  const peripherals = [];
  let rejected = 0;
  for (const item of items) {
    const peripheral = parseItem(item, fullGatewayId);
    if (peripheral) {
      peripherals.push(peripheral);
    } else {
      rejected++;
    }
  }
  return { gatewayId: fullGatewayId, peripherals, rejected };
}
function parseItem(item, gatewayId) {
  if (item == null || typeof item !== "object")
    return;
  const { address, addressType, rssi, data, connectable } = item;
  const normalizedAddress = (0, import_advertisement.normalizeAddress)(address);
  if (!normalizedAddress)
    return;
  if (typeof rssi !== "number" || !Number.isFinite(rssi))
    return;
  if (typeof data !== "string" || data.length > Math.ceil(MAX_DATA_LENGTH / 3) * 4 || !BASE64_REGEX.test(data)) {
    return;
  }
  const id = normalizedAddress.replace(/:/g, "");
  return {
    id,
    uuid: id,
    address: normalizedAddress,
    addressType: addressType === "public" || addressType === "random" ? addressType : "unknown",
    connectable: typeof connectable === "boolean" ? connectable : void 0,
    advertisement: (0, import_ad_parser.parseAdvertisementData)(Buffer.from(data, "base64")),
    rssi,
    gatewayId
  };
}
class RemoteGatewayTransport {
  constructor(ctx, epoch) {
    this.ctx = ctx;
    this.epoch = epoch;
    const adapter = ctx.adapter;
    this.requestSender = {
      sendTo: (instance, command, message, callback) => adapter.sendTo(
        instance,
        command,
        message,
        callback
      ),
      setTimeout: (callback, ms) => adapter.setTimeout(callback, ms),
      clearTimeout: (timer) => adapter.clearTimeout(timer)
    };
  }
  senders = /* @__PURE__ */ new Set();
  requestSender;
  links = /* @__PURE__ */ new Map();
  start() {
  }
  stop() {
    for (const link of [...this.links.values()])
      link.handleEnded();
  }
  async connect(gatewayId, address, addressType) {
    var _a;
    const separator = gatewayId.indexOf(":");
    if (separator < 1) {
      throw new import_gateway_error.GatewayError(
        "UNKNOWN_GATEWAY",
        `${gatewayId} is not a gateway of another adapter`
      );
    }
    const instance = gatewayId.slice(0, separator);
    const localGatewayId = gatewayId.slice(separator + 1);
    const result = await (0, import_send_request.sendRequest)(
      this.requestSender,
      instance,
      import_gateway_protocol.GattCommands.connect,
      {
        gatewayId: localGatewayId,
        address,
        addressType,
        epoch: this.epoch
      },
      import_remote_gatt_link.GATT_TIMEOUTS_MS.connect
    );
    const mtu = Number.isInteger(result == null ? void 0 : result.mtu) && result.mtu >= 23 ? result.mtu : 23;
    const key = `${gatewayId}|${address}`;
    (_a = this.links.get(key)) == null ? void 0 : _a.handleEnded();
    const link = new import_remote_gatt_link.RemoteGattLink(
      this.requestSender,
      this.ctx.adapter.log,
      gatewayId,
      instance,
      localGatewayId,
      address,
      mtu,
      () => {
        if (this.links.get(key) === link)
          this.links.delete(key);
      }
    );
    this.links.set(key, link);
    return link;
  }
  handleConnectionState(sender, payload) {
    const target = this.parseTarget(sender, payload);
    if (!target) {
      this.ctx.adapter.log.debug(
        `Ignoring an invalid gateway:connectionState from ${sender}`
      );
      return;
    }
    const link = this.links.get(target);
    if (!link)
      return;
    this.ctx.adapter.log.debug(
      `The connection ${target} was ended by the gateway`
    );
    link.handleEnded();
  }
  handleNotification(sender, payload) {
    var _a;
    const target = this.parseTarget(sender, payload);
    if (!target)
      return;
    const { handle, data } = payload;
    if (!Number.isInteger(handle) || handle < 0 || typeof data !== "string" || !BASE64_REGEX.test(data)) {
      return;
    }
    (_a = this.links.get(target)) == null ? void 0 : _a.handleNotification(handle, Buffer.from(data, "base64"));
  }
  gatewayOffline(gatewayId) {
    for (const [key, link] of [...this.links]) {
      if (key.startsWith(`${gatewayId}|`))
        link.handleEnded();
    }
  }
  parseTarget(sender, payload) {
    if (payload == null || typeof payload !== "object")
      return void 0;
    const { gatewayId, address } = payload;
    if (typeof gatewayId !== "string" || !GATEWAY_ID_REGEX.test(gatewayId)) {
      return void 0;
    }
    const normalized = (0, import_advertisement.normalizeAddress)(address);
    if (!normalized)
      return void 0;
    return `${sender}:${gatewayId}|${normalized}`;
  }
  handleAdvertisements(sender, payload) {
    const parsed = parseGatewayMessage(sender, payload);
    if ("error" in parsed)
      return parsed;
    this.watchSender(sender);
    this.ctx.gateways.recordAdvertisements(
      { id: parsed.gatewayId, type: "remote", sender },
      parsed.peripherals.length
    );
    for (const peripheral of parsed.peripherals) {
      this.ctx.onAdvertisement(peripheral);
    }
    return {
      error: null,
      result: {
        accepted: parsed.peripherals.length,
        rejected: parsed.rejected
      }
    };
  }
  handleAnnounce(sender, payload) {
    const parsed = parseAnnounceMessage(sender, payload);
    if ("error" in parsed)
      return parsed;
    this.watchSender(sender);
    for (const { id, ...capabilities } of parsed.gateways) {
      this.ctx.gateways.announce(
        { id, type: "remote", sender },
        capabilities
      );
    }
    return {
      error: null,
      result: { protocol: import_gateway_protocol.GATEWAY_PROTOCOL, epoch: this.epoch }
    };
  }
  watchSender(sender) {
    if (this.senders.has(sender))
      return;
    this.senders.add(sender);
    this.ctx.adapter.subscribeForeignStates(
      `system.adapter.${sender}.alive`
    );
  }
  handleStateChange(id, state) {
    var _a;
    const sender = (_a = ALIVE_REGEX.exec(id)) == null ? void 0 : _a[1];
    if (!sender || !this.senders.has(sender))
      return;
    if ((state == null ? void 0 : state.val) === false) {
      this.ctx.adapter.log.info(
        `${sender} was stopped, its gateways are offline`
      );
      this.ctx.gateways.senderOffline(sender);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BASE64_REGEX,
  RemoteGatewayTransport,
  parseAnnounceMessage,
  parseGatewayMessage
});
//# sourceMappingURL=remote-gateway.js.map
