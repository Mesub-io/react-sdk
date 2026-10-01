import type { Get } from './api';

/** A plan as GET /v1/client/plans/:slug serves it: what the checkout shows. */
export interface MesubPlan {
    slug: string;
    name: string;
    description: string | null;
    // Base units, a string: a u64 does not survive JSON's float.
    amount: string;
    mint: string;
    // Null for a mint Mesub does not vouch for.
    symbol: string | null;
    decimals: number;
    periodHours: number;
    network: 'devnet' | 'mainnet-beta';
    merchant: { name: string; logoUrl: string | null; websiteUrl: string | null };
    // False when the plan takes no new subscribers: closed, ended or full.
    available: boolean;
}

export interface PlansApi {
    get(slug: string): Promise<MesubPlan>;
}

export function createPlansApi(get: Get): PlansApi {
    return { get: (slug) => get(`/${encodeURIComponent(slug)}`) };
}
