import { createApi } from '../src/api';
import { MesubClientError } from '../src/errors';
import { json, plan, prepared, refusal, subscription } from './helpers';

function client(response: () => Response | Promise<Response>, endpoint = '/api/mesub') {
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(response()));
    return { api: createApi({ endpoint, fetch }), fetch };
}

/** The one request made: its url and what it was sent with. */
function sent(fetch: ReturnType<typeof client>['fetch']) {
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    return {
        url,
        method: init.method,
        credentials: init.credentials,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    };
}

describe('the requests, as the routes of @mesub/node expect them', () => {
    it('reads a plan', async () => {
        const { api, fetch } = client(() => json(200, plan));

        await expect(api.plan('pro')).resolves.toEqual(plan);
        expect(sent(fetch)).toEqual({
            url: '/api/mesub/plans/pro',
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
            body: undefined,
        });
    });

    it("reads the customer's subscriptions", async () => {
        const { api, fetch } = client(() => json(200, { subscriptions: [subscription()] }));

        await expect(api.subscriptions()).resolves.toEqual([subscription()]);
        expect(sent(fetch)).toMatchObject({
            url: '/api/mesub/subscriptions',
            method: 'GET',
            credentials: 'include',
            body: undefined,
        });
    });

    it('prepares a subscription with the plan and the wallet', async () => {
        const answer = prepared();
        const { api, fetch } = client(() => json(201, answer));

        await expect(api.prepare('pro', 'Wa11et')).resolves.toEqual(answer);
        expect(sent(fetch)).toEqual({
            url: '/api/mesub/subscriptions',
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: { plan: 'pro', wallet: 'Wa11et' },
        });
    });

    it('submits the signed transaction and the terms signature', async () => {
        const { api, fetch } = client(() => json(201, { subscription: subscription() }));

        await api.submit('sub_1', { transaction: 'c2lnbmVk', terms_signature: 'sig58' });
        expect(sent(fetch)).toMatchObject({
            url: '/api/mesub/subscriptions/sub_1/submit',
            method: 'POST',
            credentials: 'include',
            body: { transaction: 'c2lnbmVk', terms_signature: 'sig58' },
        });
    });

    it.each(['cancel', 'resume', 'close'] as const)(
        'builds a %s as a JSON POST with nothing to say',
        async (action) => {
            const { api, fetch } = client(() =>
                json(201, { transaction: 'dHg=', last_valid_block_height: '9' }),
            );

            await expect(api.build(action, 'sub_1')).resolves.toEqual({
                transaction: 'dHg=',
                last_valid_block_height: '9',
            });
            // The routes answer 415 to a POST that is not JSON.
            expect(sent(fetch)).toEqual({
                url: `/api/mesub/subscriptions/sub_1/${action}`,
                method: 'POST',
                credentials: 'include',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: {},
            });
        },
    );

    it.each(['cancel', 'resume', 'close'] as const)(
        'confirms a %s with the signature',
        async (action) => {
            const { api, fetch } = client(() => json(201, { subscription: subscription() }));

            await api.confirm(action, 'sub_1', 'sig58');
            expect(sent(fetch)).toMatchObject({
                url: `/api/mesub/subscriptions/sub_1/${action}/confirm`,
                method: 'POST',
                credentials: 'include',
                body: { signature: 'sig58' },
            });
        },
    );

    it('takes an absolute endpoint, and one written with a trailing slash', async () => {
        const { api, fetch } = client(() => json(200, plan), 'https://shop.test/api/mesub/');

        await api.plan('pro');
        expect(sent(fetch).url).toBe('https://shop.test/api/mesub/plans/pro');
    });

    it('never lets an id rewrite the path', async () => {
        const { api, fetch } = client(() => json(201, { transaction: 'dHg=' }));

        await api.build('cancel', '../plans/pro');
        expect(sent(fetch).url).toBe('/api/mesub/subscriptions/..%2Fplans%2Fpro/cancel');
    });

    it('uses the global fetch when none is given', async () => {
        const fetch = vi.fn(async () => json(200, plan));
        vi.stubGlobal('fetch', fetch);
        try {
            await createApi({ endpoint: '/api/mesub' }).plan('pro');
            expect(fetch).toHaveBeenCalledWith(
                '/api/mesub/plans/pro',
                expect.objectContaining({ credentials: 'include' }),
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('what goes wrong', () => {
    it("throws the route's refusal with its status, code and message", async () => {
        const { api } = client(() =>
            refusal(409, 'already_subscribed', 'This wallet already holds this plan.'),
        );

        const error = await api.prepare('pro', 'Wa11et').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MesubClientError);
        expect(error).toMatchObject({
            status: 409,
            code: 'already_subscribed',
            message: 'This wallet already holds this plan.',
        });
    });

    it('reads Retry-After on a 429', async () => {
        const { api } = client(() =>
            refusal(429, 'rate_limited', 'Too many requests.', { 'Retry-After': '30' }),
        );

        await expect(api.subscriptions()).rejects.toMatchObject({ status: 429, retryAfter: 30 });
    });

    it('falls back on the status when the refusal is not JSON', async () => {
        const { api } = client(() => new Response('<html>', { status: 502 }));

        await expect(api.plan('pro')).rejects.toMatchObject({
            status: 502,
            code: null,
            message: 'The server answered 502.',
        });
    });

    it('refuses a page served where the routes should be', async () => {
        const { api } = client(() => new Response('<!doctype html>', { status: 200 }));

        await expect(api.plan('pro')).rejects.toMatchObject({
            status: 200,
            code: 'bad_response',
        });
    });

    it('says the network failed, with no status', async () => {
        const fetch = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });
        const api = createApi({ endpoint: '/api/mesub', fetch });

        await expect(api.plan('pro')).rejects.toMatchObject({
            status: null,
            code: 'network',
            message: 'Could not reach the server.',
        });
    });

    it('answers an empty list when the server names none', async () => {
        const { api } = client(() => json(200, {}));

        await expect(api.subscriptions()).resolves.toEqual([]);
    });
});

describe('timeouts', () => {
    const hang = () => new Promise<Response>(() => undefined);

    async function timesOutAt(call: (api: ReturnType<typeof createApi>) => Promise<unknown>) {
        vi.useFakeTimers();
        const fetch = vi.fn((_url: string, _init: RequestInit) => hang());
        const settled = vi.fn();
        call(createApi({ endpoint: '/api/mesub', fetch })).catch(settled);
        return {
            fetch,
            settled,
            pass: (ms: number) => vi.advanceTimersByTimeAsync(ms),
        };
    }

    it.each([
        ['plan', (api: ReturnType<typeof createApi>) => api.plan('pro')],
        ['subscriptions', (api: ReturnType<typeof createApi>) => api.subscriptions()],
        ['prepare', (api: ReturnType<typeof createApi>) => api.prepare('pro', 'Wa11et')],
        ['build', (api: ReturnType<typeof createApi>) => api.build('cancel', 'sub_1')],
    ])('gives a read or a build 15 seconds: %s', async (_name, call) => {
        const { fetch, settled, pass } = await timesOutAt(call);

        await pass(14_999);
        expect(settled).not.toHaveBeenCalled();
        await pass(1);
        expect(settled).toHaveBeenCalledWith(
            expect.objectContaining({
                status: null,
                code: 'timeout',
                message: 'No answer within 15 seconds.',
            }),
        );
        // The request is dropped, not left running.
        expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    });

    it.each([
        [
            'submit',
            (api: ReturnType<typeof createApi>) =>
                api.submit('sub_1', { transaction: 'dHg=', terms_signature: 'sig' }),
        ],
        ['confirm', (api: ReturnType<typeof createApi>) => api.confirm('cancel', 'sub_1', 'sig')],
    ])('gives the chain 90 seconds: %s', async (_name, call) => {
        const { settled, pass } = await timesOutAt(call);

        await pass(89_999);
        expect(settled).not.toHaveBeenCalled();
        await pass(1);
        expect(settled).toHaveBeenCalledWith(
            expect.objectContaining({
                status: null,
                code: 'timeout',
                message: 'No answer within 90 seconds.',
            }),
        );
    });

    it('times out a fetch that ignores the signal, and a body that never ends', async () => {
        vi.useFakeTimers();
        const body = new Response(null, { status: 200 });
        vi.spyOn(body, 'json').mockReturnValue(new Promise(() => undefined));
        const api = createApi({ endpoint: '/api/mesub', fetch: async () => body });
        const settled = vi.fn();
        api.plan('pro').catch(settled);

        await vi.advanceTimersByTimeAsync(15_000);
        expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: 'timeout' }));
    });
});
