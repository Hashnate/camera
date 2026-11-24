# WorkSight mobile (managers)

Flutter app for Android and iOS. Managers sign in with their WorkSight website account and see who's in, everyone's
office time, and the cameras. Setup (cameras, employees, users, settings) stays on the website.

It talks to the same backend as the website (`https://<server>/api`) with the same sign-in tokens. Nothing on the
server needs to change for this version.

## What's in v0.1

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
iOS builds need a Mac with Xcode.

The server must be on **HTTPS**: Android and iOS block plain `http://` in release builds.

## Before the first store release

- **App ID**: `com.hashnate.worksight` (Android `applicationId`, iOS bundle ID). It can't be changed after the first
  release, so confirm it.
- **Signing**: an Android upload keystore (`android/key.properties`, never committed) and an Apple Developer account
  ($99/year) with a distribution certificate. Release APKs built today use the debug key and are for testing only.
- **Icon and splash**: the default Flutter icon is still in place.
- **Store listings**: privacy policy URL; App Store privacy labels and Play data-safety form (the app shows names,
  attendance times and camera pictures of employees; it doesn't collect face data itself).
- **Review account**: Apple and Google reviewers need a demo server and manager login.
