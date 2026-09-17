# BLE UART WebApp

Static Web Bluetooth terminal — plain HTML/CSS/JS, no build step, no
dependencies, no backend. Served straight from GitHub Pages.

## Deployment: changes are only live once they are on `main`

`.github/workflows/pages.yml` triggers on `push` to `main` only. A push to a
feature branch deploys nothing, so:

- The live site at https://gulash.github.io/BLE_UART_WebApp/ keeps serving the
  old version.
- No new `sw.js` reaches any browser, so the in-app "A new version is
  available / Reload" banner never appears.

So a change is not finished when the branch is pushed. **After pushing a
feature branch, say plainly that the change is not live yet and ask whether to
open a pull request against `main`** (or whether the user merges it
themselves). Never push straight to `main` without being asked to.

After a deploy, the update banner still only shows in a browser that has
visited the app before — it needs an existing service worker as controller.
A first visit just installs. The page re-checks on load, when the tab becomes
visible again, and hourly.

## The `__BUILD_VERSION__` placeholders must stay

The deploy step replaces `__BUILD_VERSION__` in `sw.js` and `index.html` with
the commit SHA, and `grep -q` guards both files — removing a placeholder fails
the deploy. Every deploy must produce a byte-different `sw.js`, otherwise the
browser sees no update and offline visitors keep the old precache forever.

## Conventions

- Comments explain *why*, not what. Match the density of the surrounding code.
- Guard against markup cached from an older deploy: a page and a script from
  different deploys can meet, so a missing element must never throw and take
  the rest of the app down (see the update banner and terminal panel wiring).
- Quick command buttons carry the text they send in `data-send`; `app.js`
  wires up every element that has one. A new shortcut is one line in
  `index.html` and no JS change.
- BLE profiles live in `PROFILES` at the top of `js/app.js`; another module is
  one more entry.
- Incoming data is buffered as raw bytes, never as decoded text — a UTF-8
  sequence is regularly split across two notifications.
- Keep the README's feature list in sync with user-visible changes.

## Testing

There is no test suite. Verify UI changes in a real browser before pushing:

```bash
npx http-server -p 8123 -s .          # Chromium is at /opt/pw-browsers
```

Web Bluetooth needs HTTPS or localhost. In a headless check there is no
`navigator.bluetooth`, so stub it with `page.addInitScript()` — a fake device
exposing the NUS UUIDs plus a `window.__notify(text)` helper that feeds the
characteristic handler is enough to exercise connect, send and receive.
Check narrow viewports (380px) too; the layout has a 520px breakpoint.
