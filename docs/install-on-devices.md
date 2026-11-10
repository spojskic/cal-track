# Install on devices

Cal Track runs as a **web app**, an **Android app** and an **iOS app**. None of the phone builds are on an app store;
you install them yourself ("sideloading"). The commands below are the standard Expo ones but **have not been run end to
end by the author**, so treat the first build as a test.

| Platform | Needs | Apple Health / Health Connect | Updates |
| --- | --- | --- | --- |
| Web | any static host | no | redeploy |
| Android | Android Studio + a phone or emulator | yes (physical phone) | build and send a new APK |
| iOS | a Mac with Xcode, a free Apple ID, a cable | yes (physical iPhone) | rebuild every 7 days (see below) |

There is no over-the-air update service set up: every code change means a new build.

## Web

```bash
pnpm --filter @cal/app export:web      # writes apps/app/dist
```

Upload `apps/app/dist` to any static host with a single-page-app fallback (all unknown paths serve `index.html`), for
example Cloudflare Pages, Netlify or Vercel. Use **HTTPS**: browsers only allow the camera (barcode scanning) and the
OpenRouter sign-in redirect on secure pages. The two `EXPO_PUBLIC_*` values from `apps/app/.env` are baked in at build
time.

On an iPhone open the site in Safari, then Share > **Add to Home Screen**. Web has no Apple Health access; data synced
from a phone app shows up here.

## Android (APK)

One-time setup: install [Android Studio](https://developer.android.com/studio), open it once so it downloads the SDK,
and make sure a JDK 17 is available.

```bash
cd apps/app
npx expo prebuild --platform android          # generates apps/app/android (git-ignored)
npx expo run:android --variant release        # builds, and installs on a connected phone or emulator
```

The installable file is `apps/app/android/app/build/outputs/apk/release/app-release.apk`. Send it to friends; they must
allow "install unknown apps" for the app they open it with. The release build is signed with Expo's default debug key,
which is fine for sideloading but not for Google Play.

**Health Connect:** Android 14 and newer have it built in; on older versions install *Health Connect* from the Play
Store first. Then open Cal Track > **More > Connected apps & devices** and grant access.

## iOS (free Apple ID)

Requirements: a Mac, Xcode from the App Store, an iPhone and cable, a free Apple ID.

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer      # once
```

1. Pick a bundle identifier nobody else uses, for example `com.yourname.caltrack`, and set `ios.bundleIdentifier` in
   `apps/app/app.json` (a free team cannot reuse an identifier that exists).
2. Generate and open the native project:

   ```bash
   cd apps/app
   npx expo prebuild --platform ios
   open ios/*.xcworkspace
   ```

3. In Xcode select the app target > **Signing & Capabilities**, choose your **Personal Team**, and keep the HealthKit
   capability that the project already lists.
4. On the iPhone enable **Settings > Privacy & Security > Developer Mode**, connect it, select it as the run target in
   Xcode and press Run. The first time, trust your developer certificate under **Settings > General > VPN & Device
   Management**.

Limits of a free Apple ID: the app **stops opening after 7 days** (run it from Xcode again to renew), at most 3 sideloaded
apps per device, and no push notifications or Sign in with Apple (the app does not use them; it signs in with email and
password).

### Alternative: an unsigned .ipa for SideStore or AltStore

Those tools sign an `.ipa` with your free Apple ID on the phone and renew it for you. Build the unsigned file on the Mac:

```bash
brew install cocoapods               # once
bash scripts/build-ios-ipa.sh        # 10-30 minutes the first time; needs apps/app/.env
```

It runs `expo prebuild`, `pod install` and `xcodebuild archive` with code signing switched off, and writes
`build/CalTrack-unsigned.ipa`. Install SideStore or AltStore on the iPhone (follow their own guides), open the `.ipa` with it
and sign in with your Apple ID there. Because the file is unsigned, the HealthKit entitlement is whatever SideStore/AltStore
grants a free account; if Apple Health access does not work that way, use the Xcode route above, which signs with the
capability. Everything else in the app does not depend on it.

**Apple Health:** it works on a physical iPhone only (not the simulator). HealthKit's *background delivery* entitlement is
switched off by default because a free account may be unable to sign it, so the app syncs when you open it and on a
best-effort background schedule. To try it, set `"background": true` for the HealthKit plugin in `app.json` and rebuild.

## Connecting a Garmin watch

Cal Track reads from Apple Health and Health Connect; it does **not** log in to Garmin directly. Open the Garmin Connect
app and enable sharing with Apple Health (iPhone) or Health Connect (Android); the menu name and location vary by
Garmin Connect version, and *what* gets shared is decided there. Cal Track then picks up what arrives: daily active and resting
energy, steps, workouts, weight, sleep and heart data. Garmin-only scores such as Body Battery or Sleep Score do not come
through this route. A direct, one-tap Garmin connection exists in the code but stays hidden until Garmin approves the app, see
[Garmin integration](garmin-integration.md).

## Turning on health sync

In the app: **More > Connected apps & devices**. Choose the data types you want, grant the system permission prompt, and
press *Sync now*. Then, under **More > Profile & targets**, set the *Energy mode*:

- **Static**: BMR + activity level + exercise you log by hand.
- **Device-adjusted**: your estimate plus whatever the watch measured above your baseline.
- **Device total**: the watch's own active + resting calories.
