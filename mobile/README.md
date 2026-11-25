# WorkSight mobile (managers)

Flutter app for Android and iOS. Managers sign in with their WorkSight website account and see who's in, everyone's
office time, and the cameras. Setup (cameras, employees, users, settings) stays on the website.

It talks to the same backend as the website (`https://<server>/api`) with the same sign-in tokens. Nothing on the
server needs to change for this version.

## What's in 1.0

| Tab | What it shows | Backend |
| --- | --- | --- |
| Today | In now, not seen now, arrivals/late, average time inside, everyone by status, camera status, recent sightings. Refreshes every 30 s. | `GET /work-hours/daily`, `/recognition/status`, `/recognition/events` |
| Office time | Any day, filters (in office / not seen / not in / late), search, one card per person with a timeline. | `GET /work-hours/daily?date=` |
| Person (tap anyone) | Day timeline, arrival, last seen, inside, away periods, every face sighting. Prev/next day. | `GET /work-hours/daily`, `/work-hours/{id}/sightings` |
| Cameras | Current picture of each lens and its recognition state. Refreshes every 3 s only when that's free (lens live in recognition, or a non-EZVIZ camera); otherwise tap for a new picture, because EZVIZ allows 1,000 pictures a day per account, shared with recognition. Only for accounts that can see live cameras. | `GET /cameras`, `/cameras/{id}/preview` |
| More | Account, server, app version, sign out. | `POST /auth/logout` |

Sign-in asks for the **server address** because every customer runs their own WorkSight server. The app checks it
is a WorkSight server (`GET /api/health`), and refuses accounts without the `reports.view` permission (employees)
and accounts that must change their password first (they do that on the website).

The sign-in token is kept in the Keychain (iOS) / Keystore (Android) via `flutter_secure_storage`. Tokens last as long
as the server's `JWT_EXPIRES_DAYS` (7 days today); after that the app asks to sign in again.

## Layout

```
lib/
  main.dart                 app, splash, signed-in / signed-out switch
  session.dart              sign in / out, saved server + token
  api/api_client.dart       HTTP calls and error messages
  api/models.dart           server JSON -> Dart (forgiving parsing)
  format.dart               durations, times, dates (same wording as the website)
  theme.dart                colours shared with the website
  widgets/common.dart       cards, tiles, badges, avatars, empty/error states
  widgets/timeline.dart     the day timeline bar and hour axis
  screens/                  one file per screen
test/                       unit + widget tests
```

## Build and run

No Flutter on the server? Use Docker (this is how it was built and tested):

```sh
docker run --rm -v "$PWD":/app -w /app instrumentisto/flutter:latest flutter test
docker run --rm -v "$PWD":/app -w /app instrumentisto/flutter:latest flutter build apk --release
# -> build/app/outputs/flutter-apk/app-release.apk
```

With Flutter installed locally: `flutter run` (phone or emulator), `flutter test`, `flutter build apk` / `flutter build ipa`.
iOS builds need a Mac with Xcode, or the GitHub Actions workflow below, which builds on GitHub's Macs.

## Release to TestFlight

[`.github/workflows/ios-testflight.yml`](../.github/workflows/ios-testflight.yml) runs `flutter analyze` and
`flutter test`, builds a signed IPA on a macOS runner (Xcode 26, which Apple requires), and uploads it to TestFlight.

**Run it** by pushing a tag that starts with `mobile-v`:

```sh
git tag mobile-v1.0.0-1 && git push origin mobile-v1.0.0-1
```

or from the Actions tab, "iOS TestFlight" → "Run workflow" (that button appears only once the workflow file is on
`main`). The version comes from `pubspec.yaml` (`version: 1.0.0+…`); the build number is the workflow's run number,
or the one you type when running it by hand. TestFlight rejects a build number that isn't higher than the last one
uploaded for the same version. Builds show up in App Store Connect after 5 to 30 minutes of processing.

macOS runners use GitHub Actions minutes at 10 times the Linux rate on private repositories, so one run costs
roughly 100 to 200 included minutes.

### One-time setup

All of this works without a Mac. You need the Apple Developer Program ($99/year) and an Admin or App Manager role
in App Store Connect.

1. **Confirm the bundle ID.** Once the App Store Connect record below exists, `com.hashnate.worksight` can't be
   changed. To use a different one, change `PRODUCT_BUNDLE_IDENTIFIER` in `ios/Runner.xcodeproj/project.pbxproj`
   (and `applicationId` in `android/app/build.gradle.kts`) first.
2. **Register the App ID.** [developer.apple.com](https://developer.apple.com/account/resources/identifiers/list) →
   Identifiers → + → App IDs → App → explicit bundle ID `com.hashnate.worksight`. No extra capabilities.
3. **Create the app record.** [App Store Connect](https://appstoreconnect.apple.com) → Apps → + → New App → iOS,
   name "WorkSight", that bundle ID, any SKU (e.g. `worksight-ios`).
4. **Distribution certificate.** On any Linux machine (keep `worksight-dist.key` somewhere safe; it's the
   certificate's private key):

   ```sh
   openssl genrsa -out worksight-dist.key 2048
   openssl req -new -key worksight-dist.key -out worksight-dist.csr -subj "/CN=WorkSight distribution/C=LK"
   ```

   Developer site → Certificates → + → **Apple Distribution** → upload `worksight-dist.csr` → download
   `distribution.cer`. If Apple Distribution says "Maximum number of certificates generated" (the team's other apps
   use them), pick **iOS Distribution (App Store Connect and Ad Hoc)** instead: it works the same for iOS and the
   workflow accepts it (the file downloads as `ios_distribution.cer`; use that name below). Don't revoke a
   certificate another app's build still uses. Then turn it into a `.p12` (`-legacy` is needed or macOS can't read
   the file):

   ```sh
   openssl x509 -inform DER -in distribution.cer -out distribution.pem
   openssl pkcs12 -export -legacy -inkey worksight-dist.key -in distribution.pem -out worksight-dist.p12
   ```

   It asks for an export password: that's `IOS_DIST_CERT_PASSWORD`.
5. **Provisioning profile.** Developer site → Profiles → + → Distribution → **App Store Connect** → the App ID from
   step 2 → the certificate from step 4 → name it "WorkSight App Store" → download the `.mobileprovision`.
6. **API key for uploading.** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys
   → + → role **App Manager**. Download the `.p8` (Apple only lets you download it once) and note the Key ID and the
   Issuer ID shown above the list.
7. **GitHub secrets.** Repository → Settings → Secrets and variables → Actions → New repository secret:

   | Secret | Value |
   | --- | --- |
   | `IOS_DIST_CERT_P12_BASE64` | output of `base64 -w0 worksight-dist.p12` |
   | `IOS_DIST_CERT_PASSWORD` | the `.p12` export password |
   | `IOS_PROVISIONING_PROFILE_BASE64` | output of `base64 -w0 WorkSight_App_Store.mobileprovision` |
   | `APP_STORE_CONNECT_KEY_ID` | Key ID from step 6 |
   | `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID from step 6 |
   | `APP_STORE_CONNECT_KEY_P8` | the whole text of `AuthKey_<KeyID>.p8`, including the BEGIN/END lines |

   Then delete the local `.p12`, `.p8` and base64 copies. The workflow reads the team ID and bundle ID from the
   profile, so nothing else needs configuring.
8. **Testers.** After the first build has processed: App Store Connect → the app → TestFlight → Internal Testing →
   add your team (up to 100 App Store Connect users, no review). Outside testers go under External Testing and need a
   one-off Beta App Review.

The certificate and profile expire after a year. Make new ones (steps 4 and 5) and update the three `IOS_*` secrets.

**How signing works in CI:** the workflow writes `ios/Flutter/CodeSigning.xcconfig` (git-ignored), which
`ios/Flutter/Release.xcconfig` includes if present. It switches only the Runner target to manual signing with the
profile, so plugin pods aren't affected and a Mac without that file keeps automatic signing.

The server must be on **HTTPS**: Android and iOS block plain `http://` in release builds.

## Before the first store release

- **App ID**: `com.hashnate.worksight` (Android `applicationId`, iOS bundle ID). It can't be changed after the first
  release, so confirm it.
- **Signing**: an Android upload keystore (`android/key.properties`, never committed). Release APKs built today use
  the debug key and are for testing only. iOS signing is covered by "Release to TestFlight" above.
- **Icon and splash**: the default Flutter icon is still in place.
- **Store listings**: privacy policy URL; App Store privacy labels and Play data-safety form (the app shows names,
  attendance times and camera pictures of employees; it doesn't collect face data itself).
- **Review account**: Apple and Google reviewers need a demo server and manager login.
