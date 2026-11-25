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
var pvvx_updater_exports = {};
__export(pvvx_updater_exports, {
  CHECK_INTERVAL_MS: () => CHECK_INTERVAL_MS,
  CHECK_START_DELAY_MS: () => CHECK_START_DELAY_MS,
  FIRMWARE_STATUS: () => FIRMWARE_STATUS,
  OTA_SESSION_TIMEOUT_MS: () => OTA_SESSION_TIMEOUT_MS,
  PROGRESS_STEP: () => PROGRESS_STEP,
  PvvxUpdater: () => PvvxUpdater,
  VERIFY_ATTEMPTS: () => VERIFY_ATTEMPTS,
  VERIFY_DELAY_MS: () => VERIFY_DELAY_MS,
  VERIFY_RETRY_MS: () => VERIFY_RETRY_MS
});
module.exports = __toCommonJS(pvvx_updater_exports);
var import_command_channel = require("./command-channel");
var import_firmware_catalog = require("./firmware-catalog");
var import_ota_checks = require("./ota-checks");
var import_ota_transfer = require("./ota-transfer");
var import_protocol = require("./protocol");
var import_time_sync = require("./time-sync");
var import_update_error = require("./update-error");
const CHECK_START_DELAY_MS = 12e4;
const CHECK_INTERVAL_MS = 24 * 36e5;
const OTA_SESSION_TIMEOUT_MS = 6e5;
const VERIFY_DELAY_MS = 15e3;
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 3e4;
const PROGRESS_STEP = 1;
const VERIFY_SESSION_TIMEOUT_MS = 45e3;
const FIRMWARE_STATUS = [
  "idle",
  "queued",
  "checking",
  "transferring",
  "verifying",
  "done",
  "failed"
];
const BUSY_STATUS = [
  "queued",
  "checking",
  "transferring",
  "verifying"
];
const DEVICE_STATES = {
  firmwareAvailable: {
    name: "Newer firmware that can be installed",
    type: "string",
    role: "text",
    read: true,
    write: false
  },
  firmwareUpdate: {
    name: "Install the newer firmware",
    type: "boolean",
    role: "button",
    read: false,
    write: true
  },
  firmwareProgress: {
    name: "Progress of the firmware update",
    type: "number",
    role: "value",
    unit: "%",
    min: 0,
    max: 100,
    read: true,
    write: false
  },
  firmwareStatus: {
    name: "Status of the firmware update",
    type: "string",
    role: "text",
    read: true,
    write: false,
    states: Object.fromEntries(FIRMWARE_STATUS.map((s) => [s, s]))
  },
  firmwareError: {
    name: "Last error of the firmware update",
    type: "string",
    role: "text",
    read: true,
    write: false
  }
};
const INSTANCE_STATES = {
  checkFirmware: {
    name: "Check for new firmware now",
    type: "boolean",
    role: "button",
    read: false,
    write: true
  },
  updateAll: {
    name: "Install the newer firmware on all devices",
    type: "boolean",
    role: "button",
    read: false,
    write: true
  }
};
function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}
function errorCode(e) {
  const code = e == null ? void 0 : e.code;
  return typeof code === "string" ? code : "ERROR";
}
function parseVersion(value) {
  if (typeof value !== "string")
    return void 0;
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match)
    return void 0;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 15 || minor > 15)
    return void 0;
  return major << 4 | minor;
}
class PvvxUpdater {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
  }
  queue = [];
  busy = /* @__PURE__ */ new Set();
  running = false;
  checking = false;
  disposed = false;
  timers = /* @__PURE__ */ new Set();
  interval;
  lastProgress = /* @__PURE__ */ new Map();
  async start() {
    if (this.options.addresses.length === 0)
      return;
    const { adapter } = this.ctx;
    try {
      await adapter.setObjectNotExistsAsync("pvvx", {
        type: "channel",
        common: { name: "pvvx firmware" },
        native: {}
      });
      for (const [id, common] of Object.entries(INSTANCE_STATES)) {
        await adapter.setObjectNotExistsAsync(`pvvx.${id}`, {
          type: "state",
          common,
          native: {}
        });
      }
      for (const address of this.options.addresses) {
        for (const [id, common] of Object.entries(DEVICE_STATES)) {
          await adapter.setObjectNotExistsAsync(
            `${address}.pvvx.${id}`,
            { type: "state", common, native: {} }
          );
        }
      }
    } catch (e) {
      adapter.log.warn(
        `Could not create the pvvx firmware objects: ${errorMessage(e)}`
      );
    }
    for (const address of this.options.addresses) {
      let status;
      try {
        status = await adapter.getStateAsync(
          `${address}.pvvx.firmwareStatus`
        );
      } catch {
        status = void 0;
      }
      if ((status == null ? void 0 : status.val) == void 0) {
        await this.setStates(address, {
          firmwareStatus: "idle",
          firmwareProgress: 0
        });
      } else if (BUSY_STATUS.includes(status.val)) {
        await this.setStates(address, {
          firmwareStatus: "idle",
          firmwareProgress: 0,
          firmwareError: "NOT_CONNECTED: The adapter was restarted during the update"
        });
      }
    }
    if (this.options.dailyCheck && !this.disposed) {
      const timer = this.ctx.setTimeout(() => {
        this.timers.delete(timer);
        void this.checkAll(false);
      }, CHECK_START_DELAY_MS);
      this.timers.add(timer);
      this.interval = this.ctx.setInterval(
        () => void this.checkAll(false),
        CHECK_INTERVAL_MS
      );
    }
  }
  async checkAll(refresh) {
    var _a, _b;
    if (this.checking || this.disposed)
      return;
    this.checking = true;
    const { adapter, catalog } = this.ctx;
    try {
      let index;
      try {
        index = await catalog.getIndex(refresh);
      } catch (e) {
        adapter.log.warn(
          `Could not load the pvvx firmware list: ${errorMessage(e)}`
        );
        return;
      }
      for (const address of this.options.addresses) {
        if (this.disposed)
          return;
        try {
          const hardwareId = (_a = await adapter.getStateAsync(
            `${address}.pvvx.hardwareId`
          )) == null ? void 0 : _a.val;
          const version = parseVersion(
            (_b = await adapter.getStateAsync(
              `${address}.pvvx.firmwareVersion`
            )) == null ? void 0 : _b.val
          );
          if (typeof hardwareId !== "number" || version === void 0) {
            continue;
          }
          const selection = (0, import_firmware_catalog.selectImage)(index, hardwareId, version);
          await this.setStates(address, {
            firmwareAvailable: "path" in selection ? (0, import_protocol.formatVersion)(selection.version) : ""
          });
        } catch (e) {
          adapter.log.warn(
            `Could not check the firmware of ${address}: ${errorMessage(e)}`
          );
        }
      }
    } finally {
      this.checking = false;
    }
  }
  isBusy(address) {
    return this.busy.has(address);
  }
  update(address) {
    if (this.disposed || !this.options.addresses.includes(address)) {
      return Promise.resolve();
    }
    if (this.busy.has(address)) {
      this.ctx.adapter.log.info(
        `The firmware update of ${address} is already queued`
      );
      return Promise.resolve();
    }
    this.busy.add(address);
    return new Promise((finished) => {
      this.queue.push({ address, finished });
      this.lastProgress.set(address, 0);
      void this.setStates(address, {
        firmwareStatus: "queued",
        firmwareProgress: 0
      }).then(() => this.pump());
    });
  }
  async pump() {
    if (this.running || this.disposed)
      return;
    const next = this.queue.shift();
    if (!next)
      return;
    this.running = true;
    let updated = false;
    try {
      updated = await this.run(next.address);
    } finally {
      this.running = false;
      this.busy.delete(next.address);
    }
    if (updated && !this.disposed)
      this.ctx.requestTimeSync(next.address);
    next.finished();
    void this.pump();
  }
  async run(address) {
    const { ctx } = this;
    try {
      await this.setStates(address, { firmwareStatus: "checking" });
      let battery;
      try {
        battery = await ctx.adapter.getStateAsync(`${address}.battery`);
      } catch {
        battery = void 0;
      }
      (0, import_ota_checks.checkPreconditions)({
        address,
        now: ctx.clock.now(),
        battery,
        bestGateway: ctx.connections.bestGateway(
          address,
          "writeSequence"
        )
      });
      const index = await ctx.catalog.getIndex(false);
      let expected = 0;
      await ctx.connections.withSession(
        address,
        async (session) => {
          var _a;
          const channel = new import_command_channel.PvvxCommandChannel(session, ctx);
          await channel.open();
          const config = (0, import_protocol.parseConfigResponse)(
            await channel.request((0, import_protocol.encodeConfigRequest)())
          );
          if (!config) {
            throw new import_time_sync.PvvxProtocolError(
              "The device did not answer like a pvvx firmware"
            );
          }
          const selection = (0, import_firmware_catalog.selectImage)(
            index,
            config.hardwareId,
            config.version
          );
          if ("problem" in selection) {
            const id = (_a = config.hardwareId) != null ? _a : "unknown";
            const messages = {
              UP_TO_DATE: `Version ${(0, import_protocol.formatVersion)(config.version)} is installed, ${(0, import_protocol.formatVersion)(index.version)} is the newest`,
              UNKNOWN_HARDWARE: `Hardware ID ${id} is not in firmware.json`,
              NO_IMAGE: `There is no BLE firmware for hardware ID ${id}`
            };
            throw new import_update_error.PvvxUpdateError(
              selection.problem,
              messages[selection.problem]
            );
          }
          const { image, length } = await ctx.catalog.getImage(
            selection.path
          );
          await this.setStates(address, {
            firmwareStatus: "transferring"
          });
          await (0, import_ota_transfer.transferImage)(session, image, length, {
            onProgress: (fraction) => this.reportProgress(address, fraction),
            sleep: (ms) => this.sleep(ms)
          });
          expected = selection.version;
        },
        {
          priority: "high",
          timeoutMs: OTA_SESSION_TIMEOUT_MS,
          requireFeature: "writeSequence"
        }
      );
      await this.setStates(address, { firmwareStatus: "verifying" });
      await this.verify(address, expected);
      await this.setStates(address, {
        firmwareVersion: (0, import_protocol.formatVersion)(expected),
        firmwareAvailable: "",
        firmwareProgress: 100,
        firmwareError: "",
        firmwareStatus: "done"
      });
      if (this.disposed)
        return false;
      ctx.adapter.log.info(
        `Updated the firmware of ${address} to ${(0, import_protocol.formatVersion)(expected)}`
      );
      return true;
    } catch (e) {
      if (this.disposed)
        return false;
      const firmwareError = `${errorCode(e)}: ${errorMessage(e)}`;
      ctx.adapter.log.warn(
        `The firmware update of ${address} failed: ${firmwareError}`
      );
      await this.setStates(address, {
        firmwareStatus: "failed",
        firmwareError
      });
      return false;
    }
  }
  async verify(address, expected) {
    await this.sleep(VERIFY_DELAY_MS);
    let lastError;
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0)
        await this.sleep(VERIFY_RETRY_MS);
      let version;
      try {
        version = await this.ctx.connections.withSession(
          address,
          async (session) => {
            const channel = new import_command_channel.PvvxCommandChannel(
              session,
              this.ctx
            );
            await channel.open();
            const config = (0, import_protocol.parseConfigResponse)(
              await channel.request((0, import_protocol.encodeConfigRequest)())
            );
            if (!config) {
              throw new import_time_sync.PvvxProtocolError(
                "The device did not answer like a pvvx firmware"
              );
            }
            return config.version;
          },
          { timeoutMs: VERIFY_SESSION_TIMEOUT_MS }
        );
      } catch (e) {
        lastError = e;
        continue;
      }
      if (version === expected)
        return;
      throw new import_update_error.PvvxUpdateError(
        "VERIFY_FAILED",
        `Version ${(0, import_protocol.formatVersion)(version)} after the update, expected ${(0, import_protocol.formatVersion)(expected)}`
      );
    }
    throw new import_update_error.PvvxUpdateError(
      "VERIFY_FAILED",
      `The device could not be reached after the update: ${errorMessage(lastError)}`
    );
  }
  reportProgress(address, fraction) {
    var _a;
    const value = Math.floor(fraction * 99);
    const last = (_a = this.lastProgress.get(address)) != null ? _a : 0;
    if (value - last < PROGRESS_STEP)
      return;
    this.lastProgress.set(address, value);
    void this.setStates(address, { firmwareProgress: value });
  }
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = this.ctx.setTimeout(() => {
        this.timers.delete(timer);
        if (!this.disposed)
          resolve();
      }, ms);
      this.timers.add(timer);
    });
  }
  async setStates(address, values) {
    for (const [id, value] of Object.entries(values)) {
      if (this.disposed)
        return;
      try {
        await this.ctx.adapter.setStateAsync(
          `${address}.pvvx.${id}`,
          value,
          true
        );
      } catch (e) {
        this.ctx.adapter.log.warn(
          `Could not write ${address}.pvvx.${id}: ${errorMessage(e)}`
        );
      }
    }
  }
  async updateAll() {
    var _a;
    for (const address of this.options.addresses) {
      let available;
      try {
        available = (_a = await this.ctx.adapter.getStateAsync(
          `${address}.pvvx.firmwareAvailable`
        )) == null ? void 0 : _a.val;
      } catch {
        available = void 0;
      }
      if (typeof available === "string" && available !== "") {
        void this.update(address);
      }
    }
  }
  handleStateChange(id, state) {
    const prefix = `${this.ctx.adapter.namespace}.`;
    if (!id.startsWith(prefix))
      return false;
    const relative = id.slice(prefix.length);
    let action;
    if (relative === "pvvx.updateAll") {
      action = () => void this.updateAll();
    } else if (relative === "pvvx.checkFirmware") {
      action = () => void this.checkAll(true);
    } else {
      const match = /^(.+)\.pvvx\.firmwareUpdate$/.exec(relative);
      if (!match || !this.options.addresses.includes(match[1])) {
        return false;
      }
      const address = match[1];
      action = () => void this.update(address);
    }
    if (!state || state.ack === true || !state.val || this.disposed) {
      return true;
    }
    this.ctx.adapter.setStateAsync(id, false, true).catch(() => {
    });
    action();
    return true;
  }
  dispose() {
    this.disposed = true;
    for (const timer of this.timers)
      this.ctx.clearTimeout(timer);
    this.timers.clear();
    if (this.interval !== void 0) {
      this.ctx.clearInterval(this.interval);
      this.interval = void 0;
    }
    this.queue.length = 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHECK_INTERVAL_MS,
  CHECK_START_DELAY_MS,
  FIRMWARE_STATUS,
  OTA_SESSION_TIMEOUT_MS,
  PROGRESS_STEP,
  PvvxUpdater,
  VERIFY_ATTEMPTS,
  VERIFY_DELAY_MS,
  VERIFY_RETRY_MS
});
//# sourceMappingURL=pvvx-updater.js.map
