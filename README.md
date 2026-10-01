# @mesub/react

React SDK for [Mesub](https://mesub.io), recurring payments on Solana.

It runs on the merchant's own site: it signs a subscriber in (email, then
wallet) and subscribes them to a plan in one signature. The server side is
[`@mesub/node`](https://github.com/Mesub-io/node-sdk), which verifies the
access token this package holds and answers whether the subscriber has access.

> **Status: in progress, not published.** See the
> [board](https://github.com/orgs/Mesub-io/projects/5) and the
> [issues](https://github.com/Mesub-io/react-sdk/issues).

## Requirements

React 18 or 19. Works with Next.js's App Router: the build starts with
`'use client'`.

## Usage

Wrap the app once, with the project's publishable key:

```tsx
import { MesubProvider } from '@mesub/react';

export function App({ children }) {
    return <MesubProvider publishableKey="PUB_...">{children}</MesubProvider>;
}
```

`apiUrl` points it at another API (defaults to `https://api.mesub.io`).

Then read the session anywhere below it:

```tsx
import { useMesub } from '@mesub/react';

function Account() {
    const { ready, user, wallet, login, logout, getAccessToken } = useMesub();

    if (!ready) return null;
    if (!user) return <button onClick={() => login()}>Sign in</button>;
    return <button onClick={() => logout()}>Sign out {wallet}</button>;
}
```

- `login()` opens the sign-in modal, resolves with the user once they are
  signed in with a wallet, and rejects with `MesubSignInCancelledError` if they
  close it.
- `getAccessToken()` is what to send to your server, which checks it with
  `@mesub/node`.
- A failed API call throws `MesubClientError`, with the HTTP `status` (null
  when the network failed).
- API calls time out after 15 seconds, with a `MesubClientError` whose `status` is null.

## Sign-in

The provider renders the modal itself while a `login()` waits: there is no
component to place. One Mesub account per person, email first, then the
wallet:

1. The email: Mesub mails a 6-digit code.
2. The code. A returning subscriber, whose account already has a wallet, is
   signed in here and signs nothing.
3. The wallet: the modal lists the installed wallets that can sign a message on
   Solana ([Wallet Standard](https://github.com/wallet-standard/wallet-standard),
   so Phantom, Solflare and the others), connects the one picked and asks it to
   sign a message. It costs nothing and moves nothing.

Each step shows the API's own error (wrong or expired code, origin not allowed,
a wallet already on another account) or the wallet's refusal, and can go back.
Close or Escape cancels. Nothing Solana to install on the merchant's side.

The modal is plain HTML in a `<dialog>`, with no CSS and no class names. Its
parts carry `data-mesub-*` attributes to style it by: `data-mesub-dialog` (with
`data-mesub-step` set to `email`, `code` or `wallet`), `data-mesub-form`,
`data-mesub-input`, `data-mesub-submit`, `data-mesub-resend`, `data-mesub-back`,
`data-mesub-close`, `data-mesub-wallets`, `data-mesub-wallet` (the wallet's
name), `data-mesub-no-wallet`, `data-mesub-error` and `data-mesub-notice`.

## Session

The session survives reloads. The refresh token is kept in the site's
`localStorage`, under `mesub:session:<publishableKey>`, and nothing else is: on
load the provider trades it for a fresh session, and `ready` stays false until
that answers. A refused token (spent, expired, revoked) is cleared and the user
is signed out; an unreachable API keeps it, signed out, and tries again when
the browser is back online.

The access token lasts an hour. The provider refreshes it a minute before it
expires, and `getAccessToken()` refreshes first when it is expired or about to
be, one refresh for every concurrent caller. Each refresh rotates the refresh
token, and presenting a spent one ends every session of the account, so the
tabs of a site take turns: a refresh always spends the token `localStorage`
holds at that moment, under a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)
shared by the tabs, and a tab picks up the token another one rotated through
the `storage` event. Signing in or out in one tab does the same in the others.

The access token is also written to a `mesub-token` cookie on the site's own
domain (`Path=/`, `SameSite=Lax`, `Secure` except on `http://localhost`), for
as long as the token lives, and rewritten on each refresh. That is what
`@mesub/node` reads on page loads and server rendering. `logout()` clears the
storage and the cookie, then ends the session on the API.

## Subscribe

```tsx
import { SubscribeButton } from '@mesub/react';

<SubscribeButton plan="pro" onSubscribed={(subscription) => unlock(subscription)}>
    Subscribe to Pro
</SubscribeButton>;
```

`plan` is the plan's slug, as set in the dashboard. On click it opens the
Mesub checkout, one dialog from the click to the receipt:

1. **Sign-in**, when nobody is signed in: the steps of the modal above, in the
   same window.
2. **Review**: the merchant, the plan, the price and its cadence, what is due
   today, the next charge, the paying wallet and the cancel terms, read from
   `GET /v1/client/plans/:slug`. Nothing is signed until "Subscribe and pay".
   A plan that takes no new subscribers says so, and its button is disabled.
3. **Approve**: the wallet signs and sends one transaction for all of it (the
   subscription and the first period's payment).
4. **Confirming**, then **Subscribed**: the next charge and the transaction on
   Solana Explorer. `onSubscribed` fires once it is confirmed.

- The wallet that signs is the one the session proved. A wallet on another
  account is refused with a message saying which to switch to.
- It needs a wallet with `solana:signAndSendTransaction`: the wallet sends the
  transaction itself, so there is no RPC to configure.
- `chain` names the network the wallet sends on: `solana:devnet` by default
  while Mesub runs on devnet, `solana:mainnet` once it runs there. Off mainnet
  the review marks a test network.
- An error stays on its step and says whether money moved: a refusal before
  the wallet sent ends on "Nothing was charged.", a transaction that may have
  landed says to wait for it.
- `checkout={false}` skips the dialog: the click signs at once (signing in
  first through the modal above) and the button alone shows the progress.

The checkout is unstyled like the modal: `data-mesub-step` is also `review`,
`approve`, `confirming` or `subscribed`, with `data-mesub-merchant`,
`data-mesub-price`, `data-mesub-summary` and its `data-mesub-row` rows,
`data-mesub-terms`, `data-mesub-network`, `data-mesub-warning`,
`data-mesub-explorer`, `data-mesub-cancel` and `data-mesub-done`.

The button is a `<button>` with `data-mesub-subscribe` and `data-mesub-state`
(`idle`, `signing`, `confirming`, `subscribed` or `error`), following the
checkout. With `checkout={false}` it is followed in the error state by a
`<span role="alert" data-mesub-error>`. `children` is the idle label, and every
other button prop (`className`, `id`, `onClick`, a `ref`) goes to the button.
An `onClick` that calls `preventDefault()` stops the flow.

For a button of your own, `useSubscribe` runs the same flow:

```tsx
import { useSubscribe } from '@mesub/react';

function Buy() {
    const { state, error, subscribe } = useSubscribe('pro', { chain: 'solana:devnet' });
    return (
        <button disabled={state === 'signing' || state === 'confirming'} onClick={subscribe}>
            {state === 'subscribed' ? 'Thanks!' : (error ?? 'Buy')}
        </button>
    );
}
```

`subscribe()` resolves with the subscription, or null when it did not go
through.

## Development

```sh
pnpm install
pnpm test          # in happy-dom, with Testing Library
pnpm typecheck
pnpm lint
pnpm build         # dist/, ESM and CJS, with declaration files
pnpm check:exports # resolves through import and require, starts with 'use client'
```

The pre-push hook runs all of it, as CI does.

## License

[MIT](./LICENSE)
