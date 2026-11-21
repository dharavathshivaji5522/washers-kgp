# Washer controller contract

The public review room is a simulation. This interface is for an isolated bench test or an institute-approved gateway paired with a compatible washer.

## Pair a test controller

1. Use a distinct high-entropy API bearer token and a separate QR label identifier per machine. Keep the bearer token only in the runtime secret and provisioned controller. Configure the applicable hall and washer entry under `PILOT_DEVICES`.
2. Print a QR pointing to `/?hall=lbs&machine=1&label=YOUR_LABEL_KEY`, with the actual origin and assigned values. The label identifies a machine. A photo of the label alone cannot authorize a start.
3. With a verified resident account, scan the label with the app’s camera, and enter the short-lived PIN displayed at that washer. The service checks identity, reservation, exact washer, current code, and controller status before it creates a command. Accepted codes are consumed. No code or bearer value is sent to a board viewer.
4. To bench test without an appliance, run the Node simulator with `WASHROOM_CONTROLLER_TOKEN` and `WASHROOM_LABEL_KEY` set in its environment. Pass origin, hall slug, and washer ID. The simulator prints its label link and demonstrates the status transitions with `pin`, `finish`, and `clear`. It never controls a real load.

## Message contract

Send HTTPS POST to `/api/controller?hall=lbs&washer=1` with its own bearer token. Each successful response has `now` and either `command: null` or `{ id, expiresAt, requestedMinutes }`.

| Event | Meaning |
| --- | --- |
| `ready` | The controller has verified an idle, empty washer before announcing availability. |
| `heartbeat` | Poll for a command and update connectivity. Aim for every 10 seconds. Silence for 45 seconds takes the washer offline. |
| `presence` + `pin` | Present a fresh six-digit code at the washer, valid for up to 45 seconds. The controller should generate it only when the resident requests it locally. |
| `started` + `command` | Send only after the approved interface confirms the authorized cycle began. |
| `complete` + `command` | Send after the appliance confirms the cycle ended. The app moves to Clothes inside. |
| `clear` + `command` | Send only after confirming the drum is empty through the approved method. A policy-governed staff handoff can be the fallback. Door opening alone is insufficient. |
| `rejected` + `command` | Send if the controller positively verified it did not start. The washer goes offline for review. |
| `fault` | Stop accepting commands. An uncertain start stays blocked until reconciled. |

The gateway must independently enforce the expiry, physical safety checks, and durable command deduplication across reboots. When the physical state is uncertain, fail closed and let staff reconcile state. The service does not infer completion or an empty drum from elapsed time for physical washers. An expected duration is a display estimate.

Pilot hardware selection, integration, safe local controls, firmware lifecycle, permission to start remotely, and inspection must be validated by the institute and an authorized appliance integrator. Test on a bench and use one approved washer before student rollout.
