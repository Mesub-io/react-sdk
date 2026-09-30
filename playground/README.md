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
