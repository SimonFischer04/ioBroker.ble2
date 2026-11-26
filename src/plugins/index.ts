import type { Plugin } from "./plugin";
import xiaomi = require("./xiaomi");
import miFlora = require("./mi-flora");
import eddystone = require("./eddystone");
import ruuviTag = require("./ruuvi-tag");
import atc = require("./atc");
import switchbot = require("./switchbot");
import bthome = require("./bthome");
import miScale = require("./mi-scale");
import govee = require("./govee");
import mopeka = require("./mopeka");
import defaultPlugin = require("./_default");

export default [
	xiaomi,
	miFlora,
	eddystone,
	ruuviTag,
	atc,
	switchbot,
	bthome,
	miScale,
	govee,
	mopeka,
	defaultPlugin,
] satisfies Plugin[];
