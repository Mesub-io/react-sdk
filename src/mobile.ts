/**
 * On a phone, Solana wallets are apps: the browser sees none of them. Each one
 * can reopen a page in its own browser, where the widget finds it.
 */

export type WalletApp = 'Phantom' | 'Solflare';

// iPadOS asks for the desktop site: it says Macintosh, but has a touch screen.
const PHONE = /Android|iPhone|iPad|iPod|Mobile/i;

/** A phone or a tablet, from its user agent. Pure: the caller reads the navigator. */
export function isMobileBrowser(userAgent: string, maxTouchPoints = 0): boolean {
    if (PHONE.test(userAgent)) return true;
    return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

const BROWSE: Record<WalletApp, string> = {
    Phantom: 'https://phantom.com/ul/browse/',
    Solflare: 'https://solflare.com/ul/v1/browse/',
};

/**
 * The universal link that reopens `page` in the wallet's browser, or leads to
 * the app when it is not installed. `page` must be absolute.
 */
export function openInWalletUrl(wallet: WalletApp, page: string): string {
    const { origin } = new URL(page);
    return `${BROWSE[wallet]}${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`;
}

/** One link per wallet, for `page` resolved against `base` (the current page). */
export function openInWalletLinks(
    page: string,
    base: string,
): { wallet: WalletApp; href: string }[] {
    const absolute = new URL(page, base).href;
    return (Object.keys(BROWSE) as WalletApp[]).map((wallet) => ({
        wallet,
        href: openInWalletUrl(wallet, absolute),
    }));
}

/** Whether this browser is a phone's. False on the server. */
export function onMobile(): boolean {
    if (typeof navigator === 'undefined') return false;
    return isMobileBrowser(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
}
