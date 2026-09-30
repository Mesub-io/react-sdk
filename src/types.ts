/** A subscriber, as the API returns it. Dates are ISO strings. */
export interface MesubUser {
    id: string;
    email: string;
    walletAddress: string | null;
    walletVerifiedAt: string | null;
    lastSignedInAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** What POST /session and POST /refresh return. */
export interface ClientSession {
    user: MesubUser;
    // 15 minutes, only for the two wallet steps.
    sessionToken: string;
    // Rotates on every refresh: the old one is spent.
    refreshToken: string;
    // Null until a wallet is proved.
    accessToken: string | null;
}

/** What POST /wallet returns. */
export interface WalletProof {
    user: MesubUser;
    accessToken: string;
}

/** What the provider keeps in memory. */
export interface MesubSession {
    user: MesubUser;
    refreshToken: string;
    accessToken: string | null;
}
