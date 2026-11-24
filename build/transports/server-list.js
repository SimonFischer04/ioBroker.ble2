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
var server_list_exports = {};
__export(server_list_exports, {
  DEFAULT_SERVER_PORT: () => DEFAULT_SERVER_PORT,
  migrateServerSettings: () => migrateServerSettings,
  parseServer: () => parseServer,
  parseServerList: () => parseServerList
});
module.exports = __toCommonJS(server_list_exports);
const DEFAULT_SERVER_PORT = 8734;
const HOSTNAME_REGEX = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const IPV6_REGEX = /^[0-9A-Fa-f:.]+$/;
function parsePort(text) {
  if (!/^\d{1,5}$/.test(text))
    return void 0;
  const port = +text;
  return port >= 1 && port <= 65535 ? port : void 0;
}
function parseServer(entry) {
  let host;
  let port = DEFAULT_SERVER_PORT;
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(entry);
  if (bracketed) {
    host = bracketed[1];
    if (!IPV6_REGEX.test(host) || !host.includes(":"))
      return void 0;
    if (bracketed[2] !== void 0) {
      const parsed = parsePort(bracketed[2]);
      if (parsed === void 0)
        return void 0;
      port = parsed;
    }
  } else {
    const parts = entry.split(":");
    if (parts.length > 2)
      return void 0;
    host = parts[0];
    if (!HOSTNAME_REGEX.test(host))
      return void 0;
    if (parts.length === 2) {
      const parsed = parsePort(parts[1]);
      if (parsed === void 0)
        return void 0;
      port = parsed;
    }
  }
  host = host.toLowerCase();
  return { host, port, gatewayId: `server:${host}:${port}` };
}
function parseServerList(setting) {
  const servers = [];
  const invalid = [];
  if (typeof setting !== "string")
    return { servers, invalid };
  for (const entry of setting.split(/[\s,;]+/)) {
    if (entry === "")
      continue;
    const server = parseServer(entry);
    if (!server) {
      invalid.push(entry);
    } else if (!servers.some((s) => s.gatewayId === server.gatewayId)) {
      servers.push(server);
    }
  }
  return { servers, invalid };
}
function migrateServerSettings(native) {
  const legacy = typeof native.server === "string" ? native.server.trim() : "";
  if (legacy === "")
    return void 0;
  const current = typeof native.remoteServers === "string" ? native.remoteServers.trim() : "";
  if (current !== "")
    return void 0;
  return { server: "", remoteServers: legacy, localScanner: false };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_SERVER_PORT,
  migrateServerSettings,
  parseServer,
  parseServerList
});
//# sourceMappingURL=server-list.js.map
