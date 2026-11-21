# Washroom · KGP Hall Laundry

A student case-study prototype for finding a free washer and joining a FIFO queue for a particular machine. The public board supports separate halls and anonymous browser sessions. A demo room starts with one sample washer running and can be shared with another reviewer.

Machine counts are sample data. Status comes from manual check-in, cycle timers, and early completion. A machine QR opens its board action on a phone. A QR scan does not verify someone’s physical location.

## Run locally

With Node.js 22.13 or newer:

```sh
node scripts/build.mjs
node scripts/dev.mjs
```

Open http://127.0.0.1:8787. The local server uses SQLite, and the hosted Worker uses a D1 binding named `DB`. The tracked SQL migration creates the board store. Every mutation uses a versioned write so simultaneous requests cannot start the same machine twice. The board refreshes every five seconds in visible tabs.

## Evaluate

```sh
node scripts/build.mjs
node --test tests/*.test.mjs
```

Try two independent browser sessions via **Try demo** and **Share board**. Start washer 1 in the first session, queue for it in the second, then end the first wash and check in from the second. Each hall allows one active turn per browser session. Waiting residents receive a five-minute hold in queue order. A missed hold advances the line.

Built with HTML, CSS, JavaScript, Cloudflare Workers/D1, Node.js, and the Sites deployment workflow. Font and QR generator notices are in `licenses/`.
