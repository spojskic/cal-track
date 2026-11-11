# Install on devices

Ration runs as a **web app**, an **Android app** and an **iOS app**. None of the phone builds are on an app store;
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
pnpm --filter @ration/app export:web      # writes apps/app/dist
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

To get just the file, named by version, without installing it anywhere (needs `apps/app/.env` like every build):

```bash
bash scripts/build-android-apk.sh        # writes build/Ration-<version>.apk
```

It runs `expo prebuild` and Gradle's `assembleRelease` for the phone architectures (`arm64-v8a`, `armeabi-v7a`; set
`ANDROID_ABIS` to change that) and prints the file's SHA-256.

**Health Connect:** Android 14 and newer have it built in; on older versions install *Health Connect* from the Play
Store first. Then open Ration > **More > Connected apps & devices** and grant access.

## iOS (free Apple ID)

Requirements: a Mac, Xcode from the App Store, an iPhone and cable, a free Apple ID.

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer      # once
```

1. Pick a bundle identifier nobody else uses, for example `com.yourname.ration`, and set `ios.bundleIdentifier` in
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

It runs `expo prebuild`, `pod install` and `xcodebuild archive` with code signing switched off, embeds the entitlements (HealthKit)
with an ad-hoc signature so the sideloading tool can see them, and writes `build/Ration-unsigned.ipa`. Install SideStore or
AltStore on the iPhone (follow their own guides), open the `.ipa` with it and sign in with your Apple ID there.

If **Connect Apple Health** answers *Missing com.apple.developer.healthkit entitlement*, the sideloading tool dropped the HealthKit
capability when it re-signed the app (a first unsigned build had no entitlements at all). Everything except Apple Health works
anyway. To get Apple Health, install with the Xcode route above, which signs with the capability from your Personal Team.

**Apple Health:** it works on a physical iPhone only (not the simulator). HealthKit's *background delivery* entitlement is
switched off by default because a free account may be unable to sign it, so the app syncs when you open it and on a
best-effort background schedule. To try it, set `"background": true` for the HealthKit plugin in `app.json` and rebuild.

## Making a GitHub release

The app is built on your own machines; a release is just the two files attached to a GitHub release.

1. Raise `expo.version` in `apps/app/app.json` (for example `0.2.0`), commit, and tag it: `git tag v0.2.0`.
2. Build both files (the Supabase URL and anon key from `apps/app/.env` are baked into them; the anon key is public by design,
   protected by row-level security and the invite-only sign-up):

   ```bash
   bash scripts/build-android-apk.sh        # build/Ration-0.2.0.apk
   bash scripts/build-ios-ipa.sh            # build/Ration-unsigned.ipa
   ```

3. Create the release (needs the [GitHub CLI](https://cli.github.com), `gh auth login`, and a GitHub remote):

   ```bash
   git remote add origin git@github.com:YOU/ration.git     # once
   git push origin main --tags
   gh release create v0.2.0 build/Ration-0.2.0.apk build/Ration-unsigned.ipa \
     --title "Ration 0.2.0" --notes "Android: open the .apk. iPhone: sign the .ipa with SideStore or AltStore."
   ```

The `.ipa` is **unsigned**: it only installs through SideStore / AltStore (or by re-signing it yourself), and Apple Health may not
work in a re-signed copy (see above). A repository that is public makes the files public too; sign-up still needs an invite code.

## Connecting a Garmin watch

There are two routes, and they can be on at the same time (for the calorie budget the Garmin numbers of a day win):

1. **Through Apple Health / Health Connect.** Open the Garmin Connect app and enable sharing with Apple Health (iPhone) or Health
   Connect (Android); the menu name and location vary by Garmin Connect version, and *what* gets shared is decided there. Cal
   Track then picks up what arrives. Garmin-only scores such as Body Battery or Sleep Score do not come through this route.
2. **Directly from the phone.** In **Connected Apps & Devices > Garmin** tap **Connect Garmin** and sign in on Garmin's own page
   inside the app. Needs a build that contains the web view (`react-native-webview`), so install a fresh build once; the web
   build cannot do it. Ration never sees your password; the token stays in the phone's secure storage. This is
   Garmin's private mobile-app interface, not an official integration. See [Features](features.md#garmin-read-only-from-the-phone).

## Turning on health sync

In the app: **More > Connected apps & devices**. Choose the data types you want, grant the system permission prompt, and
press *Sync now*. A profile that was on *Static* is moved to *Device-adjusted* once the first time you connect (you can change
it back; it will not be switched again). Under **More > Profile & targets** you can set the *Energy mode*:

- **Static**: baseline activity only (plus exercise you log by hand). Ignores your watch.
- **Device-adjusted**: your watch activity replaces the baseline during the day, and workouts are added.
- **Device total**: the watch's own active + resting calories.
