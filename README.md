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

> **Status: early, 0.x, not on npm yet.** The API may still change between
> minor versions. See the [board](https://github.com/orgs/Mesub-io/projects/5)
> for what is next.

## Requirements

React 18 or 19. Works with Next.js's App Router: the build starts with
`'use client'`. Nothing Solana to install on your side.

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

1. **The plan**: its name, price and period, from `GET /plans/:slug`.
2. **A wallet**: the installed wallets that can sign
   ([Wallet Standard](https://github.com/wallet-standard/wallet-standard), so
   Phantom, Solflare and the others). The one picked is asked for its account.
3. **The review**: your server prepares the subscription
   (`POST /subscriptions`), and the dialog shows what it costs before the wallet
   is asked anything: the price, the next charge, the paying wallet, the deposit
   returned when the subscription is closed, the network fee, and the terms.
4. **Two approvals**: the wallet signs the terms, a message
   (`solana:signMessage`), then the transaction, without sending it
   (`solana:signTransaction`).
5. **Confirming**: both go to `POST /subscriptions/:id/submit`. Mesub co-signs
   and sends the transaction, and `onSubscribed` fires once it landed.

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
pays it, and the one thing it allows now.

| The subscription is                           | It allows  |
| --------------------------------------------- | ---------- |
| running (`active`, `unpaid`, `stopped`)       | **Cancel** |
| `cancelled`, with access still running        | **Resume** |
| over (`ended`, or cancelled and past its end) | **Close**  |

Each opens a dialog that says what it does, then runs two steps: your server
builds a transaction (`POST /subscriptions/:id/cancel`, `/resume` or `/close`),
the wallet **signs and sends it itself** (`solana:signAndSendTransaction`), and
its signature goes to the matching `/confirm`. The list is read again after.

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
  `close` or null. Checkouts nobody signed are left out.
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
- **Nothing landed** (`reason` on submit or on a confirm): Mesub's reason, as
  written.
- **Mesub refuses** (409: already subscribed, not enough to pay the first
  period, plan closed...): its message, as written. A 403 `wallet_mismatch`
  asks for another wallet, a 429 says how long to wait.
- **The network fails or times out**: 15 seconds on reads and builds, with Try
  again. Submit and the confirms wait 90 seconds for the chain; past that, or
  on a 5xx, the outcome is unknown: "Payment may be pending" and Check again,
  which sends the same request and never a second payment.
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

## License

[MIT](./LICENSE)
