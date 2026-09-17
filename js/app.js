"use strict";

/**
 * BLE UART WebApp
 * Browser-based serial terminal for BLE peripherals that tunnel a UART
 * over GATT, via the Web Bluetooth API.
 */

/**
 * Supported UART-over-BLE profiles, probed in this order after connecting.
 *
 * NUS uses two characteristics (one written to, one notifying). The HM-10
 * and its clones use a single characteristic for both directions, so
 * writeChar and notifyChar are simply the same UUID there.
 */
const PROFILES = [
  {
    name: "Nordic UART Service",
    service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    writeChar: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    notifyChar: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  },
  {
    name: "HM-10",
    service: 0xffe0,
    writeChar: 0xffe1,
    notifyChar: 0xffe1,
  },
];

// Conservative chunk size for writes (default BLE ATT MTU is 23 bytes,
// leaving ~20 bytes of payload per write).
const WRITE_CHUNK_SIZE = 20;

// Commands the demo buttons send to the device.
const DEMO_START_MESSAGE = "demo";
const DEMO_STOP_MESSAGE = "demo stop";

// How often the page asks the browser to re-check sw.js. Browsers only look
// for a new worker on navigation, and this app can stay open for days.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Line endings appended to outgoing messages, keyed by the value of the
// selector in the send form.
const LINE_ENDINGS = {
  none: "",
  lf: "\n",
  cr: "\r",
  crlf: "\r\n",
  lfcr: "\n\r",
};

const els = {
  connectBtn: document.getElementById("connect-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  deviceName: document.getElementById("device-name"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  terminal: document.getElementById("terminal"),
  sendForm: document.getElementById("send-form"),
  sendInput: document.getElementById("send-input"),
  sendBtn: document.getElementById("send-btn"),
  demoStartBtn: document.getElementById("demo-start-btn"),
  demoStopBtn: document.getElementById("demo-stop-btn"),
  allDevicesToggle: document.getElementById("all-devices-toggle"),
  clearBtn: document.getElementById("clear-btn"),
  autoscrollToggle: document.getElementById("autoscroll-toggle"),
  timestampToggle: document.getElementById("timestamp-toggle"),
  lineEndingSelect: document.getElementById("line-ending-select"),
  supportWarning: document.getElementById("support-warning"),
  updateBanner: document.getElementById("update-banner"),
  updateBannerNote: document.getElementById("update-banner-note"),
  updateReloadBtn: document.getElementById("update-reload-btn"),
  updateDismissBtn: document.getElementById("update-dismiss-btn"),
};

const state = {
  device: null,
  server: null,
  profile: null, // entry from PROFILES that matched the connected device
  writeChar: null, // web app -> device
  notifyChar: null, // device -> web app
};

const textEncoder = new TextEncoder();

// Validates one candidate UTF-8 sequence at a time: it throws on anything
// malformed, which is how decodeLine() tells text apart from raw bytes.
// ignoreBOM keeps it a plain bytes-to-character mapping, so a leading U+FEFF
// is reported like any other character instead of silently disappearing.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function supportsWebBluetooth() {
  return "bluetooth" in navigator;
}

function isConnected() {
  return Boolean(state.device && state.device.gatt && state.device.gatt.connected);
}

function setConnectedUI(connected, deviceLabel) {
  els.status.classList.toggle("status--connected", connected);
  els.status.classList.toggle("status--disconnected", !connected);
  els.statusText.textContent = connected ? "Connected" : "Disconnected";
  els.connectBtn.disabled = connected;
  els.disconnectBtn.disabled = !connected;
  els.sendInput.disabled = !connected;
  els.sendBtn.disabled = !connected;
  els.demoStartBtn.disabled = !connected;
  els.demoStopBtn.disabled = !connected;
  els.deviceName.textContent = connected && deviceLabel ? deviceLabel : "";
  // The update banner warns about losing the link only while there is one.
  if (els.updateBannerNote) els.updateBannerNote.hidden = !connected;
  if (connected) {
    els.sendInput.focus();
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function appendLine(text, kind) {
  appendSegments([{ text }], kind);
}

// Segments are {text, escaped?} pairs. Escaped ones are byte escapes this app
// produced, and are styled apart so they cannot be mistaken for a literal
// "\xNN" the device sent as text.
function appendSegments(segments, kind) {
  const line = document.createElement("span");
  line.className = `line line--${kind}`;

  if (els.timestampToggle.checked) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = timestamp();
    line.appendChild(ts);
  }

  for (const segment of segments) {
    if (segment.escaped) {
      const span = document.createElement("span");
      span.className = "esc";
      span.textContent = segment.text;
      line.appendChild(span);
    } else {
      line.appendChild(document.createTextNode(segment.text));
    }
  }

  els.terminal.appendChild(line);

  if (els.autoscrollToggle.checked) {
    els.terminal.scrollTop = els.terminal.scrollHeight;
  }

  return line;
}

// Incoming notifications guarantee neither line boundaries nor character
// boundaries: with ~20 bytes of payload per notification, a multi-byte UTF-8
// sequence is regularly split across two of them. So we buffer raw bytes
// rather than decoded text, cut lines at byte level and decode only whole
// lines. Devices terminate lines with any of the endings the send form offers.
let rxBuffer = new Uint8Array(0);

const CR = 0x0d;
const LF = 0x0a;

function concatBytes(head, tail) {
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

// Length claimed by a UTF-8 lead byte, or 0 for a byte that cannot start a
// sequence at all: a continuation byte, an overlong lead (0xC0, 0xC1) or one
// beyond the last code point (0xF5 and up).
function utf8SequenceLength(byte) {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

// Tab stays as it is because the terminal renders it as whitespace. The C0
// controls, DEL and the C1 range have no glyph at all, so a font draws them
// as an empty box or as nothing — and either way they are invisible once
// copied out of the terminal.
function isPrintable(codePoint) {
  if (codePoint === 0x09) return true;
  if (codePoint < 0x20 || codePoint === 0x7f) return false;
  return !(codePoint >= 0x80 && codePoint <= 0x9f);
}

// Turns one line of raw bytes into display segments. Printable UTF-8 passes
// through as text; every other byte — a control code, or a byte from a device
// that speaks Latin-1 or sends binary — becomes a visible "\xNN" escape
// instead of a glyph the font has to guess at.
function decodeLine(bytes) {
  const segments = [];
  let text = "";
  let escapes = "";

  const flushText = () => {
    if (text.length > 0) segments.push({ text });
    text = "";
  };
  const flushEscapes = () => {
    if (escapes.length > 0) segments.push({ text: escapes, escaped: true });
    escapes = "";
  };

  for (let index = 0; index < bytes.length; ) {
    const length = utf8SequenceLength(bytes[index]);
    let decoded = null;

    // A sequence running past the end of the line is truncated, not pending:
    // the line break behind it means the device sent nothing more.
    if (length > 0 && index + length <= bytes.length) {
      try {
        decoded = strictDecoder.decode(bytes.subarray(index, index + length));
      } catch {
        decoded = null; // not the sequence its lead byte promised
      }
    }

    if (decoded !== null && isPrintable(decoded.codePointAt(0))) {
      flushEscapes();
      text += decoded;
      index += length;
    } else {
      flushText();
      escapes += `\\x${bytes[index].toString(16).toUpperCase().padStart(2, "0")}`;
      index += 1;
    }
  }

  flushText();
  flushEscapes();
  return segments;
}

function appendRxLine(bytes) {
  appendSegments(decodeLine(bytes), "rx");
}

// Whatever sits in rxBuffer after the last line break is shown right away as
// an unterminated line instead of being held back until its newline arrives.
// A device with an interactive prompt never terminates the prompt, so holding
// it back meant it stayed invisible and then surfaced glued to the front of
// the next burst of output — making the burst look reordered.
let pendingLine = null;

function dropPendingLine() {
  if (pendingLine) {
    pendingLine.remove();
    pendingLine = null;
  }
}

function renderPendingLine() {
  if (rxBuffer.length === 0) return;
  pendingLine = appendSegments(decodeLine(rxBuffer), "rx");
  pendingLine.classList.add("line--pending");
}

function handleIncomingChunk(bytes) {
  // The pending line is always the terminal's last child, so it has to go
  // before completed lines are appended behind it.
  dropPendingLine();
  rxBuffer = concatBytes(rxBuffer, bytes);

  let start = 0;
  for (let index = 0; index < rxBuffer.length; index++) {
    if (rxBuffer[index] !== CR && rxBuffer[index] !== LF) continue;
    // Empty lines are dropped, as they were before. That also disposes of the
    // second byte of a CRLF pair, including one split across notifications.
    if (index > start) appendRxLine(rxBuffer.subarray(start, index));
    start = index + 1;
  }

  rxBuffer = rxBuffer.slice(start);
  renderPendingLine();
}

// Turns the pending line into a permanent one: nothing more is coming that
// could complete it.
function flushRxBuffer() {
  dropPendingLine();
  if (rxBuffer.length > 0) {
    appendRxLine(rxBuffer);
    rxBuffer = new Uint8Array(0);
  }
}

function onCharacteristicValueChanged(event) {
  const value = event.target.value; // DataView
  handleIncomingChunk(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function onDeviceDisconnected() {
  flushRxBuffer();
  appendLine(`Disconnected from ${state.device ? state.device.name || "device" : "device"}.`, "sys");
  cleanupConnection();
  setConnectedUI(false);
}

function cleanupConnection() {
  if (state.notifyChar) {
    state.notifyChar.removeEventListener("characteristicvaluechanged", onCharacteristicValueChanged);
  }
  if (state.device) {
    state.device.removeEventListener("gattserverdisconnected", onDeviceDisconnected);
  }
  state.device = null;
  state.server = null;
  state.profile = null;
  state.writeChar = null;
  state.notifyChar = null;
}

// Filtering by service UUID keeps the chooser clean, but HM-10 clones often
// do not advertise their service, so they only show up unfiltered.
function requestDeviceOptions() {
  const services = PROFILES.map((profile) => profile.service);
  if (els.allDevicesToggle.checked) {
    return { acceptAllDevices: true, optionalServices: services };
  }
  return {
    filters: services.map((service) => ({ services: [service] })),
    optionalServices: services,
  };
}

// Returns the first profile the connected device actually exposes, or null.
async function resolveProfile(server) {
  for (const profile of PROFILES) {
    try {
      const service = await server.getPrimaryService(profile.service);
      const [writeChar, notifyChar] = await Promise.all([
        service.getCharacteristic(profile.writeChar),
        service.getCharacteristic(profile.notifyChar),
      ]);
      return { profile, writeChar, notifyChar };
    } catch {
      // Service or characteristic missing — try the next profile.
    }
  }
  return null;
}

async function connect() {
  if (!supportsWebBluetooth()) {
    els.supportWarning.hidden = false;
    return;
  }

  try {
    els.connectBtn.disabled = true;
    appendLine("Requesting Bluetooth device…", "sys");

    const device = await navigator.bluetooth.requestDevice(requestDeviceOptions());
    const label = device.name || "Unnamed device";

    state.device = device;
    device.addEventListener("gattserverdisconnected", onDeviceDisconnected);

    appendLine(`Connecting to ${label}…`, "sys");
    state.server = await device.gatt.connect();

    const link = await resolveProfile(state.server);
    if (!link) {
      device.gatt.disconnect();
      throw new Error("device exposes neither the Nordic UART Service nor an HM-10 service");
    }

    state.profile = link.profile;
    state.writeChar = link.writeChar;
    state.notifyChar = link.notifyChar;

    await link.notifyChar.startNotifications();
    link.notifyChar.addEventListener("characteristicvaluechanged", onCharacteristicValueChanged);

    appendLine(`Connected to ${label} (${link.profile.name}).`, "sys");
    setConnectedUI(true, `${label} · ${link.profile.name}`);
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      appendLine("Device selection cancelled.", "sys");
    } else {
      appendLine(`Connection failed: ${err && err.message ? err.message : err}`, "sys");
    }
    cleanupConnection();
    setConnectedUI(false);
  }
}

async function disconnect() {
  if (state.device && state.device.gatt.connected) {
    state.device.gatt.disconnect();
    // onDeviceDisconnected() fires via the gattserverdisconnected event
    // and takes care of UI/state cleanup.
  }
}

async function sendText(text) {
  if (!state.writeChar) return;

  // Falls back to LF when the selector is missing, which happens while an
  // index.html from an older deploy is still in play.
  const ending = els.lineEndingSelect ? LINE_ENDINGS[els.lineEndingSelect.value] ?? "" : "\n";
  const payload = `${text}${ending}`;
  const bytes = textEncoder.encode(payload);

  try {
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = bytes.slice(offset, offset + WRITE_CHUNK_SIZE);
      if (state.writeChar.writeValueWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(chunk);
      } else {
        await state.writeChar.writeValue(chunk);
      }
    }
    appendLine(text, "tx");
  } catch (err) {
    appendLine(`Send failed: ${err && err.message ? err.message : err}`, "sys");
  }
}

function clearTerminal() {
  els.terminal.innerHTML = "";
  // rxBuffer keeps its bytes — they are the head of a line still arriving,
  // and dropping them would corrupt it. Only the element is gone.
  pendingLine = null;
}

// The demo buttons are shortcuts for the two commands the device expects;
// the device itself decides what to do with them.
function sendDemoStart() {
  sendText(DEMO_START_MESSAGE);
}

function sendDemoStop() {
  sendText(DEMO_STOP_MESSAGE);
}

// --- Service worker updates -------------------------------------------------
//
// A new worker installs in the background and then waits. We offer the update
// instead of applying it silently: activating it means reloading the page to
// avoid running old page code against new assets, and a reload tears down the
// BLE connection. So the user picks the moment.

const updateState = {
  waitingWorker: null,
  accepted: false,
  reloading: false,
};

function showUpdateBanner(worker) {
  if (!els.updateBanner) return; // markup from before the update banner existed
  updateState.waitingWorker = worker;
  els.updateBannerNote.hidden = !isConnected();
  els.updateReloadBtn.disabled = false;
  els.updateBanner.hidden = false;
}

function applyUpdate() {
  if (!updateState.waitingWorker) return;
  updateState.accepted = true;
  els.updateReloadBtn.disabled = true;
  // The worker calls skipWaiting() and takes over; controllerchange then
  // reloads the page.
  updateState.waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

function dismissUpdate() {
  els.updateBanner.hidden = true;
}

function watchForUpdates(registration) {
  // An update may already be waiting from an earlier visit. A controller means
  // this page is served by an older worker, so the waiting one is an update
  // rather than a first install.
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateBanner(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        showUpdateBanner(installing);
      }
    });
  });

  const checkForUpdate = () => {
    registration.update().catch(() => {
      // Offline or the check failed — try again on the next tick.
    });
  };

  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
}

async function registerServiceWorker() {
  try {
    // updateViaCache: "none" keeps an HTTP-cached sw.js from masking a deploy.
    const registration = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
    watchForUpdates(registration);
  } catch (err) {
    console.warn("Service worker registration failed:", err);
  }
}

// Wired up before anything else: should the rest of this file throw — an
// index.html cached from an older deploy will not have every element this
// script expects — the page must still end up with a service worker, because
// that is what serves the next, matching version.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The first worker claiming this page fires this too — only a reload that
    // the user asked for should go through, and only once.
    if (!updateState.accepted || updateState.reloading) return;
    updateState.reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", registerServiceWorker);
}

// Guarded for the same reason: older markup has no update banner, and a
// missing button must not take the rest of the app down with it.
if (els.updateReloadBtn && els.updateDismissBtn) {
  els.updateReloadBtn.addEventListener("click", applyUpdate);
  els.updateDismissBtn.addEventListener("click", dismissUpdate);
}

els.connectBtn.addEventListener("click", connect);
els.disconnectBtn.addEventListener("click", disconnect);
els.demoStartBtn.addEventListener("click", sendDemoStart);
els.demoStopBtn.addEventListener("click", sendDemoStop);
els.clearBtn.addEventListener("click", clearTerminal);

els.sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.sendInput.value;
  if (text.length === 0) return;
  sendText(text);
  els.sendInput.value = "";
});

if (!supportsWebBluetooth()) {
  els.supportWarning.hidden = false;
  els.connectBtn.disabled = true;
}
