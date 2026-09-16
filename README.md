# BLE UART WebApp

A browser-based serial terminal for Bluetooth Low Energy (BLE) devices that
tunnel a UART over GATT — both the **Nordic UART Service (NUS)** and
**HM-10** style modules. Built with the
[Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) —
no app install, no backend, just a static page that talks directly to your
hardware.

**Live demo:** https://gulash.github.io/BLE_UART_WebApp/

## Features

- Automatic profile detection: connects to NUS and HM-10 devices alike
- Live terminal view of incoming data (notifications)
- Send text/commands to the device, chunked to fit the default BLE ATT MTU
- Optional timestamps, and a selectable line ending appended on send
  (none, `\n`, `\r`, `\r\n` or `\n\r`)
- Demo buttons: send the commands `demo` and `demo stop` to the device
  without typing them
- Autoscroll toggle and a one-click clear
- Installable as a PWA (web app manifest + service worker), so it runs
  full-screen from the home screen and works offline
- Zero build step — plain HTML/CSS/JS, works straight from GitHub Pages or
  any static file server

## Requirements

Web Bluetooth is currently supported in Chromium-based browsers
(Chrome, Edge, Opera) on desktop and Android, served over **HTTPS** or
`localhost`. It is not available in Safari or Firefox.

## Usage

1. Open the app in a supported browser.
2. Click **Connect** and pick your BLE UART device from the browser's
   device chooser.
3. Incoming data from the device appears in the terminal in real time.
4. Type into the input field and press **Enter** (or click **Send**) to
   write to the device.

## Installing on a phone

Open the live URL in Chrome on Android and choose "Install app" / "Add to
home screen" — it then launches full-screen without browser chrome and
loads offline from the service worker cache.

On iOS the page can be added to the home screen too, but Safari does not
implement Web Bluetooth, so connecting to a device will not work there.

## Supported profiles

After connecting, the app probes the device for each profile in order and
uses the first one it finds. Profiles live in `PROFILES` at the top of
`js/app.js`; adding another module is a matter of appending an entry.

**Nordic UART Service** — two characteristics, one per direction:

| Role                    | UUID                                   |
| ----------------------- | -------------------------------------- |
| Service                 | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (write, app→device)  | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX (notify, device→app) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

**HM-10** (and clones such as CC41-A or MLT-BT05) — a single characteristic
carries both directions:

| Role                    | UUID     |
| ----------------------- | -------- |
| Service                 | `0xFFE0` |
| Write + notify          | `0xFFE1` |

### The "All devices" toggle

By default the device chooser is filtered to the service UUIDs above, which
keeps unrelated hardware out of the list. Many HM-10 clones do not put their
service UUID in the advertising packet, and the UUIDs can also be changed via
AT commands — such modules never appear under the filter. Tick **All devices**
to list every nearby peripheral instead; profile detection then happens after
connecting, as usual.

## Local development

This is a static site with no dependencies or build tooling. Serve the
directory with any local web server, for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Web Bluetooth treats `localhost` as a
secure context, so it works without HTTPS locally.

## Project structure

```
.
├── index.html                   # markup / layout
├── css/style.css                # styling (dark terminal theme)
├── js/app.js                    # Web Bluetooth logic + profile table
├── manifest.json                # PWA manifest
├── sw.js                        # service worker (network-first, offline fallback)
├── icons/                       # PWA / home screen icons
└── .github/workflows/pages.yml  # GitHub Pages deployment
```

## License

MIT — see [LICENSE](LICENSE).
