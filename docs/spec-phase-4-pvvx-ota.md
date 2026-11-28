# Spezifikation Phase 4: Firmware-Update für pvvx-Thermometer

Stand 2026-11-25 · gehört zu `docs/plan-bluetooth-infrastructure.md` (Phase 4 in Abschnitt 7)

Dieses Dokument ist die verbindliche Arbeitsanweisung für Phase 4. Arbeite es von oben nach unten ab. Wo es eine Frage nicht beantwortet, hör auf und frag nach. Rate nicht.

Die Phase betrifft **zwei Repos**: `ioBroker.ble` (Teil A und B) und `ioBroker.esphome` (Teil A und C). Teil A gilt für beide.

Lies vorher:

- `AGENTS.md` in beiden Repos,
- `docs/pvvx-protocol.md`, Abschnitte 2, 3, 4, 6 und 7. Es beschreibt das Protokoll der Geräte. Dieses Dokument wiederholt davon nur, was du für die Umsetzung brauchst.
- `docs/spec-phase-2-gatt.md`, Teil A (die Gateway-Schnittstelle, die hier erweitert wird),
- `docs/spec-phase-3-pvvx-time.md`, Abschnitt B3 bis B6 (der Driver, auf dem diese Phase aufbaut).

---

## 0. Was vom Hardware-Test abhängt

Diese Spezifikation ist **vor** dem ersten Test mit echter Hardware geschrieben (Plan, Abschnitt 9, Schritt 1). Einige Werte sind deshalb Annahmen aus den Referenz-Clients. Jede davon ist eine Konstante, damit ein Hardware-Test sie an genau einer Stelle ändert.

| Nr. | Frage | Annahme | Konstante |
|---|---|---|---|
| H1 | Kommen Datenpakete über einen ESPHome-Proxy ohne Antwort zuverlässig an? (`docs/pvvx-protocol.md`, 9.1) | Ja, wie im Web-Flasher | `OTA_WRITE_WITH_RESPONSE = false` in `src/drivers/pvvx/ota-protocol.ts` (`ble`) |
| H2 | Reicht das Lesen des Status nach jedem achten Paket als Bremse? | Ja, wie in beiden Referenzen | `PACKETS_PER_STATUS_READ = 8` in `ota-protocol.ts` (`ble`) |
| H3 | Braucht der ESP zwischen zwei Writes ohne Antwort eine Pause? | Nein | `WRITE_SEQUENCE_GAP_MS = 0` in `src/lib/bleGattBridge.ts` (`esphome`) |
| H4 | Wie lange dauert ein Update über einen Proxy? (9.3) | Höchstens 10 Minuten | `OTA_SESSION_TIMEOUT_MS = 600000` in `pvvx-updater.ts` (`ble`) |
| H5 | Wann meldet sich das Gerät nach dem Neustart wieder? | Nach 15 bis 75 Sekunden | `VERIFY_DELAY_MS`, `VERIFY_ATTEMPTS`, `VERIFY_RETRY_MS` in `pvvx-updater.ts` (`ble`) |

**Regel:** Liegen beim Start der Umsetzung Ergebnisse eines Hardware-Tests in `docs/pvvx-protocol.md`, Abschnitt 9, vor, setze die Konstanten danach. Sonst setze die Annahmen aus der Tabelle. Nenne im Abschlussbericht, welche Werte du gesetzt hast und warum. Schreibe keinen Code, der zwischen mehreren Varianten automatisch umschaltet.

---

## 1. Ziel und Abgrenzung

### Voraussetzung

**Phase 2 und 3 müssen fertig sein.** Prüfe vor dem ersten Schritt, dass in `ble` `src/drivers/pvvx/` mit `PvvxDriver`, `PvvxCommandChannel` und `protocol.ts` existiert, in `esphome` `src/lib/bleGattBridge.ts`, und dass in beiden Repos alle Tests bestehen. Fehlt etwas, hör auf.

### Ziel

`ble` spielt auf pvvx-Thermometer eine neuere pvvx-Firmware ein, über die Gateways aus Phase 2:

- pro Gerät auf Knopfdruck,
- für alle Geräte mit verfügbarem Update auf Knopfdruck, eines nach dem anderen,
- nach Vorab-Prüfungen (Image gültig und passend, Batterie, Empfang),
- mit Fortschritt und Status in States.

Einmal am Tag (und auf Knopfdruck) prüft `ble`, ob es für die Geräte eine neuere Firmware gibt, ohne sich mit ihnen zu verbinden.

Damit nicht jedes der etwa 5400 Pakete einzeln durch die States-DB läuft, bekommt die Gateway-Schnittstelle den Befehl `gatt:writeSequence` (Teil A).

Abnahme am Ende der Phase:

1. Ein simuliertes Gerät hinter einem simulierten Gateway wird in den Integrationstests von `ble` vollständig aktualisiert: alle Pakete kommen lückenlos und in der richtigen Reihenfolge an, die neue Version wird nach dem Neustart gelesen, danach wird die Uhr gestellt.
2. Ein Abbruch mitten im Update (Verbindung weg) meldet `failed`, das Gerät behält seine alte Version, und ein zweiter Versuch gelingt.
3. In `esphome` führt `gatt:writeSequence` die Writes in der richtigen Reihenfolge am (simulierten) Proxy aus.
4. Ein echtes Gerät über einen echten Proxy ist **nicht** Teil der Abnahme dieser Spezifikation. Das ist der Hardware-Test im Plan.

### Nicht Teil dieser Phase

Baue nichts davon, auch nicht vorbereitend:

- Das erweiterte Update (`0x73`) und Images über `0x20000` Bytes. Sende `0x73` nie.
- Original-Firmware des Herstellers (`original`, `signed` in `firmware.json`) und Zigbee-Images.
- Eigene Images aus dem ioBroker-Dateispeicher oder per Upload im Admin.
- Automatische Updates ohne Knopfdruck. Die tägliche Prüfung zeigt nur an.
- Downgrades oder das erneute Einspielen derselben Version.
- Automatische Wiederholungen eines fehlgeschlagenen Updates.
- Den Befehl `0x00` (Geräte-ID).
- Updates über die Bluetooth-Hardware des Hosts oder über Remote-Scanner. Nur Gateways mit `writeSequence` (A1).
- Mehrere Updates gleichzeitig.

---

## 2. Verhalten aus Sicht des Benutzers

### Einstellungen

| Einstellung (`native`) | Typ | Standard | Admin | Bedeutung |
|---|---|---|---|---|
| `pvvxFirmwareCheck` | boolean | `true` | Checkbox „Check daily for new pvvx firmware“ | Tägliche Prüfung auf neue Firmware |
| `pvvxFirmwareUrl` | string | `"https://raw.githubusercontent.com/pvvx/ATC_MiThermometer/master/"` | **nicht** im Admin | Basis-URL für `firmware.json` und die Images. Für Tests und Spiegel. Muss auf `/` enden, sonst hängt der Adapter `/` an. |

Hilfetext der Checkbox (englisch): `"Once a day, the adapter looks up the newest firmware for the pvvx thermometers on GitHub (pvvx/ATC_MiThermometer) and shows it in pvvx.firmwareAvailable. Nothing is installed without pressing a button."`

### Objekte pro Gerät

Zusätzlich zu den Objekten aus Phase 3, unter `<mac>.pvvx`:

| ID | Typ | Rolle | Schreibbar | Inhalt |
|---|---|---|---|---|
| `firmwareAvailable` | string | `text` | nein | Neuere Version, die eingespielt werden kann, z. B. `"6.0"`. `""` = keine neuere oder keine passende |
| `firmwareUpdate` | boolean | `button` | ja | Startet das Update dieses Geräts |
| `firmwareProgress` | number | `value` | nein | 0 bis 100, Einheit `%` |
| `firmwareStatus` | string | `text` | nein | Einer der Werte aus der Tabelle unten |
| `firmwareError` | string | `text` | nein | `""` nach Erfolg, sonst `"<CODE>: <Meldung>"` |

Für alle gilt `read: true`, außer `firmwareUpdate` (`read: false`). `firmwareStatus` bekommt `common.states` mit den Werten aus der folgenden Tabelle.

| `firmwareStatus` | Bedeutung |
|---|---|
| `idle` | Kein Update angefordert (Anfangswert, wird beim Anlegen geschrieben) |
| `queued` | Wartet, bis ein anderes Update fertig ist |
| `checking` | Vorab-Prüfungen, Verbindung, Image laden |
| `transferring` | Pakete werden übertragen |
| `verifying` | Wartet auf den Neustart und prüft die neue Version |
| `done` | Erfolgreich |
| `failed` | Fehlgeschlagen, siehe `firmwareError` |

### Objekte der Instanz

| ID | Typ | Rolle | Inhalt |
|---|---|---|---|
| `pvvx` | channel | – | Name `"pvvx firmware"` |
| `pvvx.checkFirmware` | boolean, schreibbar | `button` | Prüft sofort auf neue Firmware |
| `pvvx.updateAll` | boolean, schreibbar | `button` | Startet das Update aller Geräte mit `firmwareAvailable` ≠ `""` |

Diese Objekte werden nur angelegt, wenn `pvvxDevices` mindestens ein Gerät enthält.

### Fehlercodes in `firmwareError`

| Code | Bedeutung |
|---|---|
| `UP_TO_DATE` | Das Gerät hat schon die neueste oder eine neuere Version |
| `UNKNOWN_HARDWARE` | Hardware-ID unbekannt oder nicht in `firmware.json` |
| `NO_IMAGE` | Für diese Hardware-ID gibt es kein BLE-Image (`"?"` oder nicht `.bin`) |
| `DOWNLOAD_FAILED` | `firmware.json` oder das Image konnte nicht geladen werden |
| `INVALID_IMAGE` | Das Image besteht die Prüfung aus `docs/pvvx-protocol.md`, 6.2, nicht |
| `BATTERY_LOW` | Batterie unter 40 % |
| `BATTERY_UNKNOWN` | Kein aktueller Batteriewert (siehe B6) |
| `WEAK_SIGNAL` | Das beste geeignete Gateway empfängt das Gerät schlechter als −80 dBm |
| `NO_GATEWAY` | Kein Gateway mit `writeSequence` empfängt das Gerät |
| `UNEXPECTED_ANSWER` | Das Gerät antwortet nicht wie eine pvvx-Firmware (aus Phase 3) |
| `OTA_STATUS_<n>` | Das Gerät meldete den Update-Status `n` (1 bis 6, siehe `docs/pvvx-protocol.md`, 6.6) |
| `VERIFY_FAILED` | Nach dem Neustart meldet das Gerät nicht die neue Version |
| Codes aus `docs/spec-phase-2-gatt.md`, A3 | z. B. `NOT_CONNECTED`, `TIMEOUT`, `CONNECT_FAILED` |

---

## Teil A: Protokoll-Erweiterung (`ble-gateway/1`)

Die Erweiterung ist abwärtskompatibel: Das Protokoll bleibt `ble-gateway/1`. Ein Lieferant ohne die Erweiterung meldet das Feature nicht und bekommt `gatt:writeSequence` nie.

### A1. Features in `gateway:announce`

`GatewayAnnouncement` bekommt ein optionales Feld:

```ts
/** Optional commands the gateway supports. Unknown values are ignored. */
features?: string[];
```

Bekannte Werte: `"writeSequence"`.

Regeln:

1. Fehlt `features`, gilt `[]`.
2. Ist `features` vorhanden, aber kein Array aus Strings, antwortet `ble` mit `INVALID_PAYLOAD`, wie bei den anderen Feldern.
3. `ble` übernimmt nur bekannte Werte (`GATEWAY_FEATURES`), ohne Duplikate.
4. Ein Gateway mit `connect: false` hat keine Features, egal was gemeldet wird.

### A2. `gatt:writeSequence`

Schreibt mehrere Werte nacheinander auf **ein** Handle und liest es danach auf Wunsch einmal.

| Befehl | Payload | `result` | Timeout in `ble` |
|---|---|---|---|
| `gatt:writeSequence` | `GattWriteSequenceRequest` | `GattWriteSequenceResult` | 30 s |

Regeln:

1. Nur an Gateways, die `"writeSequence"` gemeldet haben. Ohne offene Verbindung: `NOT_CONNECTED`.
2. `data` hat 1 bis `MAX_WRITE_SEQUENCE_LENGTH` (64) Einträge, jeder Base64 und dekodiert 1 bis 512 Bytes. Sonst `INVALID_PAYLOAD`.
3. Der Lieferant schreibt die Einträge **in dieser Reihenfolge**. Mit `withResponse: true` wartet er vor dem nächsten Eintrag auf die Bestätigung des vorigen. Mit `withResponse: false` schickt er sie direkt hintereinander ab.
4. Schlägt ein Write fehl, schreibt der Lieferant nicht weiter und antwortet mit dem Fehler. Die Meldung nennt, wie viele Einträge geschrieben waren: `"... after <k> of <n> writes"`.
5. Mit `readAfter: true` liest der Lieferant nach dem letzten Write dasselbe Handle und gibt den Wert als `data` zurück. Mit `readAfter: false` fehlt `data` im Ergebnis.
6. Endet die Verbindung währenddessen, antwortet der Lieferant mit `NOT_CONNECTED` und meldet das Ende wie bisher mit `gateway:connectionState`.
7. Der Lieferant setzt für jeden einzelnen Write mit Antwort und für das Lesen dieselben Zeitlimits wie bei `gatt:write` und `gatt:read`.

### A3. Typen

In `src/lib/gateway-protocol.ts` (`ble`). `esphome` übernimmt nur, was es braucht, in seine eigenen Typen.

```ts
/** Optional commands a gateway can support */
export const GATEWAY_FEATURES = ["writeSequence"] as const;
export type GatewayFeature = (typeof GATEWAY_FEATURES)[number];

/** Most entries in one "gatt:writeSequence" */
export const MAX_WRITE_SEQUENCE_LENGTH = 64;

/** Payload of "gatt:writeSequence" */
export interface GattWriteSequenceRequest extends GattTarget {
	handle: number;
	/** The values to write, in this order, base64 encoded */
	data: string[];
	withResponse: boolean;
	/** Read the handle after the last write */
	readAfter: boolean;
}

/** Result of "gatt:writeSequence" */
export interface GattWriteSequenceResult {
	/** How many entries were written, always data.length */
	written: number;
	/** The value read after the last write, base64. Only with readAfter. */
	data?: string;
}
```

Dazu:

- `GattCommands.writeSequence = "gatt:writeSequence"`,
- `GatewayAnnouncement.features?: string[]` (A1),
- `GatewayInfo.features: GatewayFeature[]` (immer vorhanden, `[]` wenn keine).

---

## Teil B: Umsetzung in `ioBroker.ble`

Reihenfolge B1 bis B10. Nach jedem Schritt müssen die dort genannten Tests bestehen und `npm run check` sowie `npm run lint` sauber sein. Mach nach jedem Schritt einen Commit.

### B1. Typen und Features der Gateways

1. Typen aus A3 in `gateway-protocol.ts`.
2. `parseAnnounceMessage()` in `src/transports/remote-gateway.ts`: `features` nach A1 prüfen und als `GatewayFeature[]` weitergeben.
3. `GatewayRegistry.announce()`: `capabilities.features` übernehmen und am Gateway speichern. `GatewayInfo.features` in `list()` und `get()`. Gateways, die nie angemeldet wurden, haben `[]`.
4. `getGateways` liefert `features` mit (geschieht über `GatewayInfo`).

Tests (bestehende Dateien erweitern):

- `remote-gateway.test.ts`: `features` fehlt → `[]`; `["writeSequence", "other", "writeSequence"]` → `["writeSequence"]`; `features: "writeSequence"` → `INVALID_PAYLOAD`; `connect: false` mit `["writeSequence"]` → `[]`.
- `gateway-registry`-Tests: `features` kommt in `get()` an und wird bei der nächsten Anmeldung ersetzt.

### B2. Link, Session und Connection Manager

**`GattLink`** (`src/connections/gatt-link.ts`) bekommt:

```ts
/**
 * Writes the values to the handle in this order and reads it afterwards if readAfter is set.
 * Only for gateways with the feature "writeSequence", the ConnectionManager makes sure of that.
 * @returns The value read, undefined without readAfter
 */
writeSequence(handle: number, data: Buffer[], withResponse: boolean, readAfter: boolean): Promise<Buffer | undefined>;
```

**`RemoteGattLink`** (`src/transports/remote-gatt-link.ts`):

1. `GATT_TIMEOUTS_MS.writeSequence = 30000`.
2. Leeres `data` oder mehr als `MAX_WRITE_SEQUENCE_LENGTH` Einträge → `GatewayError("INVALID_PAYLOAD")`, ohne zu senden.
3. Sendet `gatt:writeSequence` wie die anderen Befehle. `result.data` fehlt bei `readAfter: true` oder ist kein gültiges Base64 → `GatewayError("GATT_ERROR", "Invalid answer to gatt:writeSequence")`.

`RemoteGattLink` prüft das Feature **nicht**, das macht der Connection Manager bei der Wahl des Gateways (Punkt 5).

**`GattSession`** (`src/connections/gatt-session.ts`):

```ts
public async writeSequence(service: string, characteristic: string, data: Buffer[], withResponse: boolean, readAfter: boolean): Promise<Buffer | undefined>;
```

Wie `write()`: Characteristic über die UUIDs suchen, `ensureOpen()`, dann `link.writeSequence(handle, …)`.

**`FakeLink`** (`src/connections/test-fakes.ts`): `writeSequence` schreibt jeden Eintrag wie `write()` (gleicher Eintrag in `calls`), danach bei `readAfter` wie `read()`. Zusätzlich ein Eintrag `"writeSequence <handle> <Anzahl> <withResponse> <readAfter>"` **vor** den einzelnen Writes.

**`ConnectionManager`** (`src/connections/connection-manager.ts`):

4. `SessionOptions.requireFeature?: GatewayFeature`. Ist es gesetzt, kommen nur Gateways in Frage, deren `features` den Wert enthalten. Gibt es keines, scheitert der Job mit `NO_GATEWAY` und der Meldung `"No gateway with <feature> receives <address>"`.
5. Neue öffentliche Methode:

    ```ts
    /** The gateway a session would try first, with the signal strength it receives the device with */
    public bestGateway(address: string, requireFeature?: GatewayFeature): { gatewayId: string; rssi: number } | undefined;
    ```

    Dieselbe Auswahl wie `getCandidates()` (mit Feature-Filter), das erste Ergebnis. `rssi` aus `devices.getReceivers()`.

Tests:

- `remote-gatt-link.test.ts`: gesendeter Payload (Base64, Reihenfolge, Flags); Ergebnis mit und ohne `readAfter`; leere Liste und 65 Einträge werden ohne Senden abgelehnt; fehlendes `data` bei `readAfter` → `GATT_ERROR`.
- `gatt-session.test.ts`: findet das Handle über die UUIDs; nach `close()` → `NOT_CONNECTED`.
- `connection-manager.test.ts`: mit `requireFeature` wird ein besser empfangendes Gateway ohne das Feature übersprungen; keines mit Feature → `NO_GATEWAY`; `bestGateway()` mit und ohne Feature.

### B3. Telink-OTA-Protokoll

Neue Datei `src/drivers/pvvx/ota-protocol.ts`. Nur reine Funktionen, keine Imports aus dem Adapter.

```ts
export const OTA_SERVICE = "00010203-0405-0607-0809-0a0b0c0d1912";
export const OTA_CHARACTERISTIC = "00010203-0405-0607-0809-0a0b0c0d2b12";
/** How data packets are written, see section 0, H1 */
export const OTA_WRITE_WITH_RESPONSE = false;
/** The status is read after this many data packets, see section 0, H2 */
export const PACKETS_PER_STATUS_READ = 8;
/** Largest image without the extended update */
export const MAX_IMAGE_SIZE = 0x20000;
export const OTA_CMD_VERSION = Buffer.from([0x00, 0xff]);
export const OTA_CMD_START = Buffer.from([0x01, 0xff]);

/** CRC-16/MODBUS: start 0xFFFF, reflected polynomial 0xA001, no final XOR */
export function crc16Modbus(data: Uint8Array): number;
/** CRC-32 of the Telink images: polynomial 0xEDB88320, start 0xFFFFFFFF, no final XOR */
export function crc32Telink(data: Uint8Array): number;

export type ImageProblem = "TOO_SMALL" | "TOO_LARGE" | "ZIGBEE" | "NO_SIGNATURE" | "BAD_LENGTH" | "BAD_CHECKSUM";
/** Checks an image as in docs/pvvx-protocol.md 6.2. Returns the length n of the image or the problem. */
export function validateImage(image: Buffer): { length: number } | { problem: ImageProblem };

/** The first n bytes of the image, padded with 0xFF to a multiple of 16, as blocks of 16 bytes */
export function toBlocks(image: Buffer, length: number): Buffer[];
/** Data packet: index (2 bytes LE), 16 bytes, CRC-16 over both (2 bytes LE) */
export function encodeDataPacket(index: number, block: Buffer): Buffer;
/** End packet: 02 ff, last index (LE), last index inverted (LE) */
export function encodeEndPacket(lastIndex: number): Buffer;
/** Text for a status byte of the update, docs/pvvx-protocol.md 6.6 */
export function otaStatusText(status: number): string;
```

Regeln:

1. `crc32Telink` mit einer eigenen Tabelle. **Nicht** `zlib.crc32` benutzen, das gibt es erst ab Node.js 20.15, CI läuft auch mit 18.
2. `validateImage` prüft in dieser Reihenfolge und gibt das erste Problem zurück:
    1. kleiner als 1024 Bytes → `TOO_SMALL`,
    2. größer als `MAX_IMAGE_SIZE` → `TOO_LARGE`,
    3. beginnt mit `1e f1 ee 0b` → `ZIGBEE`,
    4. Bytes 8 bis 11 ≠ `4b 4e 4c 54` → `NO_SIGNATURE`,
    5. `n = readUInt32LE(0x18)`; `n` > Größe, `n` < 1024 oder `(n & 0x0f) !== 4` → `BAD_LENGTH`,
    6. `readUInt32LE(n - 4) !== crc32Telink(image.subarray(0, n - 4))` → `BAD_CHECKSUM`.
3. `toBlocks`: nur die ersten `n` Bytes, die Datei kann länger sein.
4. `encodeEndPacket(last)`: `02 ff`, `last` als `writeUInt16LE`, `(~last) & 0xffff` als `writeUInt16LE`. 6 Bytes, **ohne** CRC.
5. `otaStatusText`: 1 `"packets lost"`, 2 `"packet CRC error"`, 3 `"flash write error"`, 4 `"last packets missing"`, 5 `"timeout"`, 6 `"image check failed"`, sonst `"unknown status <n>"`.

**Test-Image.** Neue Datei `src/drivers/pvvx/test-image.ts` (nur für Tests, wird von keinem Produktivcode importiert, die Integrationstests laden sie aus `build/`):

```ts
/** A valid image for the tests. size >= 1024 and (size & 0x0f) === 4. */
export function buildTestImage(size: number): Buffer;
```

Inhalt: Byte `i` = `(i * 7 + 3) & 0xff`; danach `"KNLT"` an Offset 8; `size` als `writeUInt32LE` an `0x18`; zuletzt `crc32Telink(bytes 0 bis size − 5)` als `writeUInt32LE` an `size − 4`. Wirft bei ungültigem `size`.

Tests in `src/drivers/pvvx/ota-protocol.test.ts`:

| Fall | Erwartung |
|---|---|
| `crc16Modbus("123456789")` (ASCII) | `0x4B37` |
| `crc32Telink("123456789")` (ASCII) | `0x340BC6D9` |
| Datenpaket 0, 1 und 5394 aus `docs/pvvx-protocol.md`, 7.4 (Daten aus den dort angegebenen Bytes) | genau die Pakete aus 7.4 |
| `encodeEndPacket(5394)` | `02ff1215edea` |
| 7.5: „Image“ aus 20 Bytes `0x01` → `toBlocks(image, 20)` | 2 Blöcke, Block 1 = 4 × `01` + 12 × `ff`; `encodeEndPacket(1)` = `02ff0100feff` |
| `buildTestImage(1028)` | `validateImage` → `{ length: 1028 }`; Prüfsumme an Offset 1024 = `0x596B95F7`; 65 Blöcke; Paket 0 = `0000030a11181f262d344b4e4c54575e656c93b5`; Paket 64 = `4000f7956b59ffffffffffffffffffffffffd59a`; Ende = `02ff4000bfff` |
| `buildTestImage(4100)` | 257 Blöcke; Prüfsumme `0xD5FB91B1`; Paket 256 = `0001b191fbd5ffffffffffffffffffffffff5912`; Ende = `02ff0001fffe` |
| Je ein Image pro Problem aus Regel 2 (aus `buildTestImage(1028)` abgeleitet, z. B. ein Byte in der Mitte geändert → `BAD_CHECKSUM`) | das jeweilige Problem |
| Datei länger als `n` (z. B. 16 Bytes angehängt) | gültig, `toBlocks` ignoriert den Rest |

### B4. Firmware-Katalog

Neue Datei `src/drivers/pvvx/firmware-catalog.ts`.

```ts
/** Where firmware.json and the images come from */
export interface FirmwareSource {
	/** The parsed firmware.json */
	getIndex(): Promise<unknown>;
	/** An image, path relative to the base URL, e.g. "bin/ATC_v59.bin" */
	getImage(path: string): Promise<Buffer>;
}

/** Loads from a base URL with fetch() */
export function createHttpFirmwareSource(baseUrl: string, fetchImpl?: typeof fetch): FirmwareSource;

export interface FirmwareIndex {
	/** Newest version, same encoding as the version byte of 0x55 (89 = 0x59 = "5.9") */
	version: number;
	/** Image path per hardware ID */
	custom: string[];
}
export function parseFirmwareIndex(json: unknown): FirmwareIndex | undefined;

export type ImageSelection =
	| { path: string; version: number }
	| { problem: "UNKNOWN_HARDWARE" | "NO_IMAGE" | "UP_TO_DATE" };
/** docs/pvvx-protocol.md 6.3 */
export function selectImage(index: FirmwareIndex, hardwareId: number | undefined, installedVersion: number): ImageSelection;

export class FirmwareCatalog {
	public constructor(source: FirmwareSource, clock: Clock);
	/** firmware.json, loaded again when older than INDEX_MAX_AGE_MS or when refresh is set. Rejects with PvvxUpdateError("DOWNLOAD_FAILED"). */
	public getIndex(refresh?: boolean): Promise<FirmwareIndex>;
	/** The image, loaded once per path and kept in memory. Rejects with PvvxUpdateError("DOWNLOAD_FAILED" | "INVALID_IMAGE"). */
	public getImage(path: string): Promise<{ image: Buffer; length: number }>;
}
```

Regeln:

1. `createHttpFirmwareSource`: Basis-URL ohne `/` am Ende bekommt eins. `fetch` mit `AbortController` und 30 s Zeitlimit. Status ≠ 200 → Fehler mit Status in der Meldung. `getImage` bricht ab, wenn `content-length` oder die gelesene Größe über 256 KiB liegt. `getIndex` liest JSON. Pfade mit `..` oder beginnend mit `/` werden abgelehnt.
2. `parseFirmwareIndex`: `version` muss eine ganze Zahl von 1 bis 255 sein, `custom` ein Array aus Strings. Sonst `undefined`.
3. `selectImage`:
    1. `hardwareId` fehlt, ist negativ oder `>= custom.length` → `UNKNOWN_HARDWARE`.
    2. Eintrag endet nicht auf `.bin` (auch `"?"`) → `NO_IMAGE`.
    3. `installedVersion >= index.version` → `UP_TO_DATE`.
    4. Sonst `{ path, version: index.version }`.
4. `INDEX_MAX_AGE_MS = 6 h`. `getImage` prüft mit `validateImage`. Problem → `PvvxUpdateError("INVALID_IMAGE", "<path>: <problem>")`. Ungültige Images werden nicht gespeichert.
5. Die Listen `original` und `signed` liest der Code nicht.

`PvvxUpdateError` legst du in `src/drivers/pvvx/update-error.ts` an: `class PvvxUpdateError extends Error { constructor(public readonly code: string, message: string) }`, `name = "PvvxUpdateError"`.

Tests in `src/drivers/pvvx/firmware-catalog.test.ts` (ohne Netz, mit einer Fake-`FirmwareSource` und einem Fake-`fetch`):

- `parseFirmwareIndex` mit einem Auszug der echten Datei (`version: 89`, `custom` mit `"bin/ATC_v59.bin"` an Index 0 und `"?"` an Index 15) und mit kaputten Varianten.
- `selectImage`: alle vier Fälle.
- `FirmwareCatalog`: der Index wird gecacht und nach 6 h (Fake-Uhr) neu geladen; `refresh: true` lädt sofort; ein ungültiges Image → `INVALID_IMAGE`; ein Image wird nur einmal geladen.
- `createHttpFirmwareSource` mit Fake-`fetch`: URL-Zusammenbau mit und ohne `/`; Status 404 → Fehler; Größe über 256 KiB → Fehler; `../x.bin` wird ohne Aufruf abgelehnt.

### B5. Übertragung

Neue Datei `src/drivers/pvvx/ota-transfer.ts`:

```ts
export interface TransferOptions {
	/** Called after every status read and at the end, with values from 0 to 1 */
	onProgress(fraction: number): void;
	/** Waits, the adapter passes its timers */
	sleep(ms: number): Promise<void>;
}

/** Transfers the image. Resolves after the end packet was sent. */
export async function transferImage(session: GattSession, image: Buffer, length: number, options: TransferOptions): Promise<void>;
```

Ablauf, genau in dieser Reihenfolge:

1. `blocks = toBlocks(image, length)`, `N = blocks.length`.
2. `session.write(OTA_SERVICE, OTA_CHARACTERISTIC, OTA_CMD_VERSION, OTA_WRITE_WITH_RESPONSE)`.
3. `session.write(…, OTA_CMD_START, OTA_WRITE_WITH_RESPONSE)`.
4. `await sleep(300)`.
5. Für `start = 0, 8, 16, …`: Pakete `start` bis `min(start + PACKETS_PER_STATUS_READ, N) − 1` mit `encodeDataPacket`. `full` = es sind genau `PACKETS_PER_STATUS_READ` Pakete.
    - `result = await session.writeSequence(OTA_SERVICE, OTA_CHARACTERISTIC, packets, OTA_WRITE_WITH_RESPONSE, full)`.
    - Bei `full`: `result` fehlt oder ist leer → `PvvxUpdateError("UNEXPECTED_ANSWER", "Empty update status")`. `result[0] !== 0` → `PvvxUpdateError("OTA_STATUS_<n>", otaStatusText(n))`.
    - `onProgress((start + packets.length) / N)`.

    Nach einem unvollständigen letzten Block wird **nicht** gelesen, wie in den Referenzen (`docs/pvvx-protocol.md`, 9.7).
6. Ende-Paket `encodeEndPacket(N − 1)` mit `session.write(…, false)`, **immer ohne Antwort**. Fehler mit Code `NOT_CONNECTED` oder `TIMEOUT` hier ignorieren: Das Gerät startet neu, die Verbindung bricht ab. Andere Fehler weiterwerfen.
7. `onProgress(1)`.

Tests in `src/drivers/pvvx/ota-transfer.test.ts` mit einem simulierten Update-Empfänger. Erweitere dafür `FakePvvxDevice` (`fake-pvvx-device.ts`):

- `getServices()` liefert zusätzlich den Service `OTA_SERVICE` (Handle 40) mit `OTA_CHARACTERISTIC` (Handle 42, `properties: 0x06`, Read und Write Without Response, keine Descriptors).
- `writeSequence(handle, data, withResponse, readAfter)`: jeder Eintrag wie `write()`, danach bei `readAfter` wie `read(handle)`.
- Schreiben auf Handle 42: `ota.writes` hält jedes Paket fest. `01 ff` setzt `ota.started`. Datenpakete (20 Bytes): Index muss der erwartete sein (sonst `ota.status = 1`), CRC muss stimmen (sonst `2`), Daten werden an `ota.received` angehängt. Ende-Paket (6 Bytes `02 ff …`): prüft den letzten Index (sonst `4`), prüft das empfangene Image mit `validateImage` (sonst `6`), setzt bei Erfolg `ota.finished = true` und `configResponse[1] = ota.newVersion`.
- `read(42)` liefert `Buffer.from([ota.status])`. `read(32)` bleibt wie bisher.
- Einstellbar: `ota.failStatusAfterPackets: { after: number; status: number }` (ab diesem Paket meldet der Status `status`), `ota.newVersion` (Standard `0x60`), `ota.dropAfterPackets` (nach so vielen Datenpaketen lehnt jeder weitere Write mit `GatewayError("NOT_CONNECTED")` ab).

Pflichtfälle:

1. `buildTestImage(4100)`: Writes in der Reihenfolge `00ff`, `01ff`, 257 Datenpakete, Ende-Paket; das empfangene Image ist byteweise gleich; `finished` ist gesetzt. 32 `writeSequence`-Aufrufe mit `readAfter: true`, einer (der letzte mit einem Paket) mit `readAfter: false`. Zwischen `01ff` und dem ersten Datenpaket wurde `sleep(300)` aufgerufen.
2. Alle Writes mit `withResponse === OTA_WRITE_WITH_RESPONSE`, das Ende-Paket mit `false`.
3. `onProgress` steigt monoton und endet bei 1.
4. `failStatusAfterPackets: { after: 20, status: 2 }` → `OTA_STATUS_2`, Meldung `"packet CRC error"`, danach wird nichts mehr geschrieben.
5. `dropAfterPackets: 40` → `NOT_CONNECTED`, kein Ende-Paket.
6. Das Ende-Paket scheitert mit `NOT_CONNECTED` → `transferImage` löst trotzdem auf.
7. `buildTestImage(1028)` (65 Blöcke, 8 volle Gruppen und ein einzelnes Paket) funktioniert gleich.

### B6. Vorab-Prüfungen

Neue Datei `src/drivers/pvvx/ota-checks.ts`:

```ts
export const MIN_BATTERY_PERCENT = 40;
/** A battery value older than this is not used */
export const MAX_BATTERY_AGE_MS = 3600000;
export const MIN_RSSI = -80;

export interface PreconditionInput {
	/** The device, for the messages */
	address: string;
	now: number;
	/** The state <mac>.battery, undefined if it does not exist */
	battery: { val: unknown; ts: number } | undefined;
	/** From ConnectionManager.bestGateway(address, "writeSequence") */
	bestGateway: { gatewayId: string; rssi: number } | undefined;
}

/** Throws PvvxUpdateError if the device must not be updated now */
export function checkPreconditions(input: PreconditionInput): void;
```

Reihenfolge:

1. `bestGateway` fehlt → `NO_GATEWAY`, `"No gateway that can update firmware receives the device"`.
2. `bestGateway.rssi < MIN_RSSI` → `WEAK_SIGNAL`, Meldung mit RSSI und Gateway.
3. `battery` fehlt, `val` ist keine Zahl oder `now - ts > MAX_BATTERY_AGE_MS` → `BATTERY_UNKNOWN`, `"No current battery value in <mac>.battery. The device must send its battery level, e.g. in the BTHome format."`.
4. `val < MIN_BATTERY_PERCENT` → `BATTERY_LOW`, Meldung mit dem Wert.

Der Batteriewert kommt aus dem State `<mac>.battery`, den die Decoder `bthome` und `xiaomi` anlegen. Die Konfiguration des pvvx-Geräts bestimmt, welches Format es sendet.

Tests in `src/drivers/pvvx/ota-checks.test.ts`: jeder Fall einzeln, dazu Grenzwerte (Batterie genau 40 und RSSI genau −80 sind erlaubt, Wert genau 1 h alt ist erlaubt).

### B7. Der Updater

Neue Datei `src/drivers/pvvx/pvvx-updater.ts`, Klasse `PvvxUpdater`.

```ts
export interface PvvxUpdaterContext {
	adapter: Pick<ioBroker.Adapter, "namespace" | "log" | "setObjectNotExistsAsync" | "setStateAsync" | "getStateAsync">;
	connections: Pick<ConnectionManager, "withSession" | "bestGateway">;
	catalog: FirmwareCatalog;
	clock: Clock;
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(t: any): void;
	setInterval(cb: () => void, ms: number): unknown;
	clearInterval(t: any): void;
	/** Sets the clock of the device soon, PvvxDriver.requestSync() */
	requestTimeSync(address: string): void;
}

export interface PvvxUpdaterOptions {
	addresses: string[];
	/** Setting pvvxFirmwareCheck */
	dailyCheck: boolean;
}

export class PvvxUpdater {
	public constructor(ctx: PvvxUpdaterContext, options: PvvxUpdaterOptions);
	/** Creates the objects, schedules the checks. Does nothing without addresses. */
	public start(): Promise<void>;
	/** Updates firmwareAvailable of all devices. Public for tests. */
	public checkAll(refresh: boolean): Promise<void>;
	/** Queues the update of a device. Resolves when it is finished (done or failed). Public for tests. */
	public update(address: string): Promise<void>;
	/** Whether an update of the device is queued or running */
	public isBusy(address: string): boolean;
	/** Handles the buttons. Returns true if the state belongs to the updater. */
	public handleStateChange(id: string, state: ioBroker.State | null | undefined): boolean;
	public dispose(): void;
}
```

Konstanten im Modul (exportiert):

| Name | Wert | Bedeutung |
|---|---|---|
| `CHECK_START_DELAY_MS` | 120000 | Erste Prüfung nach dem Start |
| `CHECK_INTERVAL_MS` | 24 h | Abstand der täglichen Prüfung |
| `OTA_SESSION_TIMEOUT_MS` | 600000 | `timeoutMs` der Update-Session (H4) |
| `VERIFY_DELAY_MS` | 15000 | Warten nach dem Ende-Paket (H5) |
| `VERIFY_ATTEMPTS` | 3 | Versuche, die neue Version zu lesen (H5) |
| `VERIFY_RETRY_MS` | 30000 | Abstand der Versuche (H5) |
| `PROGRESS_STEP` | 1 | `firmwareProgress` wird nur bei einer Änderung um mindestens so viele Prozentpunkte geschrieben |

**`start()`:**

1. Ohne Adressen: sofort zurück.
2. Instanz-Objekte aus Abschnitt 2 und pro Gerät die fünf neuen States mit `setObjectNotExistsAsync`. Device und Channel `<mac>.pvvx` legt schon `PvvxDriver.start()` an, das läuft vorher (B9).
3. Pro Gerät `firmwareStatus` = `idle`, `firmwareProgress` = 0, beide `ack: true`. Nur wenn der State noch keinen Wert hat oder `queued`, `checking`, `transferring` oder `verifying` zeigt (ein Neustart mitten im Update): dann `idle` und `firmwareError` = `"NOT_CONNECTED: The adapter was restarted during the update"`.
4. Bei `dailyCheck`: `setTimeout(CHECK_START_DELAY_MS)` für die erste Prüfung, danach `setInterval(CHECK_INTERVAL_MS)`. Beide rufen `void this.checkAll(false)`.

**`checkAll(refresh)`** (verbindet sich mit keinem Gerät):

1. `index = await catalog.getIndex(refresh)`. Fehler → `log.warn("Could not load the pvvx firmware list: <Meldung>")`, sonst nichts.
2. Pro Gerät: `hardwareId` und `firmwareVersion` aus den States von Phase 3 lesen (`getStateAsync`). `firmwareVersion` ist ein String wie `"5.9"`: zurückrechnen mit `(major << 4) | minor`; ein String in anderer Form gilt als unbekannt. Fehlt einer der Werte: `firmwareAvailable` nicht ändern.
3. `selectImage(index, hardwareId, version)`: Ergebnis mit `path` → `firmwareAvailable = formatVersion(result.version)`, sonst `""`.
4. Mehrere gleichzeitige Aufrufe von `checkAll` laufen nicht parallel. Ein zweiter wartet nicht, er kehrt sofort zurück.

**`update(address)`:**

Updates laufen über eine Warteschlange, **immer nur eines gleichzeitig**. Ist die Adresse schon in der Warteschlange oder läuft ihr Update, kehrt der Aufruf sofort zurück (Log `info`).

1. Status `queued`, `firmwareProgress` 0, `firmwareError` unverändert.
2. Ist das Update dran: Status `checking`.
3. `checkPreconditions({ address, now, battery: await getStateAsync("<mac>.battery"), bestGateway: connections.bestGateway(address, "writeSequence") })`.
4. `index = await catalog.getIndex(false)`.
5. Session:

    ```ts
    await ctx.connections.withSession(address, async (session) => {
    	const channel = new PvvxCommandChannel(session, ctx);
    	await channel.open();
    	const config = parseConfigResponse(await channel.request(encodeConfigRequest()));
    	if (!config) throw new PvvxProtocolError("The device did not answer like a pvvx firmware");
    	const selection = selectImage(index, config.hardwareId, config.version);
    	if ("problem" in selection) throw new PvvxUpdateError(selection.problem, …);
    	const { image, length } = await ctx.catalog.getImage(selection.path);
    	// Status transferring, then:
    	await transferImage(session, image, length, { onProgress, sleep });
    	expected = selection.version;
    }, { priority: "high", timeoutMs: OTA_SESSION_TIMEOUT_MS, requireFeature: "writeSequence" });
    ```

    Meldungen für `UP_TO_DATE`: `"Version <installiert> is installed, <neueste> is the newest"`; `UNKNOWN_HARDWARE`: `"Hardware ID <id> is not in firmware.json"` (bzw. `"unknown"`); `NO_IMAGE`: `"There is no BLE firmware for hardware ID <id>"`.

    `onProgress(f)`: `firmwareProgress = Math.floor(f * 99)` (100 erst nach der Prüfung), nur bei einer Änderung um mindestens `PROGRESS_STEP`.

6. Status `verifying`. `await sleep(VERIFY_DELAY_MS)`. Dann bis zu `VERIFY_ATTEMPTS` Versuche im Abstand von `VERIFY_RETRY_MS`: `withSession(address, …, { timeoutMs: 45000 })` mit `channel.open()` und `55`. Erster Versuch, der eine gültige Antwort liefert, entscheidet: `version === expected` → Erfolg, sonst `VERIFY_FAILED` mit `"Version <gelesen> after the update, expected <erwartet>"`. Scheitern alle Versuche an der Verbindung: `VERIFY_FAILED` mit dem letzten Fehler in der Meldung.
7. **Erfolg:** `firmwareVersion` (State aus Phase 3) = `formatVersion(expected)`, `firmwareAvailable` = `""`, `firmwareProgress` = 100, `firmwareError` = `""`, Status `done`. Log `info`: `"Updated the firmware of <mac> to <version>"`. Dann `ctx.requestTimeSync(address)`: Nach einem Neustart kann die Uhr falsch gehen.
8. **Fehler** (in jedem Schritt): Status `failed`, `firmwareError` = `"<code>: <message>"` (Code wie in Phase 3 B6, Regel 6), `firmwareProgress` bleibt stehen. Log `warn`: `"The firmware update of <mac> failed: <firmwareError>"`. Das Gerät behält seine alte Firmware (`docs/pvvx-protocol.md`, 6.1).
9. Ein Fehler beim Schreiben der States wird mit `log.warn` protokolliert und nicht weitergeworfen. Nach `dispose()` werden keine States mehr geschrieben.

`sleep(ms)` ist ein Promise über `ctx.setTimeout`. Nach `dispose()` löst ein laufendes `sleep` nicht mehr auf, damit nichts weiterläuft.

**`handleStateChange(id, state)`:** wie in Phase 3 B6. Bei `ack: false` und wahrem Wert:

- `<namespace>.<mac>.pvvx.firmwareUpdate` eines konfigurierten Geräts → Knopf quittieren, `void this.update(mac)`.
- `<namespace>.pvvx.updateAll` → Knopf quittieren, für jedes Gerät mit `firmwareAvailable` ≠ `""` `void this.update(mac)`, in der Reihenfolge der Einstellung.
- `<namespace>.pvvx.checkFirmware` → Knopf quittieren, `void this.checkAll(true)`.

Alle drei geben `true` zurück, auch bei `ack: true`. Andere IDs → `false`.

**`dispose()`:** Timer löschen, Warteschlange leeren (wartende Updates bekommen keinen Status mehr), Merker setzen. Die laufende Session bricht `ConnectionManager.dispose()` ab.

**Änderung an `PvvxDriver` (Phase 3):**

- Neue Methode `public requestSync(address: string): void`: wie der Knopf (`nextDue = 0`, `failures = 0`, `void this.tick()`), ohne State.
- `PvvxDriverContext` bekommt optional `isBusy?(address: string): boolean`. In `tick()` wird ein fälliges Gerät mit `isBusy(address) === true` übersprungen und `nextDue = now + RETRY_DELAYS_MS[0]` gesetzt, ohne `failures` zu ändern. So blockiert ein laufendes Update nicht den Zeitsync der anderen Geräte.

Tests in `src/drivers/pvvx/pvvx-updater.test.ts`. Kein echter Timer und kein Netz: Fake-Kontext wie in `pvvx-driver.test.ts`, `sleep` löst sofort auf (Fake-`setTimeout` ruft den Callback direkt auf), Fake-`FirmwareSource` mit `firmware.json` `{ version: 0x60, custom: ["bin/test.bin"] }` und `buildTestImage(4100)` als Image, `FakePvvxDevice` mit OTA-Simulation (B5) hinter einem Fake-`connections`, dessen `withSession` die Optionen festhält und dessen `bestGateway` einstellbar ist.

1. `start()` legt die Instanz-Objekte und pro Gerät die fünf States an; `firmwareStatus` ist `idle`.
2. `start()` nach einem Neustart mitten im Update (`firmwareStatus` war `transferring`) → `idle` und der Fehlertext.
3. `checkAll`: `firmwareVersion "5.9"`, `hardwareId 0` → `firmwareAvailable "6.0"`; `"6.0"` → `""`; fehlende `hardwareId` → unverändert; `firmware.json` nicht ladbar → `warn`, nichts geändert.
4. Tägliche Prüfung: mit `dailyCheck: false` kein Timer; mit `true` ein Timeout über `CHECK_START_DELAY_MS` und ein Intervall über `CHECK_INTERVAL_MS`.
5. Erfolg: Status-Folge `queued`, `checking`, `transferring`, `verifying`, `done`; Gerät `finished`; `firmwareVersion "6.0"`, `firmwareAvailable ""`, `firmwareProgress 100`, `firmwareError ""`; `requestTimeSync` mit der Adresse aufgerufen; `withSession` der Update-Session mit `{ priority: "high", timeoutMs: OTA_SESSION_TIMEOUT_MS, requireFeature: "writeSequence" }`.
6. `firmwareProgress` wird nicht öfter als 100-mal geschrieben und steigt monoton.
7. `BATTERY_LOW`, `BATTERY_UNKNOWN`, `WEAK_SIGNAL`, `NO_GATEWAY`: Status `failed`, passender Code, `withSession` wurde nicht aufgerufen.
8. `UP_TO_DATE` (Gerät meldet `0x60`), `NO_IMAGE` (Eintrag `"?"`), `UNKNOWN_HARDWARE` (ID 5 bei einer Liste mit einem Eintrag): kein Write auf Handle 42.
9. `INVALID_IMAGE`: Fake-Quelle liefert ein Image mit falscher Prüfsumme → kein Write auf Handle 42.
10. Abbruch: `dropAfterPackets: 40` → `failed` mit `NOT_CONNECTED`, Version im Gerät unverändert. Danach `dropAfterPackets` aus, `update()` erneut → `done`.
11. `OTA_STATUS_2` → `failed`, Meldung `"packet CRC error"`.
12. `VERIFY_FAILED`: Gerät meldet nach dem Ende-Paket die alte Version (`ota.newVersion = 0x59`).
13. Warteschlange: `update(a)` und `update(b)` direkt nacheinander → b wird erst verbunden, wenn a fertig ist; `update(a)` ein zweites Mal, während a läuft → keine zweite Session; `isBusy` ist währenddessen `true` und danach `false`.
14. `updateAll` startet nur Geräte mit `firmwareAvailable` ≠ `""`.
15. Knöpfe: wie Phase 3 Test 11 für alle drei; fremde ID → `false`.
16. Nach `dispose()` keine State-Writes mehr.

Dazu in `pvvx-driver.test.ts`: `requestSync` stellt das Gerät sofort; ein Gerät mit `isBusy` wird übersprungen und 5 Minuten später erneut versucht, ohne dass `failures` steigt.

### B8. Einstellungen und Admin

- `io-package.json`, `native`: `"pvvxFirmwareCheck": true`, `"pvvxFirmwareUrl": "https://raw.githubusercontent.com/pvvx/ATC_MiThermometer/master/"`.
- `src/lib/adapter-config.d.ts`: beide optional, mit Kommentar.
- `admin/src/index.tsx`: Checkbox für `pvvxFirmwareCheck` mit Hilfetext aus Abschnitt 2, neben den pvvx-Feldern aus Phase 3. Fehlender Wert gilt als `true`. Kein Feld für `pvvxFirmwareUrl`. Texte in allen 10 Dateien unter `admin/src/i18n/`.

### B9. Einbau in den Adapter

In `src/main.ts`, nach dem Anlegen von `PvvxDriver`:

1. `const catalog = new FirmwareCatalog(createHttpFirmwareSource(url), systemClock)` mit `url` = `adapter.config.pvvxFirmwareUrl`, wenn ein nicht leerer String, sonst der Standard aus B8.
2. `pvvxUpdater = new PvvxUpdater({ adapter, connections, catalog, clock: systemClock, <Timer über die Adapter-Methoden>, requestTimeSync: (a) => pvvx?.requestSync(a) }, { addresses, dailyCheck: adapter.config.pvvxFirmwareCheck !== false })`.
3. `PvvxDriver` bekommt `isBusy: (a) => pvvxUpdater?.isBusy(a) ?? false`. Lege dafür beide Objekte an, bevor einer von ihnen startet.
4. In `ready`: `await pvvx.start()`, dann `await pvvxUpdater.start()`.
5. `stateChange`: `if (pvvxUpdater?.handleStateChange(id, state)) return;` direkt nach der Zeile für `pvvx`.
6. `unload`: `pvvxUpdater?.dispose()` vor `pvvx?.dispose()`.

### B10. Integrationstests

**`test/integrationTests/fakeGattGateway.js`:**

1. `SERVICES` um den Update-Service erweitern: Service `OTA_SERVICE`, Handle 40, Characteristic `OTA_CHARACTERISTIC`, Handle 42, `properties: 0x06`, ohne Descriptors. Die Tests von Phase 2 und 3 müssen danach unverändert bestehen.
2. `gatt:writeSequence` nach A2: jeden Eintrag wie `gatt:write` behandeln (inklusive Write-Handler und `values`), danach bei `readAfter` wie `gatt:read`. Vor jedem Eintrag prüfen, ob die Verbindung noch offen ist, sonst mit `NOT_CONNECTED` antworten. In `commands` landet **ein** Eintrag für den ganzen Befehl.
3. Neue Methode `setReadHandler(handler)`: `handler(address, handle)` liefert Hex oder `undefined` (dann wie bisher `values`).
4. Neue Methode `dropConnection(address)`: entfernt die offene Verbindung und schickt `gateway:connectionState` mit `connected: false` an `ble.0`, wie ein Lieferant.

**`test/integrationTests/fakePvvxThermometer.js`:** `createPvvxHandler` simuliert zusätzlich den Update-Empfänger wie `FakePvvxDevice` in B5 (gleiche Regeln, gleiche Optionen `ota.newVersion`, `ota.dropAfterPackets`, `ota.failStatusAfterPackets`) und liefert dazu `readHandler` für Handle 42. Der Handler bekommt die Option `onDisconnect(address)`, die der Test auf `(a) => gateway.dropConnection(a)` setzt. Der Handler ruft sie auf, wenn `dropAfterPackets` erreicht ist, und nach einem Ende-Paket mit gültigem Image (das Gerät startet neu).

**Firmware-Server:** In der Suite einen `http.createServer` auf `127.0.0.1`, Port 0, mit `/firmware.json` (`{ "version": 96, "custom": ["bin/test.bin", "?"] }`) und `/bin/test.bin` (`buildTestImage(4100)` aus `build/drivers/pvvx/test-image.js`). Er zählt die Abrufe pro Pfad. `pvvxFirmwareUrl` = `http://127.0.0.1:<port>/`.

`test/integrationTests/helpers.js`: Paket `PACKETS.bthomeThermometerLowBattery` mit den Service-Daten `"d2fc" + "4000a7011402c40903bf13"`: wie `bthomeThermometer`, aber Paketnummer `0xa7` (sonst gilt es als Duplikat) und Batterie 20 %.

Neue Datei `test/integrationTests/pvvx_ota_tests.js`, in `index.js` registrieren. Gerät `a4:c1:38:12:34:56`, Konfiguration `{ plugins: "bthome", pvvxDevices: "a4:c1:38:12:34:56", pvvxFirmwareCheck: false, pvvxFirmwareUrl: … }`. Vorbereitung: `proxy-og` meldet sich mit `connect: true, freeSlots: 3, slotLimit: 3, features: ["writeSequence"]` an, dann `deliver()` von `PACKETS.bthomeThermometer` über `proxy-og` (setzt `<mac>.battery` = 100). **Wichtig:** Das Gerät muss als neues Gerät angenommen werden (`allowNewDevices`), sonst entsteht `battery` nicht.

Suite `pvvx - firmware update`:

1. `creates the firmware states`: die fünf States pro Gerät, `pvvx.checkFirmware`, `pvvx.updateAll`; `firmwareStatus` ist `idle`.
2. `shows a newer firmware after a check`: `hardwareId` und `firmwareVersion` erst per Zeitsync-Knopf (Phase 3) füllen lassen, dann `pvvx.checkFirmware` → `firmwareAvailable` wird `"6.0"`. Der Server hat `firmware.json` abgerufen, das Image nicht.
3. `updates the firmware`: `firmwareUpdate` drücken. Warten auf `firmwareStatus` `done` (Zeitlimit 120 s). Dann: der Thermometer-Handler hat 257 Datenpakete lückenlos bekommen und `finished` gesetzt; `firmwareVersion "6.0"`, `firmwareAvailable ""`, `firmwareProgress 100`, `firmwareError ""`; in `gateway.commands` gibt es seit dem Knopf 33 `gatt:writeSequence` mit höchstens 8 Einträgen; alle mit `withResponse: false`; danach kam eine neue Verbindung mit einem Write `23` + 4 Bytes (Zeitsync).
4. `keeps the old firmware when the connection is lost`: Gerät zurück auf Version `0x59` setzen, `ota.dropAfterPackets = 40`. Knopf → `failed`, `firmwareError` beginnt mit `"NOT_CONNECTED: "`, `ota.finished` nicht gesetzt. `dropAfterPackets` aus, Knopf → `done`.
5. `refuses a device with a low battery`: `deliver()` von `bthomeThermometerLowBattery`, Knopf → `failed` mit `"BATTERY_LOW: "`, kein `gatt:connect` seit dem Knopf.

Suite `pvvx - firmware update without a capable gateway`: Anmeldung von `proxy-og` **ohne** `features`, sonst wie oben. Knopf → `failed` mit `"NO_GATEWAY: "`, kein `gatt:connect`.

---

## Teil C: Umsetzung in `ioBroker.esphome`

Auf dem Branch, auf dem Phase 2 Teil C liegt. Wenn er schon in `main` gemergt ist, ein neuer Branch von `main`.

### C1. Feature melden

`announce()` in `src/lib/bleGattBridge.ts`: Jeder Proxy mit `connect: true` bekommt `features: ["writeSequence"]`. Proxies mit `connect: false` bekommen kein `features`.

### C2. `gatt:writeSequence`

In `BleGattBridge`:

1. `parse()`: für `gatt:writeSequence` wie bei `gatt:write` `handle` und `withResponse` prüfen, dazu `data` (Array, 1 bis 64 Einträge, jeder ein gültiger Base64-String, dekodiert 1 bis 512 Bytes) und `readAfter` (boolean). Sonst `INVALID_PAYLOAD`.
2. Konstanten: `MAX_WRITE_SEQUENCE_LENGTH = 64`, `WRITE_SEQUENCE_GAP_MS = 0` (H3).
3. Ausführung, Eintrag für Eintrag:
    - Vor jedem Eintrag prüfen, dass die Verbindung noch in `proxy.connections` ist, sonst `NOT_CONNECTED` mit `"... after <k> of <n> writes"`.
    - `withResponse: true`: genau wie `write()` mit Antwort (`BluetoothGATTWriteResponse` mit Adresse und Handle, Zeitlimit `TIMEOUTS_MS.write`). Ein Fehler bricht ab, die Meldung bekommt `" after <k> of <n> writes"` angehängt, der Code bleibt.
    - `withResponse: false`: `sendMessage` wie bei `write()` ohne Antwort. Ist `WRITE_SEQUENCE_GAP_MS > 0`, danach so lange über `adapter.setTimeout` warten.
4. Danach bei `readAfter` genau wie `read()`. Ergebnis `{ written: n, data }`, ohne `readAfter` `{ written: n }`.
5. Kein neuer Weg, Antworten zuzuordnen: benutze `request()` wie die anderen Befehle.

### C3. Unit-Tests

In `src/lib/bleGattBridge.test.ts`:

1. `announce` enthält `features: ["writeSequence"]` bei Proxies, die verbinden können.
2. Drei Einträge ohne Antwort mit `readAfter: true`: drei `BluetoothGATTWriteRequest` in der Reihenfolge, jeweils `response: false`, danach ein `BluetoothGATTReadRequest`; Antwort `{ written: 3, data }`.
3. Mit Antwort: der zweite Write wird erst gesendet, wenn die Bestätigung des ersten da ist.
4. Fehler beim zweiten Write (`BluetoothGATTErrorResponse`): `GATT_ERROR`, Meldung endet auf `"after 1 of 3 writes"`, der dritte wird nicht gesendet.
5. Verbindung endet nach dem ersten Write (unaufgeforderte `BluetoothDeviceConnectionResponse` mit `connected: false`) bei `withResponse: true` → `NOT_CONNECTED`.
6. `INVALID_PAYLOAD` für: leeres Array, 65 Einträge, kein Array, ungültiges Base64, fehlendes `readAfter`.

### C4. Integrationstests

`test/integrationTests/ble_gatt_tests.js`, Suite „connections through a Bluetooth proxy“:

1. Die Erwartung an die Anmeldung um `features: ["writeSequence"]` ergänzen.
2. Neuer Test `writes a sequence and reads the handle afterwards`: Verbindung aufbauen, `gatt:writeSequence` mit `["01", "02", "03"]` (Hex, als Base64 gesendet), `withResponse: false`, `readAfter: true` → `{ written: 3, data: <Base64 von 03> }`; `proxy.gattLog` enthält die drei Writes in der Reihenfolge, danach `read 32`.
3. Neuer Test mit `withResponse: true` und zwei Einträgen.

### C5. Dokumentation

- `README.md`, Abschnitt „Bluetooth proxies“: ein Satz, dass die Proxies dem BLE-Adapter auch Firmware-Updates von pvvx-Thermometern ermöglichen. Changelog-Zeile.
- `AGENTS.md`, Abschnitt „GATT connections“: `gatt:writeSequence` und `WRITE_SEQUENCE_GAP_MS` beschreiben.

Fertig mit Teil C, wenn `./node_modules/.bin/eslint --max-warnings 0 .`, `npm run check`, `npm run build`, `npm test` und `npm run test:integration` bestehen.

---

## 3. Gegenprobe über beide Repos

Wie in Phase 2, Abschnitt 3: ein Wegwerf-Skript (nicht einchecken), das `BleGattBridge` und `BleForwarder` aus `build/` von `esphome` mit einem echten Native-API-Client gegen `fakeBluetoothProxy.js` verbindet und `RemoteGatewayTransport` aus `build/` von `ble` direkt daran hängt. Es prüft:

1. Die Anmeldung kommt mit `features: ["writeSequence"]` in `ble` an.
2. `link.writeSequence(32, [3 Buffer], false, true)` liefert den zuletzt geschriebenen Wert, und der Fake-Proxy hat die drei Writes in der Reihenfolge bekommen.
3. Dasselbe mit `withResponse: true`.

Nenne das Ergebnis im Abschlussbericht.

## 4. Dokumentation in `ble`

- `README.md`: Neuer Abschnitt „Updating the firmware of pvvx thermometers“ nach „Setting the clock of pvvx thermometers“. Inhalt: wozu, die Knöpfe und States, die tägliche Prüfung und woher die Firmware kommt (GitHub, `firmware.json` von pvvx, nur pvvx-BLE-Firmware), die Vorab-Prüfungen (Batterie ≥ 40 % aus `<mac>.battery`, Empfang ≥ −80 dBm, Gateway mit Firmware-Update-Unterstützung, also ein aktuelles ioBroker.esphome), dass ein Update einige Minuten dauert, dass bei einem Abbruch die alte Firmware erhalten bleibt, dass Geräte mit PIN-Code nicht gehen. **Ein deutlicher Hinweis:** Ein Firmware-Update geschieht auf eigenes Risiko. In `gateway:announce` die neue Option `features` und den Befehl `gatt:writeSequence` im Abschnitt „Connecting to devices“ ergänzen. Changelog-Zeile.
- `AGENTS.md`: die neuen Dateien in `src/drivers/pvvx/` im Abschnitt „Layout“.
- `docs/plan-bluetooth-infrastructure.md`: nur die Statuszeile, die Statustabelle, die Zeile von Phase 4 in Abschnitt 7 und die nächsten Schritte in Abschnitt 9.

Fertig, wenn alle Befehle aus `AGENTS.md` (Abschnitt „Commands“) in beiden Repos bestehen und `build/` in `ble` neu gebaut und eingecheckt ist.

## 5. Abschlussbericht

Schreibe am Ende in deiner Antwort (nicht in eine Datei):

- welche Schritte umgesetzt sind, mit der Zahl der bestandenen und fehlgeschlagenen Tests pro Repo (Unit und Integration),
- welche Werte du für H1 bis H5 gesetzt hast und warum,
- das Ergebnis der Gegenprobe,
- jede Abweichung von diesem Dokument, mit Grund,
- was nicht an Hardware geprüft ist. Das ist mindestens: ein ganzes Update eines echten Thermometers über einen echten Proxy, die Werte H1 bis H5, und ob ein abgebrochenes Update das Gerät wirklich funktionsfähig lässt.
