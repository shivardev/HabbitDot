# HabbitDot

HabbitDot is an offline-first habit tracker for Android and iOS, built with Expo, React Native, TypeScript, and SQLite. It combines fast daily check-ins, flexible dose-style targets, local reminders, history grids, and a private analytics dashboard - all without an account or backend.

## Highlights

- Multiple check-ins per habit and day (`1x` through `20x`)
- Exact-time local reminders with notification actions and ten-minute snooze
- Goal-aware reminders that stop once today's target is complete
- Calendar and contribution-grid history
- Local analytics for completion rate, perfect days, streaks, trends, weekdays, and individual habits
- Fully local SQLite storage; no advertising or analytics SDK
- Expo Go workflow for fast UI development and native development/release builds for notification testing

## Technology

| Layer | Choice |
| --- | --- |
| Application | React Native 0.86 + React 19 |
| Toolchain | Expo SDK 57 |
| Language | Strict TypeScript |
| Persistence | `expo-sqlite` |
| Notifications | `expo-notifications` |
| Time input | Native date/time picker |

## Getting started

Requirements:

- Node.js 22 or newer
- npm
- Expo Go for UI iteration, or Android Studio/Android SDK for native builds

```sh
git clone https://github.com/shivardev/HabbitDot.git
cd HabbitDot
npm ci
npm run typecheck
npm start
```

Open the displayed development URL in Expo Go. Expo Go uses its own sandboxed database, separate from an installed HabbitDot build.

### Native Android development

```sh
npm run android
```

Local notifications work in installed development and release builds. Remote push notifications are not supported by Expo Go on Android; HabbitDot currently uses local notifications.

### Release APK

The repository uses Expo Continuous Native Generation, so `android/` and `ios/` are generated and intentionally ignored.

```powershell
npx expo prebuild --clean --platform android
```

Then build from Linux or WSL with an Android SDK configured:

```sh
cd android
./gradlew assembleRelease
```

The APK is written to `android/app/build/outputs/apk/release/app-release.apk`. To upgrade a connected device without deleting its SQLite data:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Never uninstall the existing app when testing data-preserving upgrades; uninstalling removes app-local data.

## Project structure

```text
App.tsx                    App shell, habit screens, and navigation
src/AnalyticsScreen.tsx    Memoized local analytics and dashboard UI
src/database.ts            SQLite schema, migrations, and repositories
src/notifications.ts       Reminder scheduling and notification actions
assets/                    Application icons and splash assets
```

See [Architecture](docs/ARCHITECTURE.md) for data flow and design decisions.

## Privacy

HabbitDot stores habit names, schedules, and completion history only in the application's local SQLite database. It has no account system, remote API, telemetry, advertising, or third-party analytics. See [Privacy](PRIVACY.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report security-sensitive issues according to [SECURITY.md](SECURITY.md).

## License

HabbitDot is available under the [MIT License](LICENSE).
