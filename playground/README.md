# Playground

A blank page to try `@mesub/react` against a local back, without a merchant
app. It uses the package from `../src`, so an edit shows up at once.

1. The back runs locally (`pnpm start:dev` in Mesub-io/backend, on :3333).
2. A project has a publishable key and allows `http://localhost:5173`: in the
   dashboard, or on the contract fixture project (see below).
3. `playground/.env.local`:

    ```sh
    VITE_MESUB_PUBLISHABLE_KEY=PUB_...
    VITE_MESUB_API_URL=http://localhost:3333
    # The network the wallet sends on, solana:devnet by default here.
    VITE_MESUB_CHAIN=solana:devnet
    ```

4. `pnpm playground`, then http://localhost:5173.

Signing in mails a code: locally it lands in Mailpit, http://localhost:8025.

The Subscribe card takes a plan slug (`contract` by default) and subscribes the signed-in wallet in one signature. The wallet
needs devnet SOL and enough of the plan's token for one period.

## The test server: what the access token is for

`pnpm playground:server` starts a merchant's server on http://localhost:5174:
one route, `GET /api/reports`, behind `requirePlan` from `@mesub/node`. The
Call my server card sends it your access token and shows what it answers:

- **200**: the token is valid and your wallet has access to the plan.
- **401**: no valid token, sign in first.
- **402**: signed in, but no access to the plan, subscribe first.

`@mesub/node` is not on npm yet: the server loads the local node-sdk build
(`../node-sdk`, run `pnpm build` there first). Add the project's API key to
`playground/.env.local`, next to the rest:

```sh
MESUB_API_KEY=SUB_...      # the API key of the same project, from Developers
VITE_MESUB_PLAN=pro        # the plan slug the card and the server use
```
