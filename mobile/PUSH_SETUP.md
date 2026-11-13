# Push notifications setup

The app and server code for push notifications (new lead assigned, a deal
you own moving to Won, tasks due today) is already in place and deployed.
It's inert until the two pieces below exist — a Firebase project supplies
both. Nothing breaks while they're missing: the Android build just skips
the Google Services plugin (`mobile/android/app/build.gradle` already
checks for `google-services.json` and logs a notice instead of failing),
and the server's `sendToUsers()` logs once and quietly does nothing.

## 1. Create the Firebase project (one-time, ~5 minutes)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and
   create a project (any name — e.g. "SCG CRM"). Google Analytics is not
   needed; you can decline it.
2. In the project, click **Add app → Android**.
   - Android package name: `com.summitcreativegroup.crm` (must match exactly)
   - Nickname/SHA-1: optional, skip
   - Download the generated **`google-services.json`** file.
3. Go to **Project settings (gear icon) → Service accounts → Generate new
   private key**. This downloads a second JSON file — a service account
   key, not the same file as step 2's. Keep both.

## 2. Add the Android config as a repo secret

Base64-encode the `google-services.json` from step 2 and add it as a
**repository secret** named `GOOGLE_SERVICES_JSON` (Settings → Secrets and
variables → Actions → Repository secrets), same place as
`ANDROID_KEYSTORE_BASE64`:

```
base64 -w0 google-services.json   # Linux
base64 -i google-services.json    # macOS
```

The next Android build will pick it up automatically and the app will be
able to receive notifications.

## 3. Add the service account key to the server

Base64-encode the **service account key** JSON from step 3 above and set it
as an environment variable named `FCM_SERVICE_ACCOUNT_JSON` on the
summit-crm Render service (Render dashboard → summit-crm → Environment):

```
base64 -w0 service-account-key.json   # Linux
base64 -i service-account-key.json    # macOS
```

Render redeploys automatically when an environment variable changes. Once
it's live, the server can actually send notifications through Firebase
Cloud Messaging.

## That's it

With both pieces in place:
- Anyone who opens the Android app and grants the notification permission
  gets registered automatically (no extra UI — happens silently on launch).
- New lead assigned to you, a deal you own hitting Won, and a once-a-day
  "tasks due today" nudge all go out from the server with no further setup.
- Signing out on a device unregisters that device, so a shared/handed-down
  phone won't keep alerting whoever used to be logged in.
