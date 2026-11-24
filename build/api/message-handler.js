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
var message_handler_exports = {};
__export(message_handler_exports, {
  createMessageHandler: () => createMessageHandler
});
module.exports = __toCommonJS(message_handler_exports);
var import_child_process = require("child_process");
var import_advertisement = require("../lib/advertisement");
var import_gateway_error = require("../lib/gateway-error");
var import_gateway_protocol = require("../lib/gateway-protocol");
var import_uuid = require("../lib/uuid");
var import_remote_gateway = require("../transports/remote-gateway");
function parseGattRequest(payload, fields) {
  const invalid = (message) => new import_gateway_error.GatewayError("INVALID_PAYLOAD", message);
  if (payload == null || typeof payload !== "object") {
    throw invalid("The message must be an object");
  }
  const { address, service, characteristic, data, withResponse } = payload;
  const normalizedAddress = (0, import_advertisement.normalizeAddress)(address);
  if (!normalizedAddress) {
    throw invalid(`"address" must be a MAC address`);
  }
  const request = {
    address: normalizedAddress,
    service: "",
    characteristic: "",
    data: Buffer.alloc(0),
    withResponse: true
  };
  if (fields.characteristic) {
    const serviceUuid = (0, import_uuid.normalizeUuid)(service);
    const characteristicUuid = (0, import_uuid.normalizeUuid)(characteristic);
    if (!serviceUuid)
      throw invalid(`"service" must be a UUID`);
    if (!characteristicUuid)
      throw invalid(`"characteristic" must be a UUID`);
    request.service = serviceUuid;
    request.characteristic = characteristicUuid;
  }
  if (fields.data) {
    if (typeof data !== "string" || !import_remote_gateway.BASE64_REGEX.test(data)) {
      throw invalid(`"data" must be base64 encoded`);
    }
    if (withResponse !== void 0 && typeof withResponse !== "boolean") {
      throw invalid(`"withResponse" must be true or false`);
    }
    request.data = Buffer.from(data, "base64");
    request.withResponse = withResponse != null ? withResponse : true;
  }
  return request;
}
async function runGattCommand(run) {
  try {
    return { error: null, result: await run() };
  } catch (e) {
    return (0, import_gateway_error.toErrorResponse)(e);
  }
}
function createMessageHandler(ctx) {
  const { adapter } = ctx;
  return (obj) => {
    if (!obj)
      return;
    function respond(response) {
      if (obj.callback)
        adapter.sendTo(obj.from, obj.command, response, obj.callback);
    }
    switch (obj.command) {
      case "getHCIPorts":
        (0, import_child_process.exec)("hciconfig | grep hci", (error, stdout, _stderr) => {
          if (error != null) {
            respond({ error });
            return;
          }
          const ports = [];
          const regex = /^hci(\d+)\:.+Bus\:\s(\w+)$/gm;
          let result;
          while (true) {
            result = regex.exec(stdout);
            if (!(result && result.length))
              break;
            const port = { index: +result[1], bus: result[2] };
            ports.push(port);
          }
          respond({ error: null, result: ports });
        });
        return;
      case import_gateway_protocol.GatewayCommands.advertisements: {
        const sender = obj.from.replace(/^system\.adapter\./, "");
        respond(
          ctx.remoteGateway.handleAdvertisements(sender, obj.message)
        );
        return;
      }
      case import_gateway_protocol.GatewayCommands.announce: {
        const sender = obj.from.replace(/^system\.adapter\./, "");
        respond(ctx.remoteGateway.handleAnnounce(sender, obj.message));
        return;
      }
      case import_gateway_protocol.GatewayCommands.connectionState: {
        const sender = obj.from.replace(/^system\.adapter\./, "");
        ctx.remoteGateway.handleConnectionState(sender, obj.message);
        respond({ error: null, result: {} });
        return;
      }
      case import_gateway_protocol.GatewayCommands.notification: {
        const sender = obj.from.replace(/^system\.adapter\./, "");
        ctx.remoteGateway.handleNotification(sender, obj.message);
        respond({ error: null, result: {} });
        return;
      }
      case import_gateway_protocol.GatewayCommands.discoverServices:
        void runGattCommand(async () => {
          const { address } = parseGattRequest(obj.message, {
            characteristic: false,
            data: false
          });
          const services = await ctx.connections.withSession(
            address,
            (session) => session.getServices()
          );
          return { services };
        }).then(respond);
        return;
      case import_gateway_protocol.GatewayCommands.readCharacteristic:
        void runGattCommand(async () => {
          const { address, service, characteristic } = parseGattRequest(obj.message, {
            characteristic: true,
            data: false
          });
          const value = await ctx.connections.withSession(
            address,
            (session) => session.read(service, characteristic)
          );
          return { data: value.toString("base64") };
        }).then(respond);
        return;
      case import_gateway_protocol.GatewayCommands.writeCharacteristic:
        void runGattCommand(async () => {
          const {
            address,
            service,
            characteristic,
            data,
            withResponse
          } = parseGattRequest(obj.message, {
            characteristic: true,
            data: true
          });
          await ctx.connections.withSession(
            address,
            (session) => session.write(
              service,
              characteristic,
              data,
              withResponse
            )
          );
          return {};
        }).then(respond);
        return;
      case import_gateway_protocol.GatewayCommands.getGateways:
        respond({ error: null, result: ctx.gateways.list() });
        return;
      case import_gateway_protocol.GatewayCommands.getDevices:
        respond({ error: null, result: ctx.devices.getDevices() });
        return;
      default:
        respond({ error: "Unknown command!" });
        return;
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createMessageHandler
});
//# sourceMappingURL=message-handler.js.map
