import { getBase58Decoder } from '@solana/kit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
    MesubProvider,
    SubscribeButton,
    useMesub,
    type MesubPlan,
    type MesubState,
    type MesubSubscription,
} from '../src';
import type { MesubWallet } from '../src/wallets-api';
import { json, user } from './helpers';
import { walletToken } from './tokens';
import { registerWallet, unregisterWallets } from './wallets';

const API = 'http://api.test/v1/client';
const W1 = user.walletAddress!;
const W2 = 'Ledger22222222222222222222222222222222222222';
const W3 = 'So1f1are333333333333333333333333333333333333';

const plan: MesubPlan = {
    slug: 'pro',
    name: 'Pro',
    description: null,
    amount: '2000000',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    periodHours: 72,
    network: 'devnet',
    merchant: { name: 'Fraise', logoUrl: null, websiteUrl: null },
    available: true,
};
const pending: MesubSubscription = {
    id: 'sub_1',
    planId: 'pln_1',
    subscriber: W2,
    status: 'PENDING',
    currentPeriodStartTs: null,
    dueAt: null,
    expiresAtTs: '0',
    createTxSignature: null,
    confirmedAt: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
};

const free: MesubWallet[] = [
    { address: W1, label: null, selected: true, plans: [] },
    { address: W2, label: 'Ledger', selected: false, plans: [] },
];
const holding = (plans: string[]): MesubWallet[] => [{ ...free[0]!, plans }, free[1]!];

type Handler = (body: Record<string, unknown> | null) => Response | Promise<Response>;

function api(wallets: MesubWallet[], overrides: Record<string, Handler> = {}) {
    const handlers: Record<string, Handler> = {
        'GET /plans/pro': () => json(200, plan),
        'POST /auth/code': () => json(204),
        'POST /auth/session': () =>
            json(201, {
                user,
                sessionToken: 'st_1',
                refreshToken: 'rt_1',
                accessToken: walletToken(W1),
            }),
        'GET /auth/wallets': () => json(200, { wallets }),
        'POST /auth/wallet/select': (body) =>
            json(201, { user, accessToken: walletToken(body!.address as string) }),
        'POST /auth/wallets/challenge': (body) =>
            json(201, { message: `Link ${body!.address as string} to Mesub` }),
        'POST /auth/wallets': (body) =>
            json(201, { user, accessToken: walletToken(body!.address as string) }),
        'POST /subscriptions': () => json(201, pending),
        'POST /subscriptions/sub_1/transaction': () =>
            json(201, { transaction: btoa('tx'), lastValidBlockHeight: '1' }),
        'POST /subscriptions/sub_1/confirm': () =>
            json(201, { subscription: { ...pending, status: 'ACTIVE' } }),
        ...overrides,
    };
    return vi.fn(async (url: string, init: RequestInit) => {
        const key = `${init.method} ${url.slice(API.length)}`;
        const handler = handlers[key];
        if (!handler) throw new Error(`unexpected call to ${key}`);
        return handler(
            init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
        );
    });
}

type Fetch = ReturnType<typeof api>;

function calls(fetch: Fetch, key: string) {
    return fetch.mock.calls.filter(
        ([url, init]) => `${init.method} ${url.slice(API.length)}` === key,
    );
}

const bodyOf = (fetch: Fetch, key: string, index = 0) =>
    JSON.parse(calls(fetch, key)[index]![1].body as string) as unknown;
const bearerOf = (fetch: Fetch, key: string, index = 0) =>
    (calls(fetch, key)[index]![1].headers as Record<string, string>).Authorization;

/** Signed in through the modal, then the checkout opened on its review. */
async function review(wallets: MesubWallet[] = free, overrides: Record<string, Handler> = {}) {
    const fetch = api(wallets, overrides);
    let state!: MesubState;
    function Probe() {
        state = useMesub();
        return null;
    }
    render(
        <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
            <Probe />
            <SubscribeButton plan="pro" chain="solana:devnet" />
        </MesubProvider>,
    );
    let login!: Promise<unknown>;
    act(() => {
        login = state.login();
    });
    const modal = await screen.findByRole('dialog');
    fireEvent.change(within(modal).getByLabelText('Email'), {
        target: { value: 'ada@example.com' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Send me a code' }));
    fireEvent.change(await within(modal).findByLabelText('6-digit code'), {
        target: { value: '123456' },
    });
    await act(async () => {
        await login;
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await within(await screen.findByRole('dialog')).findByRole('button', {
        name: /Subscribe and pay/,
    });
    return { fetch, state: () => state };
}

const dialog = () => screen.getByRole('dialog');
const account = () => dialog().querySelector('[data-mesub-account]')!;
const accountWallet = () => account().querySelector('[data-mesub-account-wallet]')!;
const change = () => within(dialog()).getByRole('button', { name: 'Change' });
const menu = () => dialog().querySelector('[data-mesub-wallet-menu]');
const linked = () => Array.from(dialog().querySelectorAll('[data-mesub-linked]'));
const linkedButton = (name: RegExp) => within(menu() as HTMLElement).getByRole('button', { name });
const paysFrom = () =>
    Array.from(dialog().querySelectorAll('[data-mesub-row]'))
        .find((row) => row.querySelector('dt')!.textContent === 'Pays from')!
        .querySelector('dd')!.textContent;

async function openMenu() {
    fireEvent.click(change());
    await waitFor(() => expect(linked().length).toBeGreaterThan(0));
}

afterEach(() => unregisterWallets());

describe('the account row', () => {
    it('says who is signed in and which wallet pays, before the merchant', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await review();

        expect(account().querySelector('p')!.textContent).toBe('Signed in as ada@example.com');
        expect(accountWallet().textContent).toBe('Wa11…1111');
        expect(accountWallet().getAttribute('title')).toBe(W1);
        expect(accountWallet().querySelector('img')).not.toBeNull();
        expect(change().getAttribute('aria-expanded')).toBe('false');
        expect(account().nextElementSibling?.hasAttribute('data-mesub-merchant')).toBe(true);
        // Lazy: nothing listed until Change.
        expect(calls(fetch, 'GET /auth/wallets')).toHaveLength(0);
    });

    it('shows no icon when no installed wallet holds the address', async () => {
        registerWallet({ name: 'Phantom', address: W3, connected: true });
        await review();

        expect(accountWallet().querySelector('img')).toBeNull();
    });
});

describe('the wallet menu', () => {
    it('lists the wallets with the access token, the paying one checked, and its plans', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await review(holding(['Pro', 'Team']));

        await openMenu();

        expect(bearerOf(fetch, 'GET /auth/wallets')).toBe(`Bearer ${walletToken(W1)}`);
        expect(change().getAttribute('aria-expanded')).toBe('true');
        expect(change().getAttribute('aria-controls')).toBe(menu()!.id);
        expect(linked().map((item) => item.textContent)).toEqual(['Wa11…1111Pro, Team', 'Ledger']);
        expect(linked().map((item) => item.getAttribute('aria-current'))).toEqual(['true', null]);
        expect(linked()[0]!.querySelector('small')!.textContent).toBe('Pro, Team');
        expect(linked()[1]!.querySelector('small')).toBeNull();
        expect(
            within(menu() as HTMLElement).getByRole('button', { name: 'Connect another wallet' }),
        ).toBeTruthy();
    });

    it('closes on Change again, and reads the list again on the next opening', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await review();
        await openMenu();

        fireEvent.click(change());
        expect(menu()).toBeNull();
        expect(change().getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(change());

        await openMenu();
        expect(calls(fetch, 'GET /auth/wallets')).toHaveLength(2);
    });

    it('closes without a call when the paying wallet is picked', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch } = await review(holding(['Pro']));
        await openMenu();

        fireEvent.click(linkedButton(/Wa11/));

        expect(menu()).toBeNull();
        expect(calls(fetch, 'POST /auth/wallet/select')).toHaveLength(0);
    });

    it('says when the list cannot be read, and still offers another wallet', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(free, { 'GET /auth/wallets': () => json(503, { message: 'Mesub is down.' }) });

        fireEvent.click(change());

        expect(await within(menu() as HTMLElement).findByRole('alert')).toHaveProperty(
            'textContent',
            'Mesub is down.',
        );
        expect(linked()).toHaveLength(0);
        expect(
            within(menu() as HTMLElement).getByRole('button', { name: 'Connect another wallet' }),
        ).toBeTruthy();
    });
});

describe('picking a linked wallet', () => {
    it('switches at once when the paying wallet holds no plan here, and signs nothing', async () => {
        const phantom = registerWallet({ name: 'Phantom', connected: true });
        const ledger = registerWallet({ name: 'Ledger', address: W2, connected: true });
        const { fetch, state } = await review();
        await openMenu();

        fireEvent.click(linkedButton(/Ledger/));

        await waitFor(() => expect(menu()).toBeNull());
        expect(bodyOf(fetch, 'POST /auth/wallet/select')).toEqual({ address: W2 });
        expect(bearerOf(fetch, 'POST /auth/wallet/select')).toBe(`Bearer ${walletToken(W1)}`);
        expect(state().wallet).toBe(W2);
        expect(accountWallet().textContent).toBe('Ledger');
        expect(paysFrom()).toBe('Ledg…2222');
        expect(document.activeElement).toBe(change());
        for (const fake of [phantom, ledger]) {
            expect(fake.signMessage).not.toHaveBeenCalled();
            expect(fake.disconnect).not.toHaveBeenCalled();
        }
    });

    it('then pays from the new wallet, with its access token', async () => {
        const phantom = registerWallet({ name: 'Phantom', connected: true });
        const ledger = registerWallet({ name: 'Ledger', address: W2, connected: true });
        const { fetch } = await review();
        await openMenu();
        fireEvent.click(linkedButton(/Ledger/));
        await waitFor(() => expect(paysFrom()).toBe('Ledg…2222'));

        fireEvent.click(within(dialog()).getByRole('button', { name: /Subscribe and pay/ }));

        await waitFor(() => expect(dialog().getAttribute('data-mesub-step')).toBe('subscribed'));
        expect(bearerOf(fetch, 'POST /subscriptions')).toBe(`Bearer ${walletToken(W2)}`);
        expect(ledger.signAndSendTransaction).toHaveBeenCalledOnce();
        expect(phantom.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it('warns first when the paying wallet holds a plan here', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch, state } = await review(holding(['Pro']));
        await openMenu();

        fireEvent.click(linkedButton(/Ledger/));

        expect(within(menu() as HTMLElement).getByRole('alert').textContent).toBe(
            'Your Pro subscription will not be recognised on this site with the new wallet.',
        );
        expect(calls(fetch, 'POST /auth/wallet/select')).toHaveLength(0);
        expect(state().wallet).toBe(W1);
    });

    it('names every plan held, in the plural', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(holding(['Pro', 'Team', 'Max']));
        await openMenu();

        fireEvent.click(linkedButton(/Ledger/));

        expect(dialog().querySelector('[data-mesub-warning]')!.textContent).toBe(
            'Your Pro, Team and Max subscriptions will not be recognised on this site with the new wallet.',
        );
    });

    it('keeps the wallet when the warning is declined', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch, state } = await review(holding(['Pro']));
        await openMenu();
        fireEvent.click(linkedButton(/Ledger/));

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Keep Wa11…1111' }));

        expect(dialog().querySelector('[data-mesub-warning]')).toBeNull();
        expect(menu()).not.toBeNull();
        expect(calls(fetch, 'POST /auth/wallet/select')).toHaveLength(0);
        expect(state().wallet).toBe(W1);
    });

    it('switches once the warning is confirmed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch, state } = await review(holding(['Pro']));
        await openMenu();
        fireEvent.click(linkedButton(/Ledger/));

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Switch anyway' }));

        await waitFor(() => expect(state().wallet).toBe(W2));
        expect(calls(fetch, 'POST /auth/wallet/select')).toHaveLength(1);
        expect(menu()).toBeNull();
    });

    it('shows a 404 in the menu, keeps the wallet, and reads the list again', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch, state } = await review(free, {
            'POST /auth/wallet/select': () =>
                json(404, { message: 'That wallet is not linked to your account.' }),
        });
        await openMenu();

        fireEvent.click(linkedButton(/Ledger/));

        expect(await within(menu() as HTMLElement).findByRole('alert')).toHaveProperty(
            'textContent',
            'That wallet is not linked to your account.',
        );
        expect(state().wallet).toBe(W1);
        expect(paysFrom()).toBe('Wa11…1111');
        await waitFor(() => expect(calls(fetch, 'GET /auth/wallets')).toHaveLength(2));
    });

    it('holds every choice while one switches', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        let answer!: (response: Response) => void;
        await review(free, {
            'POST /auth/wallet/select': () =>
                new Promise<Response>((resolve) => {
                    answer = resolve;
                }),
        });
        await openMenu();

        fireEvent.click(linkedButton(/Ledger/));

        await waitFor(() => expect(linked()[1]!.getAttribute('aria-busy')).toBe('true'));
        expect(linked().every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
        expect(
            (
                within(menu() as HTMLElement).getByRole('button', {
                    name: 'Connect another wallet',
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        await act(async () => answer(json(201, { user, accessToken: walletToken(W2) })));
        await waitFor(() => expect(menu()).toBeNull());
    });
});

describe('connecting another wallet', () => {
    async function toList(wallets: MesubWallet[] = free, overrides: Record<string, Handler> = {}) {
        const result = await review(wallets, overrides);
        await openMenu();
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect another wallet' }));
        await within(dialog()).findByRole('heading', { name: 'Connect another wallet' });
        return result;
    }

    it("shows the installed wallets, on the review's step", async () => {
        registerWallet({ name: 'Phantom', connected: true });
        registerWallet({ name: 'Solflare', address: W3 });
        await toList();

        expect(dialog().getAttribute('data-mesub-step')).toBe('review');
        const names = Array.from(dialog().querySelectorAll('[data-mesub-wallet]')).map((button) =>
            button.getAttribute('data-mesub-wallet'),
        );
        expect(names).toEqual(['Phantom', 'Solflare']);
    });

    it('signs the challenge, links the wallet, then pays from it on the review', async () => {
        const phantom = registerWallet({ name: 'Phantom', connected: true });
        const solflare = registerWallet({ name: 'Solflare', address: W3 });
        const { fetch, state } = await toList();

        fireEvent.click(within(dialog()).getByRole('button', { name: /Solflare/ }));

        await within(dialog()).findByRole('button', { name: /Subscribe and pay/ });
        expect(solflare.connect).toHaveBeenCalledOnce();
        expect(bodyOf(fetch, 'POST /auth/wallets/challenge')).toEqual({ address: W3 });
        expect(bearerOf(fetch, 'POST /auth/wallets/challenge')).toBe(`Bearer ${walletToken(W1)}`);
        const [input] = solflare.signMessage.mock.calls[0]!;
        expect(new TextDecoder().decode(input!.message)).toBe(`Link ${W3} to Mesub`);
        expect(bodyOf(fetch, 'POST /auth/wallets')).toEqual({
            address: W3,
            signature: getBase58Decoder().decode(solflare.signature),
        });
        expect(bearerOf(fetch, 'POST /auth/wallets')).toBe(`Bearer ${walletToken(W1)}`);
        expect(state().wallet).toBe(W3);
        expect(paysFrom()).toBe('So1f…3333');
        // The list is read again for the new wallet's label and plans.
        await waitFor(() => expect(calls(fetch, 'GET /auth/wallets')).toHaveLength(2));
        for (const fake of [phantom, solflare]) expect(fake.disconnect).not.toHaveBeenCalled();
    });

    it('warns before leaving a wallet that holds a plan here', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(holding(['Pro']));
        await openMenu();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect another wallet' }));
        expect(dialog().querySelector('[data-mesub-warning]')!.textContent).toBe(
            'Your Pro subscription will not be recognised on this site with the new wallet.',
        );
        expect(
            within(dialog()).queryByRole('heading', { name: 'Connect another wallet' }),
        ).toBeNull();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Switch anyway' }));
        await within(dialog()).findByRole('heading', { name: 'Connect another wallet' });
    });

    it('goes back to the review, wallet unchanged, from the list', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const { fetch, state } = await toList();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));

        await within(dialog()).findByRole('button', { name: /Subscribe and pay/ });
        expect(state().wallet).toBe(W1);
        expect(calls(fetch, 'POST /auth/wallets/challenge')).toHaveLength(0);
    });

    it('shows the refusal when the wallet will not sign, and links nothing', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const solflare = registerWallet({ name: 'Solflare', address: W3 });
        solflare.signMessage.mockRejectedValueOnce(new Error('User rejected the request.'));
        const { fetch, state } = await toList();

        fireEvent.click(within(dialog()).getByRole('button', { name: /Solflare/ }));

        await within(dialog()).findByRole('heading', { name: 'Request rejected' });
        expect(within(dialog()).getByRole('alert').textContent).toBe(
            'Solflare said: User rejected the request.',
        );
        expect(calls(fetch, 'POST /auth/wallets')).toHaveLength(0);
        expect(state().wallet).toBe(W1);
        expect(solflare.disconnect).not.toHaveBeenCalled();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Use another wallet' }));
        await within(dialog()).findByRole('heading', { name: 'Connect another wallet' });
    });

    it('shows the refusal when the wallet will not connect', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const solflare = registerWallet({ name: 'Solflare', address: W3 });
        solflare.connect.mockRejectedValueOnce(new Error('Locked.'));
        const { fetch } = await toList();

        fireEvent.click(within(dialog()).getByRole('button', { name: /Solflare/ }));

        await within(dialog()).findByRole('heading', { name: 'Request rejected' });
        expect(within(dialog()).getByRole('alert').textContent).toBe('Solflare said: Locked.');
        expect(calls(fetch, 'POST /auth/wallets/challenge')).toHaveLength(0);
    });

    it('says when the wallet is on another account (409), and keeps the paying one', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        const solflare = registerWallet({ name: 'Solflare', address: W3 });
        const { state } = await toList(free, {
            'POST /auth/wallets': () =>
                json(409, { message: 'That wallet is already attached to another account.' }),
        });

        fireEvent.click(within(dialog()).getByRole('button', { name: /Solflare/ }));

        await within(dialog()).findByRole('heading', { name: 'Wallet already in use' });
        expect(within(dialog()).getByRole('alert').textContent).toBe(
            'That wallet is already attached to another account.',
        );
        expect(state().wallet).toBe(W1);
        expect(solflare.disconnect).not.toHaveBeenCalled();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Use another wallet' }));
        fireEvent.click(await within(dialog()).findByRole('button', { name: 'Back' }));
        await within(dialog()).findByRole('button', { name: /Subscribe and pay/ });
        expect(paysFrom()).toBe('Wa11…1111');
    });

    it('offers to try again when the API fails otherwise', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        registerWallet({ name: 'Solflare', address: W3 });
        let failing = true;
        const { state } = await toList(free, {
            'POST /auth/wallets/challenge': (body) =>
                failing
                    ? json(503, { message: 'Mesub is down.' })
                    : json(201, { message: `Link ${body!.address as string} to Mesub` }),
        });

        fireEvent.click(within(dialog()).getByRole('button', { name: /Solflare/ }));
        await within(dialog()).findByRole('heading', { name: 'Could not connect' });
        failing = false;
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));

        await within(dialog()).findByRole('button', { name: /Subscribe and pay/ });
        expect(state().wallet).toBe(W3);
    });

    it('links to wallets to install when none is, and Back returns to the review', async () => {
        await review();
        await openMenu();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Connect another wallet' }));

        await within(dialog()).findByRole('heading', { name: 'No Solana wallet found' });
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));
        await within(dialog()).findByRole('button', { name: /Subscribe and pay/ });
    });
});
