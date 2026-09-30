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

- `login()` resolves with the user once they are signed in with a wallet, and
  rejects with `MesubSignInCancelledError` if they close the sign-in. The
  sign-in modal it opens comes with
  [#3](https://github.com/Mesub-io/react-sdk/issues/3).
- `getAccessToken()` is what to send to your server, which checks it with
  `@mesub/node`.
- A failed API call throws `MesubClientError`, with the HTTP `status` (null
  when the network failed).

The session lives in memory for now: a reload signs the user out until
[#4](https://github.com/Mesub-io/react-sdk/issues/4).

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
