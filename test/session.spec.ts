import {
    COOKIE_NAME,
    TokenStore,
    expiresAt,
    lockName,
    sessionWallet,
    storageKey,
    tokenCookie,
    tokenWallet,
    withLock,
} from '../src/session';
import { session, user } from './helpers';
import { jwt, readCookie, walletToken } from './tokens';

const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);
const https = { protocol: 'https:', hostname: 'shop.example' };

describe('expiresAt', () => {
    it('reads the exp claim, in milliseconds', () => {
        expect(expiresAt(jwt(NOW + 3600_000))).toBe(NOW + 3600_000);
    });

    it('reads a base64url payload that needs padding and has url characters', () => {
        const exp = NOW / 1000 + 1;
        const payload = Buffer.from(JSON.stringify({ sub: '??>>', exp })).toString('base64url');
        expect(expiresAt(`h.${payload}.s`)).toBe(exp * 1000);
    });

    it.each([
        ['not a JWT', 'at_1'],
        ['an empty payload', 'h..s'],
        ['a payload that is not JSON', 'h.bm90IGpzb24.s'],
        ['no exp', `h.${Buffer.from('{"sub":"x"}').toString('base64url')}.s`],
        ['an exp that is not a number', `h.${Buffer.from('{"exp":"1"}').toString('base64url')}.s`],
    ])('is null for %s', (_, token) => {
        expect(expiresAt(token)).toBeNull();
    });
});

describe('tokenWallet', () => {
    it('reads the wallet claim', () => {
        expect(tokenWallet(walletToken('W2'))).toBe('W2');
    });

    it.each([
        ['null', null],
        ['not a JWT', 'at_1'],
        ['no wallet claim', jwt(NOW)],
        ['a wallet that is not a string', jwt(NOW, 'usr_1', { wallet: 7 })],
        ['a payload that is not an object', `h.${Buffer.from('"W2"').toString('base64url')}.s`],
    ])('is null for %s', (_, token) => {
        expect(tokenWallet(token)).toBeNull();
    });
});

describe('sessionWallet', () => {
    it("is the token's wallet, even when the account's own is another", () => {
        expect(sessionWallet({ ...session, accessToken: walletToken('W2') })).toBe('W2');
    });

    it("falls back to the account's wallet when the token has none", () => {
        expect(sessionWallet(session)).toBe(user.walletAddress);
    });

    it('is null when signed out', () => {
        expect(sessionWallet(null)).toBeNull();
    });
});

describe('tokenCookie', () => {
    it('writes the token for its remaining life, Lax, Secure, on the whole site', () => {
        expect(tokenCookie(jwt(NOW + 3600_000), NOW, https)).toBe(
            `${COOKIE_NAME}=${jwt(NOW + 3600_000)}; Max-Age=3600; Path=/; SameSite=Lax; Secure`,
        );
    });

    it('rounds the remaining life down, and never below zero', () => {
        expect(tokenCookie(jwt(NOW + 1_999), NOW, https)).toContain('Max-Age=1;');
        expect(tokenCookie(jwt(NOW - 5_000), NOW, https)).toContain('Max-Age=0;');
    });

    it('falls back to an hour when the expiry cannot be read', () => {
        expect(tokenCookie('at_1', NOW, https)).toContain('Max-Age=3600;');
    });

    it.each(['localhost', '127.0.0.1', '[::1]'])('is not Secure on http://%s', (hostname) => {
        expect(tokenCookie('at_1', NOW, { protocol: 'http:', hostname })).not.toContain('Secure');
    });

    it('stays Secure on another http origin and on https://localhost', () => {
        const plain = { protocol: 'http:', hostname: 'shop.example' };
        const local = { protocol: 'https:', hostname: 'localhost' };
        expect(tokenCookie('at_1', NOW, plain)).toMatch(/; Secure$/);
        expect(tokenCookie('at_1', NOW, local)).toMatch(/; Secure$/);
    });

    it('deletes the cookie when the token is null', () => {
        expect(tokenCookie(null, NOW, https)).toBe(
            `${COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure`,
        );
    });

    it('is readable by document.cookie, then gone once deleted', () => {
        const local = { protocol: 'http:', hostname: 'localhost' };
        document.cookie = tokenCookie('at_1', NOW, local);
        expect(readCookie()).toBe('at_1');

        document.cookie = tokenCookie(null, NOW, local);
        expect(readCookie()).toBeNull();
    });
});

describe('keys', () => {
    it('are per publishable key', () => {
        expect(storageKey('PUB_1')).toBe('mesub:session:PUB_1');
        expect(lockName('PUB_1')).toBe('mesub:refresh:PUB_1');
    });
});

describe('TokenStore', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('writes, reads and clears the refresh token under its key', () => {
        const store = new TokenStore('mesub:session:PUB_1');
        expect(store.read()).toBeNull();

        store.write('rt_1');
        expect(localStorage.getItem('mesub:session:PUB_1')).toBe('rt_1');
        expect(store.read()).toBe('rt_1');

        store.clear();
        expect(store.read()).toBeNull();
    });

    it('reads undefined when storage throws, and never throws itself', () => {
        const blocked = () => {
            throw new Error('blocked');
        };
        vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
        const store = new TokenStore('k');

        expect(store.read()).toBeUndefined();
        expect(() => store.write('rt_1')).not.toThrow();
        expect(() => store.clear()).not.toThrow();
    });

    it('reads undefined when localStorage itself cannot be reached', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(new TokenStore('k').read()).toBeUndefined();
    });

    it('drops a stale token when a write fails, then stops using storage', () => {
        const items = new Map([['k', 'rt_1']]);
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: () => {
                throw new Error('full');
            },
            removeItem: (key: string) => items.delete(key),
        });
        const store = new TokenStore('k');

        store.write('rt_2');

        expect(items.has('k')).toBe(false);
        expect(store.read()).toBeUndefined();
    });
});

describe('withLock', () => {
    afterEach(() => {
        Reflect.deleteProperty(navigator, 'locks');
    });

    it('runs the task directly when the browser has no Web Locks', async () => {
        Object.defineProperty(navigator, 'locks', { value: {}, configurable: true });
        await expect(withLock('l', async () => 42)).resolves.toBe(42);
    });

    it('runs the task under navigator.locks when there is one', async () => {
        const request = vi.fn((_name: string, task: () => Promise<unknown>) => task());
        Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });

        await expect(withLock('mesub:refresh:PUB_1', async () => 'done')).resolves.toBe('done');
        expect(request).toHaveBeenCalledWith('mesub:refresh:PUB_1', expect.any(Function));
    });
});
