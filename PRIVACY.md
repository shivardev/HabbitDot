# Privacy

HabbitDot is designed to work without an account or cloud service.

## Data stored

The app stores habit definitions, schedules, reminder settings, completion history, and journal entries in a local SQLite database on the device.

## Data not collected

The upstream project contains no advertising SDK, telemetry SDK, remote analytics service, or push-notification token registration. Reminders are scheduled locally by the operating system.

## Data removal

Removing a habit deletes its associated app records. Uninstalling the app removes its Android application data. Installing an upgrade with the same application identifier preserves that data; uninstalling before installation does not.

Fork maintainers who add accounts, synchronization, crash reporting, or any other network feature should update this document before releasing their build.
