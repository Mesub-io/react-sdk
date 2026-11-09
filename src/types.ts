/**
 * What the merchant's routes serve, as `@mesub/node` writes it: snake case,
 * dates as ISO strings, chain numbers as strings.
 */

/** What Mesub knows of a plan's token. Never the merchant's words. */
export interface MesubToken {
    symbol: string | null;
    name: string | null;
    logo_url: string | null;
    // True for a mint Mesub vouches for, or one Jupiter verifies.
    verified: boolean;
}

/** A plan, as `GET /plans/:slug` serves it. */
export interface MesubPlan {
    slug: string;
    name: string;
    description: string | null;
    project_name: string;
    logo_url: string | null;
    // Base units, a string: a u64 does not survive JSON's float.
    amount: string;
    // The price as a person counts it: "9.99".
    amount_display: string;
    decimals: number;
    // Null for a token Mesub does not vouch for.
    symbol: string | null;
    mint: string;
    // Both absent from a server that predates them.
    token?: MesubToken | null | undefined;
    // Decimal dollars at the latest known price.
    amount_usd?: string | null | undefined;
    period_hours: number;
    network: 'devnet' | 'mainnet-beta';
    status: 'active' | 'sunset';
    // False when the plan takes no new subscribers.
    available: boolean;
    ends_at: string | null;
}

export type MesubSubscriptionStatus =
    | 'pending'
    | 'active'
    | 'cancelled'
    | 'unpaid'
    | 'stopped'
    | 'ended'
    | 'failed'
    | 'expired'
    | 'superseded';

/**
 * Why charges are held back: the merchant's own setup by name (the last two
 * the token issuer's to lift), `mesub` for any cause of Mesub's. The widget
 * words every one the same to the subscriber.
 */
export type MesubBlockedReason =
    | 'puller_not_allowed'
    | 'receiver_not_allowed'
    | 'receiver_account_missing'
    | 'receiver_account_frozen'
    | 'receiver_account_needs_memo'
    | 'receiver_account_confidential_only'
    | 'mint_gone'
    | 'mint_paused'
    | 'mint_transfer_hook'
    | 'mesub';

/**
 * Why a `stopped` one stopped (Mesub-io/backend#402): every retry failed, the
 * Free date to pay by passed, or the wallet closed the account that lets
 * Mesub charge it, for good. A newer one may come.
 */
export type MesubStopReason = 'out_of_retries' | 'retry_deadline_passed' | 'authority_closed';

/** A subscription of the signed-in customer, as `GET /subscriptions` lists it. */
export interface MesubSubscription {
    id: string;
    status: MesubSubscriptionStatus;
    paused: boolean;
    // Why an `ended` one ended: cancelled, plan_removed, plan_replaced, plan_ended,
    // closed_elsewhere (its account closed outside Mesub; authority_closed before
    // Mesub-io/backend#476) or closed; null on any other status. A newer one may come.
    end_reason: string | null;
    // Why a payment is late, on an `unpaid` one: insufficient_balance, approval_revoked,
    // authority_closed, or null. A newer one is read as null.
    late_reason: string | null;
    // Why a `stopped` one stopped; null on any other status, and on one stopped before
    // Mesub recorded why. Absent from an older server. A newer one is read as null.
    stop_reason?: MesubStopReason | null;
    // Whether it grants access now.
    access: boolean;
    payment_status: 'paid' | 'late' | 'none';
    // Since when its charges are held back for a reason that is not the subscriber's
    // (Mesub-io/backend#426), and whose it is. Both absent from an older server.
    blocked_since?: string | null;
    blocked_reason?: MesubBlockedReason | null;
    // The plan's slug.
    plan: string | null;
    // The wallet that pays it, and the only one that can cancel, resume or close it.
    wallet: string;
    current_period_start: string | null;
    current_period_end: string | null;
    next_charge_at: string | null;
    next_retry_at: string | null;
    // Which try comes next, out of how many the plan allows: 2 and 3 for "retry 2 / 3". Null
    // unless Mesub retries on its own; absent from an older server.
    next_retry_number?: number | null;
    retries_allowed?: number | null;
    retry_deadline: string | null;
    access_until: string | null;
    // Whether the wallet can close it on Solana now and get its deposit back, and from
    // when if not now (null when no date is known yet: a running one must be cancelled
    // first). As Mesub last read the chain (Mesub-io/backend#402). Absent from an older server.
    closable?: boolean;
    closable_from?: string | null;
    created_at: string;
    confirmed_at: string | null;
}

/** What subscribing costs in SOL, in lamports. */
export interface MesubCosts {
    // Given back when the subscription is closed.
    rent: { subscription: string; authority: string | null; total: string };
    fee: { signatures: number; per_signature: string; priority: string; total: string };
    total: string;
}

/**
 * What `POST /subscriptions` answers: the terms, then the transaction, to sign.
 * `POST /subscriptions/:id/transaction` answers the same, with a fresh transaction.
 */
export interface PreparedSubscription {
    subscription: { id: string; status: MesubSubscriptionStatus };
    // Base64, signed by nobody.
    transaction: string;
    last_valid_block_height: string;
    // When that block height should pass: an estimate that errs early, about half a minute
    // after the answer (Mesub-io/backend#471). Null or absent from an older server.
    transaction_expires_at?: string | null;
    costs: MesubCosts;
    terms: { message: string; expires_at: string };
}

/**
 * What submit and the confirms answer. `reason` is set when nothing was settled: a
 * sentence for a person, which Mesub may reword. `reason_code` comes with it
 * (Mesub-io/backend#470), for the widget to branch on: `transaction_expired`,
 * `nothing_landed`, `close_not_landed`... An open family; absent from an older server.
 */
export interface Settled {
    subscription: MesubSubscription;
    reason?: string;
    reason_code?: string;
}

/** What cancel, resume and close answer: a transaction the wallet signs and sends. */
export interface WalletTransaction {
    transaction: string;
    last_valid_block_height: string;
    // As on `PreparedSubscription`. Null or absent from an older server.
    transaction_expires_at?: string | null;
}

/** One charge Mesub tried, as the merchant's server hands it on. */
export interface MesubPayment {
    attempted_at: string;
    // paid, rejected (the wallet was short), skipped, blocked: a newer one is handed on as is.
    outcome: string;
    // The token's base units.
    amount: string;
    // Decimal dollars at the charge. Absent from an older server.
    amount_usd?: string | null | undefined;
    reason: string | null;
    // The transaction, once something was sent.
    signature: string | null;
    // A retry of a missed charge. Null or absent when the server does not say.
    retry?: boolean | null;
    // Which retry it was, out of how many the plan allowed. Absent or null when it was not one.
    retry_number?: number | null;
    retries_allowed?: number | null;
    // The start of the period it was for. Null when Mesub recorded none; absent from an older server.
    period_start?: string | null;
}

/** The one charge Mesub announces next, as the merchant's server serves it. */
export interface MesubUpcoming {
    // `charge` at the due date of a running one, `retry` of a missed one.
    kind: string;
    due_at: string;
    // The plan's price in the token's base units, and as a person counts it. Null when the
    // server could not read the plan.
    amount: string | null;
    amount_display: string | null;
    // That price in dollars at the latest price Mesub knows: an estimate, never what is
    // charged. Null when Mesub knows no price; absent from an older server.
    amount_usd?: string | null;
    // On a retry: which one comes, out of how many. Absent or null when the server does not say.
    retry_number?: number | null;
    retries_allowed?: number | null;
}

/** What `GET /subscriptions/:id` answers: the subscription, what comes next, its latest charges. */
export interface MesubSubscriptionDetail {
    subscription: MesubSubscription;
    // Soonest first, one at most today. Empty when nothing is due, or on an older server.
    upcoming: MesubUpcoming[];
    // Newest first. Null when they could not be read: `payments_error` says why.
    payments: MesubPayment[] | null;
    // Why `payments` is null, null otherwise and from an older server.
    payments_error: { code: string; message: string } | null;
    // What was paid since it began, in base units. Null when the server does not say.
    paid: { count: number; amount: string | null } | null;
}

/** What `GET /subscriptions` answers. */
export interface MesubSubscriptionList {
    // Newest first, the 500 newest at most.
    subscriptions: MesubSubscription[];
    // True when the customer has more than those, which the server did not read.
    has_more: boolean;
}

/** What a subscription allows now. */
export type MesubAction = 'cancel' | 'resume' | 'close';
