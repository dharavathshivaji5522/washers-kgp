# Washroom · KGP Hall Laundry

An installable web app for hall washer availability, QR check-in, queues, wash completion, pickup reminders, and overdue pickup reports.

**Public demo:** https://washroom-kgp-hall-laundry.daintylion16387.chatgpt.site/?hall=lbs&demo=1

The public deployment uses sample inventories and simulated controllers. Reviewers can share a demo room with a second browser, start a wash with the built-in camera scanner or a simulated scan, queue from the second browser, observe completion, send a private reminder, and confirm clothes were collected. A washer with clothes inside stays occupied. The next resident receives their five-minute hold only after the washer clears.

## Develop and evaluate

Requires Node.js 22.13 or newer.

```sh
node scripts/build.mjs
node scripts/dev.mjs
node --test tests/*.test.mjs
```

Open http://127.0.0.1:8787. Local data uses SQLite. The hosted Worker uses D1 with the migration files under `drizzle/`. Board updates use version-checked writes, and visible clients refresh every four seconds. An in-app inbox keeps recent updates. Optional Web Push requires a supported browser, a user-granted permission, and VAPID configuration. On iOS, it is available through the Home Screen web app on supported versions.

## Institute pilot setup

A real pilot requires approved machines, a verified institute identity integration, a supported start and status interface, a tested method to confirm an empty drum, and hall procedures for belongings left behind. It requires approval from IIT KGP, the appliance vendor or authorized integrator, and the staff responsible for electrical safety. Ordinary Arduino or ESP32 boards can support a low-voltage proof of concept or gateway. The intended integration uses a vendor-approved isolated interface. It must preserve all OEM interlocks and the physical stop, with no automatic restart after faults. Power switching or safety circuit bypasses are outside the design.

The current campus gate uses the Sites identity headers plus the permitted IIT KGP email domains. A real hall pilot should replace or augment the affiliation check with an approved provider and hall roster. Room numbers, phone numbers, emails, and student IDs are excluded from the washer UI. Only the next resident sees a short display name while waiting for pickup and can send a rate-limited in-app reminder. Only allowed hall staff see reports for their hall.

Configure through Sites runtime variables or untracked local environment values:

- `PILOT_DEVICES`: JSON mapping keyed by hall and washer ID, for example `lbs/1`. Each entry has a unique high-entropy `deviceKey` and `labelKey`.
- `PILOT_STAFF`: JSON mapping of verified staff emails to arrays of assigned hall IDs.
- `PUSH_PUBLIC`, `PUSH_PRIVATE`, `PUSH_SUBJECT`: base64url uncompressed VAPID public key, private P-256 JWK, and an HTTPS or mailto identifier. Keep the private JWK secret.

See [controller contract](docs/controller.md) for pilot onboarding and bench tests.
