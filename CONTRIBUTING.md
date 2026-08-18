# Contributing to HabbitDot

Thanks for helping improve HabbitDot.

## Before you start

- Search existing issues before opening a new one.
- Discuss substantial behavior, storage, or UI changes in an issue first.
- Do not include proprietary assets, device dumps, credentials, or personal habit data.
- Preserve the app's offline-first design unless a change has been explicitly agreed upon.

## Local development

```sh
npm ci
npm run typecheck
npm start
```

Before submitting a pull request, run:

```sh
npm run check
```

## Pull requests

- Keep changes focused and explain the user-visible outcome.
- Include screenshots or a recording for visual changes.
- Document database migrations and notification behavior changes.
- State which environments you tested: Expo Go, Android development build, or release APK.
- Add or update documentation when behavior or setup changes.

## Code guidelines

- Keep persistence logic in `src/database.ts` and notification scheduling in `src/notifications.ts`.
- Prefer strict TypeScript types over assertions or `any`.
- Keep analytics calculations deterministic and memoized where appropriate.
- Avoid network dependencies for features that can operate locally.

By contributing, you agree that your contribution is licensed under the MIT License.
