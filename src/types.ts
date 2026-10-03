/**
 * What the merchant's routes serve, as `@mesub/node` writes it: snake case,
 * dates as ISO strings, chain numbers as strings.
 */

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

/** A subscription of the signed-in customer, as `GET /subscriptions` lists it. */
export interface MesubSubscription {
    id: string;
    status: MesubSubscriptionStatus;
    paused: boolean;
    end_reason: string | null;
    // Whether it grants access now.
    access: boolean;
    payment_status: 'paid' | 'late' | 'none';
    // The plan's slug.
    plan: string | null;
    // The wallet that pays it, and the only one that can cancel, resume or close it.
    wallet: string;
    current_period_start: string | null;
    current_period_end: string | null;
    next_charge_at: string | null;
    next_retry_at: string | null;
    retry_deadline: string | null;
    access_until: string | null;
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

/** What `POST /subscriptions` answers: the terms, then the transaction, to sign. */
export interface PreparedSubscription {
    subscription: { id: string; status: MesubSubscriptionStatus };
    // Base64, signed by nobody.
    transaction: string;
    last_valid_block_height: string;
    costs: MesubCosts;
    terms: { message: string; expires_at: string };
}

/** What submit and the confirms answer. `reason` is set when nothing landed. */
export interface Settled {
    subscription: MesubSubscription;
    reason?: string;
}

/** What cancel, resume and close answer: a transaction the wallet signs and sends. */
export interface WalletTransaction {
    transaction: string;
    last_valid_block_height: string;
}

/** What a subscription allows now. */
export type MesubAction = 'cancel' | 'resume' | 'close';
