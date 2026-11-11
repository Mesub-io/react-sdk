# Changelog

Every change a merchant using `@mesub/react` can notice. Versions follow
[semver](https://semver.org); while the major is 0, a minor version (0.2.0)
may break the API and a patch (0.1.1) never does. Pull request numbers are
those of Mesub-io/react-sdk.

## 0.1.4 (unreleased)

- On a phone, wallets are apps the browser cannot see. With no wallet found
  there, the widget no longer offers to install one: it offers "Open this
  page in your wallet", one link each for Phantom and Solflare, which reopen
  the page in the wallet's own browser, or lead to the app when it is not
  installed. Desktop keeps the Install links. `openInWalletUrl` on
  `MesubProvider` names the page to reopen; the current one by default
  (#90).

## 0.1.3 (2026-11-09)

Works with the routes of `@mesub/node` 0.1.x, as before.

- `MesubBlockedReason` names the four causes the API serves that this release
  did not know: `receiver_account_needs_memo`,
  `receiver_account_confidential_only`, `mint_paused` and
  `mint_transfer_hook`. The widget words them as every other block: payments
  on hold, nothing for the subscriber to do (#84).
- `MesubSubscription` types `next_retry_number` and `retries_allowed`, as the
  routes of `@mesub/node` serve them. The payments and the charge to come read
  in the window carry `retry`, `period_start` and `amount_usd`; amounts are in
  the token's base units; `transaction_expires_at` may be null (#86).
- `useSubscriptions` gives `hasMore`: true when the customer holds more
  subscriptions than the server listed. `ManageSubscriptions` says so under
  its list, and the window no longer says "not subscribed" when the one to
  that plan may be among those left out (#86).
- When the server could not read a subscription's past payments
  (`payments_error`), its window says so in one line instead of showing none
  (#86).

## 0.1.2 (2026-10-21)

Works with the routes of `@mesub/node` 0.1.x, as before. Also brings the
changes of 0.1.1 to npm: 0.1.1 was tagged but never reached npm, its release
stopped by npm before publishing.

- A plan's end is shown with its exact time, in UTC: `Oct 20, 2026, 23:59 UTC`,
  never the day alone, also on a plan that ends at the end of a day. The same
  for every subscriber, whatever their zone, on the plan, the review, the
  receipt, the subscription's detail and the resume dialog (#81).

## 0.1.1 (2026-10-20, never published to npm)

Works with the routes of `@mesub/node` 0.1.x, as before.

- `chain` defaults to `solana:mainnet`, where Mesub runs. Under 0.1.0 a
  provider without `chain` had the wallet sign for another network than
  Mesub's plans (#77).

## 0.1.0 (2026-10-16)

The first version published to npm. Requires React 18 or 19, and on your
server the routes of `@mesub/node` 0.1.x.

### Provider

- `<MesubProvider endpoint>` points the widget at the routes `@mesub/node`
  mounts on your server (`mesubRoutes`, `mesubRouteHandlers`). It never talks
  to Mesub and holds no key; the customer has no Mesub account, and who they
  are comes from your own login (#30).
- Requests go with `credentials: 'include'`, so your session cookie travels;
  `fetch` takes your own function, to add a bearer token or headers (#30).
- `chain` is the network the wallet signs for, `solana:devnet` by default or
  `solana:mainnet`, matching your plans' `network` (#16, #68).
- `theme` (`light`, `dark` or `auto`) and `manageUrl`, where "Cancel any
  time" leads once subscribed: your page, Mesub's by default, `null` for no
  button (#30, #67).
- The build starts with `'use client'`, for Next.js's App Router.

### Subscribe

- `<SubscribeButton plan>` opens one dialog from the plan to the receipt: the
  plan, a Wallet Standard wallet that can sign, a review of what it costs
  (price, next charge, paying wallet, the deposit returned on close, the
  network fee, the terms), two approvals, then the confirmation;
  `onSubscribed` fires once it landed (#11, #20, #22, #30).
- `useSubscribe(plan)` opens the same dialog from a button of your own, with
  `state`, `subscription` and `signature` (#30).
- The wallet signs the terms (`solana:signMessage`), then the transaction
  without sending it (`solana:signTransaction`); Mesub co-signs and sends it.
  Once the terms are signed a fresh transaction is asked for
  (`POST /subscriptions/:id/transaction`), and from a server whose routes
  predate it the review's transaction is signed (#52).
- A transaction that expired before it was sent (`transaction_expired`) is
  replaced once for the same subscription and signed again; one the wallet
  held past its `transaction_expires_at` is replaced before it is submitted,
  counted on your server's clock (#62).
- The plan's end date is shown, and a plan that ends before a second charge
  can run reads as a single charge, with the date its access runs to (#46,
  #48).
- The token's symbol, image and dollar value come from the plan; an
  unverified token never reads as a stablecoin Mesub vouches for, and large
  token prices are shortened (#54, #56).
- Switching wallet inside the dialog (#28).

### Manage

- `<ManageButton plan>` opens the customer's subscription to that plan in the
  Mesub window: how it stands, what is charged next, the latest payments with
  their receipts, and the one thing it allows now. Without `plan`, their live
  subscription whatever its plan (#30, #44, #67).
- `<ManageSubscriptions>` lists the signed-in customer's subscriptions in a
  page of yours, and `useSubscriptions()` gives the same for a list of your
  own: `state`, `subscriptions` (each with `action` and `payable`), `error`,
  `reload`, `manage(id)` and `payNow(id)` (#30).
- Cancel, Resume and Close: your server builds the transaction, the wallet
  signs and sends it (`solana:signAndSendTransaction`), its signature goes to
  the matching `/confirm`. Close follows `closable`, and shows **Close from**
  and the date of `closable_from` until then; none is offered on a
  subscription closed elsewhere (#30, #60, #62).
- Only the wallet that pays a subscription can sign for it: one already
  connected is found without a prompt, the wrong one is named with the one
  that pays (#30).
- Why a payment is late (`late_reason`), why one stopped (`stop_reason`), and
  the hour of a charge that is close (#36, #40, #62).
- One whose charges are held for a cause that is not the customer's
  (`blocked_since`) says so in one line, never naming the cause, and offers
  no Pay now meanwhile (#52).
- The window and the list have the checkout's look (#67).

### Pay now

- A late (`unpaid`) subscription shows **Pay now** when paying can succeed:
  the missed period is paid at once, with nothing to sign, through
  `POST /subscriptions/:id/retry` (`subscriptions.retry` of `@mesub/node`).
  Not on a paused one, on a wallet that no longer approves it, nor past its
  date to pay by. What came of it is said under the button; on Free, the card
  shows the date to pay by (#50).
- Refused because Mesub is busy (503 `unavailable`), the button holds with a
  countdown of about 20 seconds, says nothing was charged, then can be pressed
  again (#65).

### Errors and states

- Each state has its own screen and says whether anything moved: "Nothing
  was charged." only when nothing can have landed. Nobody signed in (your
  routes answer 401), no wallet installed, a wallet that lacks a feature, a
  wallet refusing, terms that expired, the wrong wallet (#30).
- The widget branches on `reason_code`, never on Mesub's sentence:
  `transaction_expired` asks for a fresh transaction, `nothing_landed` and
  the `*_not_landed` codes offer Check again, which sends nothing new (#62).
- Mesub's refusals (409) are shown as written; a 403 `wallet_mismatch` asks
  for another wallet, a 429 says how long to wait. Attempt outcomes and
  reasons are read in lowercase snake case (#34, #38, #58).
- Reads and builds time out after 15 seconds, submit and the confirms after
  90: past that, or on a 5xx, "Payment may be pending" and Check again, never
  a second payment (#14, #30).
- A 503 `unavailable` on submit (too many at once, nothing signed or sent):
  the widget waits as `Retry-After` says (2 seconds, 10 at most) and sends the
  same request once more, then says how long to wait (#65).
- Double clicks open one dialog, prepare one subscription and ask the wallet
  once.

### Theming

- `@mesub/react/styles.css` styles the widget only, through its
  `data-mesub-*` attributes, no class names. It reads `--mesub-accent`,
  `--mesub-bg`, `--mesub-text`, `--mesub-font` and `--mesub-radius` without
  setting them. Dark mode by `data-mesub-theme`, a bottom sheet under 480px,
  motion that follows `prefers-reduced-motion` (#22, #26, #42).
- The dialog is a native `<dialog>`, and `data-mesub-step`,
  `data-mesub-state` and the list's attributes say where it is, for styles
  and tests of your own (#30).

### Requirements

- React 18 or 19 (peer dependency, tested on both). Nothing Solana to install
  on your side: `@solana/kit` and `@wallet-standard/react` come with it.
- `@mesub/node` 0.1.x on your server, with its widget routes mounted:
  `GET /plans/:slug`, `GET /subscriptions`, `GET /subscriptions/:id`,
  `POST /subscriptions`, `/transaction`, `/submit`, `/retry`, and `/cancel`,
  `/resume`, `/close` with their `/confirm`.

### Releases and CI

- Published from a version tag on main only, after a reviewer approves the
  `npm` environment, with npm provenance and no npm token stored (#70).
- CI runs lint, format, typecheck, tests, build and the exports check, and
  the tests and typecheck again on React 18 (#24).
