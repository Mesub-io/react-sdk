import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ManageButton, ManageSubscriptions, MesubProvider, SubscribeButton } from '../src';
import { paidIn } from '../src/detail-logic';
import {
    aboutUsd,
    formatAmount,
    formatUsd,
    grouped,
    priceOf,
    termsFacts,
    tokenOf,
    unverifiedNote,
} from '../src/format';
import type { MesubPlan } from '../src/types';
import {
    checkout,
    ENDPOINT,
    json,
    plan as usdc,
    prepared,
    server,
    subscription,
    type Handler,
} from './helpers';
import { registerWallet } from './wallets';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const LOGO = 'https://img.test/bonk.png';
const HOUR = { period_hours: 1, network: 'mainnet-beta' as const };

/** 30,000 of a token Mesub does not vouch for, every hour, as an older server serves it. */
const older: MesubPlan = {
    ...usdc,
    ...HOUR,
    amount: '3000000000',
    amount_display: '30000',
    decimals: 5,
    symbol: null,
    mint: MINT,
};
/** The same plan from a server that knows the token: verified, with its image and its dollars. */
const bonk: MesubPlan = {
    ...older,
    token: { symbol: 'Bonk', name: 'Bonk', logo_url: LOGO, verified: true },
    amount_usd: '0.1',
};
const unverified: MesubPlan = {
    ...older,
    token: { symbol: 'FAKE', name: 'Fake Coin', logo_url: LOGO, verified: false },
    amount_usd: '0.1',
};
const stable: MesubPlan = {
    ...usdc,
    ...HOUR,
    amount: '1000000',
    amount_display: '1',
    token: {
        symbol: 'USDC',
        name: 'USD Coin',
        logo_url: 'https://img.test/usdc.png',
        verified: true,
    },
    amount_usd: '1',
};

/** The terms as Mesub writes them: a token it does not vouch for is "tokens", then its mint. */
const terms = (amount: string, token: string) =>
    [
        'Mesub: the terms of the subscription you are about to sign.',
        `Amount: ${amount} every hour`,
        `First charge: ${amount} now, in the transaction you sign next`,
        `Then: ${amount} every hour, until you cancel`,
        'Subscription: Pro, from Fraise',
        `Token: ${token}`,
        'Nonce: 42',
    ].join('\n');
const TOKENS = terms('30000 tokens', `mint ${MINT}`);
const DOLLARS = terms('1 USDC', `USDC, mint ${usdc.mint}`);

const logo = (within_: Element) =>
    within_.querySelector<HTMLImageElement>('[data-mesub-token-logo]');
const text = (within_: Element, selector: string) =>
    within_.querySelector(selector)?.textContent ?? null;

function mountCheckout(plan: MesubPlan, message: string) {
    const answer = { ...prepared(), terms: { ...prepared().terms, message } };
    const fetch = server(
        checkout({
            'GET /plans/pro': () => json(200, plan),
            'POST /subscriptions': () => json(201, answer),
            'POST /subscriptions/sub_1/submit': () => json(201, { subscription: subscription() }),
        }),
    );
    const wallet = registerWallet({});
    render(
        <MesubProvider endpoint={ENDPOINT} chain="solana:mainnet" fetch={fetch}>
            <SubscribeButton plan="pro" />
        </MesubProvider>,
    );
    return wallet;
}

async function toPlan() {
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Continue with a wallet' });
    return dialog;
}

async function toReview(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with a wallet' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Fake Wallet' }));
    return within(dialog).findByRole('button', { name: /^Sign and pay / });
}

async function toDone(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole('button', { name: /^Sign and pay / }));
    await within(dialog).findByRole('heading', { name: 'You are subscribed' });
}

const rows = (list: Element) =>
    [...list.querySelectorAll('[data-mesub-row]')].map((each) => [
        each.querySelector('dt')?.textContent,
        each.querySelector('dd')?.textContent,
    ]);
const termsRows = (dialog: HTMLElement) => rows(dialog.querySelector('[data-mesub-terms]')!);
const paidToday = (dialog: HTMLElement) =>
    rows(dialog).find(([label]) => label === 'Paid today')?.[1];

describe('one way to write an amount', () => {
    it('groups thousands the same way everywhere, and leaves the fraction alone', () => {
        expect(grouped('30000')).toBe('30,000');
        expect(grouped('1')).toBe('1');
        expect(grouped('999')).toBe('999');
        expect(grouped('1000')).toBe('1,000');
        expect(grouped('1234567.000001')).toBe('1,234,567.000001');
        expect(grouped('0.12345')).toBe('0.12345');
        // Not a number: left as written.
        expect(grouped('n/a')).toBe('n/a');
    });

    it("takes the token's symbol, else the vouched one, else the short mint", () => {
        expect(priceOf(bonk)).toBe('30,000 Bonk');
        expect(priceOf(stable)).toBe('1 USDC');
        expect(priceOf({ ...stable, token: undefined })).toBe('1 USDC');
        expect(priceOf(older)).toBe('30,000 DezX…B263');
        expect(priceOf({ ...older, token: null })).toBe('30,000 DezX…B263');
        expect(priceOf({ ...bonk, token: { ...bonk.token!, symbol: null } })).toBe(
            '30,000 DezX…B263',
        );
    });

    it('groups an amount counted from base units', () => {
        expect(paidIn('9000000000', bonk, formatAmount)).toBe('90,000 Bonk');
        expect(paidIn('9000000000', older, formatAmount)).toBe('90,000');
        expect(paidIn('1234000000', stable, formatAmount)).toBe('1,234 USDC');
    });
});

describe('dollars', () => {
    it('keeps small values meaningful and separates large ones', () => {
        expect(formatUsd('0.1')).toBe('$0.10');
        expect(formatUsd('0.01')).toBe('$0.01');
        expect(formatUsd('0.004')).toBe('less than $0.01');
        expect(formatUsd('0.00000012')).toBe('less than $0.01');
        expect(formatUsd('5')).toBe('$5.00');
        expect(formatUsd('1234567.891')).toBe('$1,234,567.89');
    });

    it('says nothing of a value it cannot read', () => {
        for (const value of [null, undefined, '', 'abc', '-1', '1e3', '$5', ' 5']) {
            expect(formatUsd(value)).toBeNull();
        }
        expect(formatUsd(5 as unknown as string)).toBeNull();
    });

    it('calls an estimate an estimate', () => {
        expect(aboutUsd('0.1')).toBe('about $0.10');
        expect(aboutUsd('12345')).toBe('about $12,345.00');
        expect(aboutUsd('0.0001')).toBe('less than $0.01');
        expect(aboutUsd(null)).toBeNull();
    });
});

describe('what a token says of itself', () => {
    it('shows an image only for a verified token, over https', () => {
        expect(tokenOf(bonk).logo).toBe(LOGO);
        expect(tokenOf(unverified).logo).toBeNull();
        expect(tokenOf(older).logo).toBeNull();
        for (const logo_url of [
            'http://img.test/a.png',
            'javascript:alert(1)',
            'data:image/png;base64,AAAA',
            '/a.png',
            '',
            null,
        ]) {
            expect(tokenOf({ ...bonk, token: { ...bonk.token!, logo_url } }).logo).toBeNull();
        }
    });

    it('calls a token unverified only when Mesub says so', () => {
        expect(unverifiedNote(unverified)).toBe('Unverified token: Fake Coin, mint DezX…B263');
        expect(unverifiedNote({ ...unverified, token: { ...unverified.token!, name: null } })).toBe(
            'Unverified token, mint DezX…B263',
        );
        expect(unverifiedNote(bonk)).toBeNull();
        expect(unverifiedNote(stable)).toBeNull();
        expect(unverifiedNote(older)).toBeNull();
        // A vouched mint is verified, whatever else is said.
        expect(
            unverifiedNote({ ...stable, token: { ...stable.token!, verified: false } }),
        ).toBeNull();
    });

    it('never lets an unverified token read as a vouched stablecoin', () => {
        const fake = {
            ...unverified,
            token: { ...unverified.token!, symbol: ' usdc ', name: 'USDT' },
        };

        expect(priceOf(fake)).toBe('30,000 DezX…B263');
        expect(unverifiedNote(fake)).toBe('Unverified token, mint DezX…B263');
    });

    it('cuts a long symbol short and drops what cannot be read', () => {
        const hostile = (symbol: string, name: string | null = null) =>
            tokenOf({ ...unverified, token: { ...unverified.token!, symbol, name } });

        expect(hostile('<img src=x onerror=alert(1)>').unit).toBe('<img src=x o…');
        expect(hostile('A'.repeat(500)).unit).toBe(`${'A'.repeat(12)}…`);
        expect(hostile('US‮DC\n\tX').unit).toBe('US DC X');
        expect(hostile('​ \n').unit).toBe('DezX…B263');
        expect(hostile('OK', 'N'.repeat(80)).name).toBe(`${'N'.repeat(32)}…`);
        // A token that is not an object at all is no token.
        expect(tokenOf({ ...older, token: 'Bonk' as never }).unit).toBe('DezX…B263');
    });
});

describe('the terms summary', () => {
    const fact = (plan: MesubPlan, message: string) =>
        Object.fromEntries(termsFacts(message, plan).map((each) => [each.label, each]));

    it('writes the amounts as the screen does, and keeps what is signed in `full`', () => {
        const facts = fact(bonk, TOKENS);

        expect(facts['First charge']?.value).toBe('30,000 Bonk now');
        expect(facts['First charge']?.full).toBe(
            'First charge: 30000 tokens now, in the transaction you sign next'.slice(14),
        );
        expect(facts['Then']?.value).toBe('30,000 Bonk every hour, until you cancel');
        expect(facts['Then']?.full).toBe('30000 tokens every hour, until you cancel');
        expect(facts['Token']?.value).toBe('Bonk, mint DezX…B263');
        expect(facts['Token']?.note).toBeUndefined();
    });

    it('leaves another number alone', () => {
        const facts = fact(
            { ...bonk, amount_display: '30' },
            terms('30 tokens', `mint ${MINT}`).replace(
                'until you cancel',
                'for 130 tokens, 30.5 tokens',
            ),
        );

        expect(facts['Then']?.value).toBe('30 Bonk every hour, for 130 tokens, 30.5 tokens');
    });

    it('is the same without the plan', () => {
        expect(termsFacts(TOKENS).find((each) => each.label === 'First charge')?.value).toBe(
            '30000 tokens now',
        );
    });
});

describe('the checkout, screen by screen', () => {
    it('a vouched stablecoin: its symbol and image, no dollars beside it', async () => {
        mountCheckout(stable, DOLLARS);
        const dialog = await toPlan();

        expect(text(dialog, '[data-mesub-price]')).toBe('1 USDCevery hour');
        expect(logo(dialog)?.getAttribute('src')).toBe('https://img.test/usdc.png');
        expect(dialog.querySelector('[data-mesub-usd]')).toBeNull();
        expect(dialog.querySelector('[data-mesub-unverified]')).toBeNull();

        expect((await toReview(dialog)).textContent).toBe('Sign and pay 1 USDC');
        expect(text(dialog, '[data-mesub-price]')).toBe('1 USDCevery hour');
        expect(termsRows(dialog)).toEqual([
            ['First charge', '1 USDC now'],
            ['Then', '1 USDC every hour, until you cancel'],
            ['Subscription', 'Pro, from Fraise'],
            ['Token', 'USDC'],
        ]);

        await toDone(dialog);
        expect(within(dialog).getByText('Pro, 1 USDC every hour')).toBeTruthy();
        expect(paidToday(dialog)).toBe('1 USDC');
    });

    it('a verified coin: its symbol, its image and what it is worth', async () => {
        const wallet = mountCheckout(bonk, TOKENS);
        const dialog = await toPlan();

        expect(text(dialog, '[data-mesub-price] strong')).toBe('30,000 Bonk');
        expect(text(dialog, '[data-mesub-usd]')).toBe('about $0.10 every hour');
        expect(dialog.querySelector('[data-mesub-unverified]')).toBeNull();

        const image = logo(dialog)!;
        expect(image.getAttribute('src')).toBe(LOGO);
        expect(image.getAttribute('alt')).toBe('');
        expect(image.getAttribute('loading')).toBe('lazy');
        expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
        // A fixed box, before anything loads.
        expect(image.getAttribute('width')).toBe('20');
        expect(image.getAttribute('height')).toBe('20');
        expect(image.closest('[data-mesub-price] strong')).toBeTruthy();

        expect((await toReview(dialog)).textContent).toBe('Sign and pay 30,000 Bonk');
        expect(text(dialog, '[data-mesub-price]')).toBe(
            '30,000 Bonkevery hourabout $0.10 every hour',
        );
        expect(logo(dialog)).toBeTruthy();
        expect(termsRows(dialog)).toEqual([
            ['First charge', '30,000 Bonk now'],
            ['Then', '30,000 Bonk every hour, until you cancel'],
            ['Subscription', 'Pro, from Fraise'],
            ['Token', 'Bonk, mint DezX…B263'],
        ]);

        await toDone(dialog);
        expect(within(dialog).getByText('Pro, 30,000 Bonk every hour')).toBeTruthy();
        expect(paidToday(dialog)).toBe('30,000 Bonkabout $0.10');
        // What the wallet signed is the server's message, to the letter.
        expect(wallet.signMessage.mock.calls[0]![0]).toEqual({
            account: wallet.account,
            message: new TextEncoder().encode(TOKENS),
        });
    });

    it('takes a broken image out, on the screen it broke on and the next', async () => {
        mountCheckout(bonk, TOKENS);
        const dialog = await toPlan();

        fireEvent.error(logo(dialog)!);
        expect(dialog.querySelector('img[data-mesub-token-logo]')).toBeNull();
        expect(text(dialog, '[data-mesub-price] strong')).toBe('30,000 Bonk');

        await toReview(dialog);
        fireEvent.error(logo(dialog)!);
        expect(logo(dialog)).toBeNull();
        expect(text(dialog, '[data-mesub-price] strong')).toBe('30,000 Bonk');
    });

    it('an unverified token: said so, with its mint, and no image', async () => {
        mountCheckout(unverified, TOKENS);
        const dialog = await toPlan();

        expect(text(dialog, '[data-mesub-price] strong')).toBe('30,000 FAKE');
        expect(text(dialog, '[data-mesub-unverified]')).toBe(
            'Unverified token: Fake Coin, mint DezX…B263',
        );
        expect(dialog.querySelector('[data-mesub-unverified]')?.getAttribute('title')).toBe(MINT);
        expect(text(dialog, '[data-mesub-usd]')).toBe('about $0.10 every hour');
        expect(logo(dialog)).toBeNull();

        expect((await toReview(dialog)).textContent).toBe('Sign and pay 30,000 FAKE');
        expect(text(dialog, '[data-mesub-unverified]')).toBe(
            'Unverified token: Fake Coin, mint DezX…B263',
        );
        expect(logo(dialog)).toBeNull();
        expect(termsRows(dialog)).toEqual([
            ['First charge', '30,000 FAKE now'],
            ['Then', '30,000 FAKE every hour, until you cancel'],
            ['Subscription', 'Pro, from Fraise'],
            ['Token', 'FAKE, mint DezX…B263 Unverified token'],
        ]);

        await toDone(dialog);
        expect(paidToday(dialog)).toBe('30,000 FAKEabout $0.10');
    });

    it('a hostile symbol: text, cut short, never markup', async () => {
        const symbol = `<img src=x onerror="window.pwned=1"><b>${'W'.repeat(300)}`;
        mountCheckout(
            {
                ...unverified,
                token: { ...unverified.token!, symbol, name: '<script>alert(1)</script>' },
            },
            TOKENS,
        );
        const dialog = await toPlan();

        expect(text(dialog, '[data-mesub-price] strong')).toBe('30,000 <img src=x o…');
        expect(text(dialog, '[data-mesub-unverified]')).toBe(
            'Unverified token: <script>alert(1)</script>, mint DezX…B263',
        );
        expect(dialog.querySelector('[data-mesub-price] :is(img, b, script)')).toBeNull();
        expect(dialog.querySelector('script')).toBeNull();

        expect((await toReview(dialog)).textContent).toBe('Sign and pay 30,000 <img src=x o…');
        expect(dialog.querySelector('[data-mesub-terms] :is(img, b, script)')).toBeNull();
        expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    });

    it('an older server: as before, with the separator', async () => {
        mountCheckout(older, TOKENS);
        const dialog = await toPlan();

        expect(text(dialog, '[data-mesub-price]')).toBe('30,000 DezX…B263every hour');
        expect(dialog.querySelector('[data-mesub-price]')?.children).toHaveLength(2);
        expect(logo(dialog)).toBeNull();

        expect((await toReview(dialog)).textContent).toBe('Sign and pay 30,000 DezX…B263');
        expect(termsRows(dialog)).toEqual([
            ['First charge', '30,000 tokens now'],
            ['Then', '30,000 tokens every hour, until you cancel'],
            ['Subscription', 'Pro, from Fraise'],
            ['Token', 'mint DezX…B263'],
        ]);

        await toDone(dialog);
        expect(within(dialog).getByText('Pro, 30,000 DezX…B263 every hour')).toBeTruthy();
        expect(paidToday(dialog)).toBe('30,000 DezX…B263');
    });

    it('says a tiny dollar value in words', async () => {
        mountCheckout({ ...bonk, amount_usd: '0.0004' }, TOKENS);
        const dialog = await toPlan();
        expect(text(dialog, '[data-mesub-usd]')).toBe('less than $0.01 every hour');
    });

    it('separates a large dollar value', async () => {
        mountCheckout({ ...bonk, amount_usd: '1234567.5' }, TOKENS);
        const dialog = await toPlan();
        expect(text(dialog, '[data-mesub-usd]')).toBe('about $1,234,567.50 every hour');
    });

    it('says nothing of a price nobody knows', async () => {
        mountCheckout({ ...bonk, amount_usd: null }, TOKENS);
        const dialog = await toPlan();
        expect(dialog.querySelector('[data-mesub-usd]')).toBeNull();
        expect(text(dialog, '[data-mesub-price]')).toBe('30,000 Bonkevery hour');
    });
});

describe('the subscriptions, listed and opened', () => {
    const SIGNATURE = '5'.repeat(64);
    const charge = (amount_usd?: string | null, outcome = 'paid') => ({
        attempted_at: '2026-10-01T12:00:00.000Z',
        outcome,
        amount: '3000000000',
        reason: null,
        signature: outcome === 'paid' ? SIGNATURE : null,
        ...(amount_usd !== undefined && { amount_usd }),
    });

    function mount(
        plan: MesubPlan,
        payments: unknown[] = [],
        Widget: 'list' | 'button' = 'button',
    ) {
        const handlers: Record<string, Handler> = {
            'GET /plans/pro': () => json(200, plan),
            'GET /subscriptions': () => json(200, { subscriptions: [subscription()] }),
            'GET /subscriptions/sub_1': () =>
                json(200, {
                    subscription: subscription(),
                    upcoming: [
                        {
                            kind: 'charge',
                            due_at: '2999-10-04T12:00:00.000Z',
                            amount: plan.amount,
                            amount_display: plan.amount_display,
                        },
                    ],
                    payments,
                    paid: { count: 3, amount: '9000000000' },
                }),
        };
        registerWallet({ connected: true });
        render(
            <MesubProvider endpoint={ENDPOINT} fetch={server(handlers)}>
                {Widget === 'list' ? <ManageSubscriptions /> : <ManageButton plan="pro" />}
            </MesubProvider>,
        );
    }

    async function open() {
        fireEvent.click(screen.getByRole('button', { name: 'Manage subscription' }));
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(dialog.querySelector('[data-mesub-payment]')).toBeTruthy());
        return dialog;
    }

    const amounts = (dialog: HTMLElement) =>
        [...dialog.querySelectorAll('[data-mesub-payment] > span:last-child')].map(
            (each) => each.textContent,
        );

    async function listed() {
        await screen.findByRole('list', { name: 'Your subscriptions' });
        return waitFor(() => {
            const price = document.querySelector<HTMLElement>('[data-mesub-subscription-price]');
            expect(price).toBeTruthy();
            return price!;
        });
    }

    it('lists a verified coin with its image and its symbol', async () => {
        mount(bonk, [], 'list');
        const price = await listed();

        expect(price.textContent).toBe('30,000 Bonk every hour');
        expect(logo(price)?.getAttribute('src')).toBe(LOGO);
        fireEvent.error(logo(price)!);
        expect(logo(price)).toBeNull();
    });

    it('lists an unverified token as text, with no image', async () => {
        mount(unverified, [], 'list');
        const price = await listed();

        expect(price.textContent).toBe('30,000 FAKE every hour');
        expect(logo(price)).toBeNull();
    });

    it('lists a plan from an older server as before, with the separator', async () => {
        mount(older, [], 'list');

        expect((await listed()).textContent).toBe('30,000 DezX…B263 every hour');
    });

    it('opens a verified coin: each payment with what it was worth at the charge', async () => {
        mount(bonk, [
            charge('0.1'),
            charge('0.004'),
            charge('1234.5'),
            charge(null),
            charge('0.09', 'rejected'),
        ]);
        const dialog = await open();

        expect(text(dialog, '[data-mesub-rate]')).toBe('30,000 Bonk every hour');
        expect(logo(dialog.querySelector('[data-mesub-rate]')!)?.getAttribute('src')).toBe(LOGO);
        expect(rows(dialog).find(([label]) => label === 'Total paid')?.[1]).toBe('90,000 Bonk');
        // The price at the charge is a fact: no "about".
        expect(amounts(dialog)).toEqual([
            '30,000 Bonk',
            '30,000 Bonk$0.10',
            '30,000 Bonkless than $0.01',
            '30,000 Bonk$1,234.50',
            '30,000 Bonk',
            '30,000 Bonk$0.09',
        ]);
        // The dollars are beside the receipt link, not in it.
        expect(within(dialog).getAllByRole('link', { name: '30,000 Bonk' })).toHaveLength(4);
    });

    it('opens a stablecoin: no dollars beside dollars', async () => {
        mount(stable, [{ ...charge('1'), amount: '1000000' }]);
        const dialog = await open();

        expect(text(dialog, '[data-mesub-rate]')).toBe('1 USDC every hour');
        expect(amounts(dialog)).toEqual(['1 USDC', '1 USDC']);
    });

    it('opens an unverified token: its symbol as text, no image', async () => {
        mount(unverified, [charge('0.1')]);
        const dialog = await open();

        expect(text(dialog, '[data-mesub-rate]')).toBe('30,000 FAKE every hour');
        expect(logo(dialog)).toBeNull();
        expect(amounts(dialog)).toEqual(['30,000 FAKE', '30,000 FAKE$0.10']);
    });

    it('opens a plan from an older server as before, with the separator', async () => {
        mount(older, [charge()]);
        const dialog = await open();

        expect(text(dialog, '[data-mesub-rate]')).toBe('30,000 DezX…B263 every hour');
        expect(rows(dialog).find(([label]) => label === 'Total paid')?.[1]).toBe('90,000');
        expect(amounts(dialog)).toEqual(['30,000', '30,000']);
        expect(dialog.querySelector('[data-mesub-payment] > span:last-child small')).toBeNull();
    });
});
