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
