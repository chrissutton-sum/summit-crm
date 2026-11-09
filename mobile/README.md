# SCG CRM mobile shells (Android + iOS)

A Capacitor shell that loads the live site (https://summit-crm-6fom.onrender.com),
so web deploys update the app instantly. Native rebuilds are only needed for
icon, permission, or plugin changes.

## Android

Built and published by `.github/workflows/android.yml`. Lives at `mobile/android`
(committed — a stable, already-generated project). See the root README.

Release signing key alias: `scg-crm`.

## iOS

Built by `.github/workflows/ios.yml`. `mobile/ios` is *not* committed yet — the
workflow generates it on its first run (a real `npx cap add ios`, run on a
macOS GitHub Actions runner, since that step needs npm registry access this
repo's dev sandbox didn't have) and commits the result, the same way
`mobile/android` already exists.

Icon/splash source art lives in `mobile/resources/` (`icon.png` 1024×1024,
`splash.png` 2732×2732) — `@capacitor/assets` generates every platform size
from these.

Every push to `mobile/**` runs a Simulator build (no signing needed) as a
smoke test, confirming the generated Xcode project actually compiles. It
does **not** produce anything installable on a device or TestFlight yet —
that needs an Apple Developer Program account ($99/yr), after which:

1. Create an App Store Connect API key: **App Store Connect → Users and
   Access → Integrations → App Store Connect API → Generate API Key**
   (Admin role). Note its Key ID and Issuer ID, and download the `.p8` file
   — Apple only lets you download it once.
2. Add four repository secrets (Settings → Secrets and variables → Actions):
   - `APPLE_TEAM_ID` — Developer portal → Membership → Team ID
   - `APP_STORE_CONNECT_KEY_ID` — the API key's Key ID
   - `APP_STORE_CONNECT_ISSUER_ID` — the API key's Issuer ID
   - `APP_STORE_CONNECT_KEY_P8_BASE64` — the downloaded `.p8` file, base64-encoded
     (e.g. `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` on a Mac)
3. Create the app's record in App Store Connect (bundle ID
   `com.summitcreativegroup.crm`, same as Android) so there's somewhere for
   TestFlight builds to land.
4. Re-run the workflow. With those secrets present it archives, signs, and
   uploads a build to TestFlight automatically.

The archive/export/upload steps are written against Apple's current (as of
this writing) automatic-signing + API-key flow, but untested — nothing in
this sandbox can run Xcode to verify it. Treat the first real run after the
secrets are added as a debugging pass, not a guaranteed success.
