# @mesub/react

The browser side of [Mesub](https://mesub.io), recurring payments on Solana: a
Subscribe button and a list of subscriptions that handle the wallet for you.

It is a complement to [`@mesub/node`](https://github.com/Mesub-io/node-sdk),
which does everything on its own. This package only spares you the wallet
part in the browser: picking one, connecting it, signing in the right order.

- It **never talks to Mesub** and holds **no key**. It calls your own server,
  on the routes `@mesub/node` mounts there.
- Your customer has **no Mesub account**. Who they are comes from your own
  login: there is no sign-in here, no session, no token.
- It is **not a wallet connector** for your site. It asks a wallet for an
  account when it needs a signature, and never disconnects one.

**[Read the docs](https://docs.mesub.io/docs/react)** for the walkthrough.

[![npm](https://img.shields.io/npm/v/@mesub/react)](https://www.npmjs.com/package/@mesub/react)

> **Status: early, 0.x.** The API may still change between minor versions:
> `npm update` takes patches (0.1.x), a new minor (0.2.0) takes
> `npm install @mesub/react@latest`. See the
> [board](https://github.com/orgs/Mesub-io/projects/5) for what is next.

## Install

```sh
npm install @mesub/react
```

`react` and `react-dom` 18 or later are peer dependencies. Every release is
built by GitHub Actions from a tagged commit and published with a provenance
statement: `npm audit signatures` verifies it.

## Requirements

React 18 or 19. Works with Next.js's App Router: the build starts with
`'use client'`. Nothing Solana to install on your side.

On your server, `@mesub/node` with its routes mounted (`mesubRoutes` or
`mesubRouteHandlers`): `@mesub/react` 0.1.x works with the routes of
`@mesub/node` 0.1.x. Upgrade both to the same minor together.

## One line on each side

On your server, after your own login
([details](https://github.com/Mesub-io/node-sdk#routes-for-the-react-widget)):

```ts
import { mesubRoutes } from '@mesub/node/express';

app.use(
    '/api/mesub',
    mesubRoutes({ customer: (req) => (req.user ? { external_id: req.user.id } : null) }),
);
```

In your app, once:

```tsx
import { MesubProvider } from '@mesub/react';
import '@mesub/react/styles.css';

export function App({ children }) {
    return <MesubProvider endpoint="/api/mesub">{children}</MesubProvider>;
}
```

| Prop        | What it is                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`  | Where you mounted the routes. A path on your site, or a full URL.                                                                        |
| `chain`     | The network the wallet signs for: `solana:devnet` (the default) or `solana:mainnet`. It must match your plans' `network`.                |
| `fetch`     | Your own `(url, init) => Promise<Response>`, to add headers or credentials.                                                              |
| `theme`     | `light`, `dark` or `auto`, set on the widget as `data-mesub-theme`.                                                                      |
| `manageUrl` | Where "Cancel any time" leads once subscribed: your own page (`/account`, or a full URL). Mesub's page by default; `null` for no button. |

Requests go with `credentials: 'include'`, so your session cookie travels. If
your login is a bearer token instead, add it in `fetch`:

```tsx
<MesubProvider
    endpoint="/api/mesub"
    fetch={(url, init) =>
        fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
    }
>
```

## Subscribe

```tsx
import { SubscribeButton } from '@mesub/react';

<SubscribeButton plan="pro" onSubscribed={(subscription) => unlock(subscription)}>
    Subscribe to Pro
</SubscribeButton>;
```

`plan` is the plan's slug, as set in the Mesub dashboard. The click opens one
dialog, from the plan to the receipt:

1. **The plan**: its name, price and period, from `GET /plans/:slug`, and its end
   date when it has one. A plan that ends before a second charge can run is
   priced `once`, with the date its access runs to.
2. **A wallet**: the installed wallets that can sign
   ([Wallet Standard](https://github.com/wallet-standard/wallet-standard), so
   Phantom, Solflare and the others). The one picked is asked for its account.
3. **The review**: your server prepares the subscription
   (`POST /subscriptions`), and the dialog shows what it costs before the wallet
   is asked anything: the price, the next charge, the paying wallet, the deposit
   returned when the subscription is closed, the network fee, and the terms.
   From here to the receipt, the terms decide whether it is a single charge
   (`Amount: 2 USDC, a single charge`): no next charge is shown then, only the
   end of the access.
4. **Two approvals**: the wallet signs the terms, a message
   (`solana:signMessage`), then the transaction, without sending it
   (`solana:signTransaction`). A transaction lives about half a minute, so a
   fresh one is asked for once the terms are signed
   (`POST /subscriptions/:id/transaction`), and that one is signed. If it names
   new terms, they are shown and signed again. A server whose `@mesub/node`
   predates the route answers 404: the transaction of the review is signed.
5. **Confirming**: both go to `POST /subscriptions/:id/submit`. Mesub co-signs
   and sends the transaction, and `onSubscribed` fires once it landed.
   A transaction that expired before it was sent (`transaction_expired`, as an
   error code or as the submit's `reason_code`) is replaced once, for the same
   subscription, and signed again; a second expiry in a row stops with "Nothing
   was charged." One the wallet held past its `transaction_expires_at` is
   replaced the same way before it is submitted, the time left counted on your
   server's clock (its `Date` header) when the browser can read it.

The button is a `<button>` with `data-mesub-subscribe` and `data-mesub-state`
(`idle`, `open`, `signing`, `confirming` or `subscribed`). `children` is its
label, every other button prop goes to the button, and an `onClick` that calls
`preventDefault()` stops the flow. Once subscribed it is followed by
`<span data-mesub-receipt>`.

For a button of your own, `useSubscribe` opens the same dialog:

```tsx
import { useSubscribe } from '@mesub/react';

function Buy() {
    const { state, subscribe } = useSubscribe('pro', { onSubscribed: unlock });
    return (
        <button disabled={state !== 'idle'} onClick={() => void subscribe()}>
            {state === 'subscribed' ? 'Thanks!' : 'Buy'}
        </button>
    );
}
```

`subscribe()` resolves when the dialog closes: with the subscription, or null
when it did not go through. The hook also gives `subscription` and
`signature`, the transaction's id when the wallet is its first signer.

## Manage

```tsx
import { ManageButton } from '@mesub/react';

<ManageButton plan="pro" />;
```

A button, like `SubscribeButton`: it opens the customer's subscription to that
plan in the Mesub window. One subscription, not a list: how it stands, what is
charged next, the latest payments with their receipts, and the one thing it
allows now (cancel, resume or close). Leave `plan` out to open the customer's
live subscription whatever its plan. Pass children to word the button your way.

The payments and the next charge come from `GET /subscriptions/:id` of the
routes; on a server that predates it, the window stands without them.

To list every subscription in a page of yours instead:

```tsx
import { ManageSubscriptions } from '@mesub/react';

<ManageSubscriptions onChanged={(subscription) => refresh(subscription)} />;
```

The signed-in customer's subscriptions, from `GET /subscriptions`: each with
its plan, its status, its next charge or the end of its access, the wallet that
pays it, and the one thing it allows now. A subscription in the last period of
a plan that ends has no next charge: it shows the end of its access instead.

| The subscription is                                                    | It allows  |
| ---------------------------------------------------------------------- | ---------- |
| running (`active`, `unpaid`, `stopped`)                                | **Cancel** |
| `cancelled`, with access still running                                 | **Resume** |
| `closable: true` (ended, cancelled and past its end, stopped for good) | **Close**  |

Close follows `closable`, as Mesub last read the chain. Until then, a card
shows **Close from** and the date of `closable_from`, and offers Close once
that date passes with the page open. A cancellation with a payment missed has
no access and cannot be resumed: it offers nothing until it can be closed. A
server that predates `closable` is read by the status and the dates, as before.
A `stopped` one says why from `stop_reason`: every retry failed, the date to pay
by passed, or the wallet's approval was closed for good (that one is closed, not
cancelled).

Each opens a dialog that says what it does, then runs two steps: your server
builds a transaction (`POST /subscriptions/:id/cancel`, `/resume` or `/close`),
the wallet **signs and sends it itself** (`solana:signAndSendTransaction`), and
its signature goes to the matching `/confirm`. The list is read again after.

A late one (`unpaid`) also shows **Pay now** when paying can succeed: the
customer pays the missed period at once, with nothing to sign, through
`POST /subscriptions/:id/retry` of the routes (`subscriptions.retry` of
`@mesub/node`). Not on a paused one, on a wallet that no longer approves it,
nor past its date to pay by. What came of it is said under the button: the
payment on its way, or why not (a short wallet spends no retry). On Free,
where Mesub does not try again on its own, the card shows that date to pay by.

One whose charges are held back for a cause that is not the customer's
(`blocked_since`) says so in one line: payments are on hold, nothing is asked
of them, and until when their access runs. The cause is never named to them,
and **Pay now** is not offered meanwhile.

Only the wallet that pays a subscription can sign for it. One already
connected to your site is found without a prompt; otherwise the customer picks
it. Closing returns the deposit to that wallet.

For a list of your own, `useSubscriptions` gives the same:

```tsx
import { useSubscriptions } from '@mesub/react';

function Mine() {
    const { state, subscriptions, error, reload, manage } = useSubscriptions();

    if (state === 'signed-out') return <a href="/login">Sign in</a>;
    return subscriptions.map((held) => (
        <button key={held.id} disabled={!held.action} onClick={() => void manage(held.id)}>
            {held.plan}: {held.status}, {held.action ?? 'nothing to do'}
        </button>
    ));
}
```

- `state` is `loading`, `ready`, `signed-out` or `error` (with `error`, the
  server's message).
- `subscriptions` are newest first, each with `action`: `cancel`, `resume`,
  `close` or null, and `payable`: whether **Pay now** can succeed. Checkouts
  nobody signed are left out.
- `payNow(id)` pays that late payment now and resolves `{ ok, message }`, the
  words to show; it never throws.
- `manage(id)` opens the dialog for that action and resolves when it closes:
  the subscription as it is now, or null if nothing changed.
- Every list reads again when a subscription is made or changed through the
  widget; `reload()` does it on demand.

Fields are as `@mesub/node` serves them: snake case, dates as ISO strings.

## The states to know

Each one has its own screen, and says whether anything moved: "Nothing was
charged." (or "Nothing changed.") only when nothing can have landed.

- **Nobody signed in on your site** (your routes answer 401): the dialog says
  to sign in first and offers nothing to sign; the list says to sign in.
- **No wallet installed**: links to Phantom and Solflare, and Reload.
- **A wallet that cannot sign a message, or a transaction without sending
  it**: left out of the list, and named with what it lacks.
- **The wallet refuses** to connect, to sign the terms or to sign the
  transaction: nothing is submitted. Try again asks your server anew and shows
  the review again.
- **The terms expired** (`expires_at` passed, before or between the two
  signatures): your server is asked again and the review comes back with fresh
  terms. Stale terms are never signed nor submitted.
- **The wrong wallet** for a subscription being managed: it says which account
  the wallet is on and which one pays. Nothing is built or signed.
- **Nothing settled** (`reason` on submit or on a confirm): the widget branches
  on `reason_code`, never on the sentence. `transaction_expired` asks for a
  fresh transaction, as above, on submit, and builds a new one on a confirm.
  `nothing_landed` on submit, or `cancellation_not_landed`,
  `resume_not_landed` and `close_not_landed` on a confirm: the transaction may
  still land, so it says so and offers Check again, which sends nothing new.
  Any other code: Mesub's reason, as written, and Try again.
- **Mesub refuses** (409: already subscribed, not enough to pay the first
  period, plan closed...): its message, as written. A 403 `wallet_mismatch`
  asks for another wallet, a 429 says how long to wait.
- **The network fails or times out**: 15 seconds on reads and builds, with Try
  again. Submit and the confirms wait 90 seconds for the chain; past that, or
  on a 5xx, the outcome is unknown: "Payment may be pending" and Check again,
  which sends the same request and never a second payment.
- **Mesub is busy** (a 503 `unavailable` with `Retry-After`): on submit, too
  many at once and nothing was signed or sent, so the widget waits (2 seconds,
  10 at most) and sends the same request once more; still busy, it says how
  long to wait and offers Check again. **Pay now** refused that way holds its
  button with a countdown (about 20 seconds), says nothing was charged, then
  can be pressed again; preparing says when to try again.
- **Double clicks** open one dialog, prepare one subscription and ask the
  wallet once.

## Theming

`@mesub/react/styles.css` styles the widget only, through its `data-mesub-*`
attributes (no class names), and reads your `--mesub-*` custom properties
without ever setting them: set `--mesub-accent`, `--mesub-bg`, `--mesub-text`,
`--mesub-font` or `--mesub-radius` on `:root` to brand it. Dark mode is
`data-mesub-theme="dark"` on the widget or an ancestor, `"auto"` follows the
system, and `<MesubProvider theme="dark">` sets it on the widget for you. Under
480px the dialog is a bottom sheet, and motion follows
`prefers-reduced-motion`. Leave the stylesheet out to style the attributes
yourself.

The dialog is a native `<dialog>`; `data-mesub-step` says where it is: `plan`,
`wallet`, `review`, `approve`, `confirming`, `subscribed` when subscribing, and
`confirm`, `wallet`, `approve`, `confirming`, `done` when managing. The list is
`[data-mesub-subscriptions]`, with `data-mesub-state`, one
`[data-mesub-subscription]` per row, `[data-mesub-status]` and
`[data-mesub-action]`.

## Development

```sh
pnpm install
pnpm test          # in happy-dom, with Testing Library
pnpm typecheck
pnpm lint
pnpm build         # dist/, ESM and CJS, with declaration files
pnpm check:exports # resolves through import and require, starts with 'use client'
```

The pre-push hook runs all of it, as CI does. [`playground/`](./playground)
runs the widget against a local back, with a merchant server that mounts the
routes.

### Releasing

A version tag on main publishes, once a reviewer approves: see
[RELEASING.md](./RELEASING.md) for the one-time setup, the checklist and the
compatibility rule with `@mesub/node`, and [CHANGELOG.md](./CHANGELOG.md) for
what changed.

## License

[MIT](./LICENSE)
