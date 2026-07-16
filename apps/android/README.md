# RBClaw Android

Personal Android companion for RBClaw. This is a thin client: RBClaw still runs
on the existing Bun service, and the Android app talks to the dashboard API.

## Build

```bash
cd apps/android
cp local.properties.example local.properties
./gradlew assembleDebug
```

The debug APK is written to:

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
```

Install with:

```bash
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

## Runtime Setup

- Keep RBClaw behind Tailscale, VPN, SSH tunnel, or localhost forwarding.
- Enter the environment-specific dashboard URL in the app's **Base URL**
  field. The value is stored only in the app's private local preferences.
- Public hosts must use HTTPS. HTTP is accepted only for localhost, private
  network ranges, and Tailscale addresses.
- If `WEB_DASHBOARD_TOKEN` is enabled on the server, paste the same token into
  the app. It sends `Authorization: Bearer <token>`.

## Current MVP

- Connect to `/api/health`.
- Load rooms from `/api/rooms-timeline`.
- Open a room timeline from `/api/rooms/:jid/timeline`.
- Send text through `/api/rooms/:jid/messages`.
- Keep the Ray-Ban Display integration isolated behind `DisplaySurface`.

## Meta DAT

The default APK does not link the Meta DAT SDK yet. Meta's Android DAT SDK is
distributed through GitHub Packages and needs Developer Preview access, a
GitHub package token, and a Wearables Developer Center application id.

The integration point is already present:

```text
app/src/main/java/com/rbclaw/android/display/
```

After DAT access is ready, replace `MetaDatDisplaySurface` with SDK calls and
keep `NoopDisplaySurface` for phone-only testing.
