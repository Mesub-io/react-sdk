# Playground

A merchant's site in two processes, to try `@mesub/react` against a local
back: a page (Vite, :5173) and its server (Express, :5174). The page uses the
package from `../src`, so an edit shows up at once. The server holds the API
key and mounts the routes of `@mesub/node` the widget calls; Vite proxies
`/api` to it, so the page and its server share one origin and the login cookie
travels.

1. The back runs locally (`pnpm start:dev` in Mesub-io/backend, on :3333).
2. A build of `@mesub/node` with the widget's routes. It is not on npm yet, so
   the server loads it from disk: `../node-sdk` next to this repo, or the
   folder `MESUB_NODE_SDK` names. The routes come with Mesub-io/node-sdk#86:

    ```sh
    cd ../node-sdk && git switch 85-widget-routes && pnpm install && pnpm build
    ```

    Without a build, or with one that predates the routes, the server stops
    and says which.

3. `playground/.env.local` (git-ignored):

    ```sh
    MESUB_API_KEY=SUB_...      # the API key of the project, from Developers
    MESUB_API_URL=http://localhost:3333
    VITE_MESUB_PLAN=pro        # the plan slug the page and the server use
    # The network the wallet signs for, solana:devnet by default here.
    VITE_MESUB_CHAIN=solana:devnet
    # Only when the build is not in ../node-sdk:
    # MESUB_NODE_SDK=/path/to/node-sdk
    ```

4. `pnpm playground:server`, and in another terminal `pnpm playground`, then
   http://localhost:5173.

## What is on the page

- **Your site's login**: a stand-in for the merchant's own auth, a cookie the
  server sets from the id you type. Mesub knows nothing of it. Signed out, the
  widget's routes answer 401 and the widget says so.
- **Subscribe**: `<SubscribeButton>` for a plan slug. The wallet needs devnet
  SOL and enough of the plan's token for one period.
- **My subscriptions**: `<ManageSubscriptions />`, with Cancel, Resume and
  Close.
- **Call my server**: `GET /api/reports`, behind `requirePlan` from
  `@mesub/node`, asked about the signed-in customer: 200 with access, 401
  signed out, 402 without the plan.

The API key never reaches the page: nothing under `VITE_` holds it, and the
page only ever calls `/api`.
