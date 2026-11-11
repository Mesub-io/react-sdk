import { isMobileBrowser, openInWalletLinks, openInWalletUrl } from '../src/mobile';

const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET =
    'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPAD_DESKTOP =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC_CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

describe('isMobileBrowser', () => {
    it.each([
        ['iPhone Safari', IPHONE],
        ['Chrome on iOS', CHROME_IOS],
        ['Android Chrome', ANDROID],
        ['an Android tablet', ANDROID_TABLET],
    ])('says yes on %s', (_, agent) => {
        expect(isMobileBrowser(agent)).toBe(true);
    });

    it.each([
        ['a Mac', MAC_CHROME],
        ['Windows', WINDOWS],
        ['Linux', LINUX_FIREFOX],
        ['an empty agent', ''],
    ])('says no on %s', (_, agent) => {
        expect(isMobileBrowser(agent)).toBe(false);
    });

    it('takes an iPad asking for the desktop site for a phone, by its touch screen', () => {
        expect(isMobileBrowser(IPAD_DESKTOP, 5)).toBe(true);
        expect(isMobileBrowser(IPAD_DESKTOP, 0)).toBe(false);
    });
});

describe('openInWalletUrl', () => {
    const page = 'https://shop.example/pricing?plan=pro&ref=a b#top';

    it('encodes the page and its origin for Phantom', () => {
        expect(openInWalletUrl('Phantom', page)).toBe(
            'https://phantom.com/ul/browse/https%3A%2F%2Fshop.example%2Fpricing%3Fplan%3Dpro%26ref%3Da%20b%23top?ref=https%3A%2F%2Fshop.example',
        );
    });

    it('encodes the page and its origin for Solflare', () => {
        expect(openInWalletUrl('Solflare', page)).toBe(
            'https://solflare.com/ul/v1/browse/https%3A%2F%2Fshop.example%2Fpricing%3Fplan%3Dpro%26ref%3Da%20b%23top?ref=https%3A%2F%2Fshop.example',
        );
    });

    it('keeps the port in the origin', () => {
        expect(openInWalletUrl('Phantom', 'http://localhost:5173/')).toBe(
            'https://phantom.com/ul/browse/http%3A%2F%2Flocalhost%3A5173%2F?ref=http%3A%2F%2Flocalhost%3A5173',
        );
    });
});

describe('openInWalletLinks', () => {
    it('gives Phantom then Solflare', () => {
        const links = openInWalletLinks('https://shop.example/a', 'https://shop.example/b');
        expect(links.map((link) => link.wallet)).toEqual(['Phantom', 'Solflare']);
    });

    it('resolves a path against the current page', () => {
        const [phantom] = openInWalletLinks('/pricing', 'https://shop.example/account?x=1');
        expect(phantom!.href).toBe(
            'https://phantom.com/ul/browse/https%3A%2F%2Fshop.example%2Fpricing?ref=https%3A%2F%2Fshop.example',
        );
    });

    it('takes a full url on another origin as it is', () => {
        const [, solflare] = openInWalletLinks('https://pay.example/x', 'https://shop.example/');
        expect(solflare!.href).toBe(
            'https://solflare.com/ul/v1/browse/https%3A%2F%2Fpay.example%2Fx?ref=https%3A%2F%2Fpay.example',
        );
    });
});
