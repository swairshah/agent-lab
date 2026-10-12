# Frontdesk for iOS

One button: tap the orb to get on a call with the voice frontdesk. The app is a thin client of `npm run web`. It sends
a WebRTC offer to the server, and the server creates the gpt-realtime-2.1 call, attaches its sideband and runs
delegation, so the phone holds no API keys and every call lands in the same pi-durable session as the CLI and the web
page.

- The orb shows the call: grey idle, blue connecting, teal listening, bright when you talk, warm when the frontdesk
  talks.
- Live captions, a call timer, mute and hang up.
- A notice when a worker is started and when it reports back.
- Settings: server URL and token (the token is kept in the Keychain).

## Build

Requires Xcode 16+ and iOS 17+.

```bash
brew install xcodegen
cd frontdesk/ios
xcodegen            # writes Frontdesk.xcodeproj from project.yml
open Frontdesk.xcodeproj
```

Pick your team under Signing & Capabilities, then run on a device (the simulator works too, using the Mac's mic).
WebRTC comes from [stasel/WebRTC](https://github.com/stasel/WebRTC) via Swift Package Manager.

## Point it at your server

The server only listens on localhost unless you set a host and a token:

```bash
cd frontdesk
FRONTDESK_HOST=0.0.0.0 FRONTDESK_TOKEN=$(openssl rand -hex 16) npm run web
```

Then in the app's settings enter the URL and the token.

- **Same Wi-Fi:** `http://<your-mac>.local:4318` or `http://192.168.x.y:4318`. Plain HTTP is allowed only for local
  network addresses.
- **Anywhere (recommended):** install Tailscale on the Mac and the phone, run `tailscale serve 4318` on the Mac, and use
  `https://<mac>.<tailnet>.ts.net`. That gives you HTTPS without opening a port to the internet, and since
  `tailscale serve` proxies to localhost, plain `npm run web` works; setting `FRONTDESK_TOKEN` anyway is still a good
  idea.

Starting a call from the phone hangs up any call the web page has open, since one voice frontend runs at a time.
