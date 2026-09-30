import { createApiClient, REQUEST_TIMEOUT_MS } from '../src/api';
import { MesubClientError } from '../src/errors';
import { json, mockFetch, user } from './helpers';

const clientSession = { user, sessionToken: 'st_1', refreshToken: 'rt_1', accessToken: null };

function call(fetch: ReturnType<typeof mockFetch>, index = 0) {
    const [url, init] = fetch.mock.calls[index]!;
    return {
        url,
        init,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as unknown,
    };
}

describe('createApiClient', () => {
    it('defaults to https://api.mesub.io', async () => {
        const fetch = mockFetch();
        await createApiClient({ publishableKey: 'PUB_1', fetch }).sendCode('ada@example.com');

        expect(call(fetch).url).toBe('https://api.mesub.io/v1/client/auth/code');
    });

    it('drops trailing slashes from apiUrl', async () => {
        const fetch = mockFetch();
        await createApiClient({
            publishableKey: 'PUB_1',
            apiUrl: 'http://localhost:3000//',
            fetch,
        }).sendCode('ada@example.com');

        expect(call(fetch).url).toBe('http://localhost:3000/v1/client/auth/code');
    });

    it('sends the key, JSON and no cookies on every request', async () => {
        const fetch = mockFetch();
        await createApiClient({ publishableKey: 'PUB_1', fetch }).sendCode('ada@example.com');

        const { init, headers } = call(fetch);
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('omit');
        expect(headers).toEqual({ 'X-Mesub-Key': 'PUB_1', 'Content-Type': 'application/json' });
    });

    it('uses globalThis.fetch when none is given', async () => {
        const fetch = mockFetch();
        vi.stubGlobal('fetch', fetch);
        try {
            await createApiClient({ publishableKey: 'PUB_1' }).sendCode('ada@example.com');
        } finally {
            vi.unstubAllGlobals();
        }

        expect(fetch).toHaveBeenCalledOnce();
    });

    it('sendCode posts the email and handles 204 with no body', async () => {
        const fetch = mockFetch(() => json(204));
        const result = await createApiClient({ publishableKey: 'PUB_1', fetch }).sendCode(
            'ada@example.com',
        );

        expect(result).toBeUndefined();
        expect(call(fetch).body).toEqual({ email: 'ada@example.com' });
    });

    it('createSession posts email and code and returns the session', async () => {
        const fetch = mockFetch(() => json(201, clientSession));
        const result = await createApiClient({ publishableKey: 'PUB_1', fetch }).createSession(
            'ada@example.com',
            '123456',
        );

        expect(result).toEqual(clientSession);
        expect(call(fetch).url).toBe('https://api.mesub.io/v1/client/auth/session');
        expect(call(fetch).body).toEqual({ email: 'ada@example.com', code: '123456' });
        expect(call(fetch).headers).not.toHaveProperty('Authorization');
    });

    it('walletChallenge sends the session token as bearer', async () => {
        const fetch = mockFetch(() => json(201, { message: 'sign me' }));
        const result = await createApiClient({ publishableKey: 'PUB_1', fetch }).walletChallenge(
            'st_1',
            'Wa11et',
        );

        expect(result).toEqual({ message: 'sign me' });
        expect(call(fetch).url).toBe('https://api.mesub.io/v1/client/auth/wallet/challenge');
        expect(call(fetch).headers.Authorization).toBe('Bearer st_1');
        expect(call(fetch).body).toEqual({ address: 'Wa11et' });
    });

    it('proveWallet sends address, signature and label with the bearer', async () => {
        const fetch = mockFetch(() => json(201, { user, accessToken: 'at_1' }));
        const result = await createApiClient({ publishableKey: 'PUB_1', fetch }).proveWallet(
            'st_1',
            { address: 'Wa11et', signature: 'SiG', label: 'Phantom' },
        );

        expect(result).toEqual({ user, accessToken: 'at_1' });
        expect(call(fetch).url).toBe('https://api.mesub.io/v1/client/auth/wallet');
        expect(call(fetch).headers.Authorization).toBe('Bearer st_1');
        expect(call(fetch).body).toEqual({ address: 'Wa11et', signature: 'SiG', label: 'Phantom' });
    });

    it('refresh posts the refresh token and returns the new session', async () => {
        const fetch = mockFetch(() => json(201, { ...clientSession, refreshToken: 'rt_2' }));
        const result = await createApiClient({ publishableKey: 'PUB_1', fetch }).refresh('rt_1');

        expect(result.refreshToken).toBe('rt_2');
        expect(call(fetch).url).toBe('https://api.mesub.io/v1/client/auth/refresh');
        expect(call(fetch).body).toEqual({ refreshToken: 'rt_1' });
    });

    it('logout posts the refresh token', async () => {
        const fetch = mockFetch(() => json(204));
        await createApiClient({ publishableKey: 'PUB_1', fetch }).logout('rt_1');

        expect(call(fetch).url).toBe('https://api.mesub.io/v1/client/auth/logout');
        expect(call(fetch).body).toEqual({ refreshToken: 'rt_1' });
    });
});

describe('API errors', () => {
    async function failure(response: () => Response | Promise<Response>) {
        const fetch = mockFetch(response);
        return createApiClient({ publishableKey: 'PUB_1', fetch })
            .sendCode('ada@example.com')
            .then(
                () => expect.fail('should have thrown'),
                (error: unknown) => error as MesubClientError,
            );
    }

    it('joins an array message on 400', async () => {
        const error = await failure(() =>
            json(400, {
                message: ['email must be an email', 'email should not be empty'],
                error: 'Bad Request',
                statusCode: 400,
            }),
        );

        expect(error).toBeInstanceOf(MesubClientError);
        expect(error.status).toBe(400);
        expect(error.message).toBe('email must be an email; email should not be empty');
    });

    it.each([
        [401, 'Unknown publishable key', 'Unauthorized'],
        [403, 'Origin not allowed', 'Forbidden'],
        [409, 'Wallet belongs to another account', 'Conflict'],
        [429, 'ThrottlerException: Too Many Requests', 'Too Many Requests'],
    ])('keeps the status and message on %i', async (status, message, name) => {
        const error = await failure(() =>
            json(status, { message, error: name, statusCode: status }),
        );

        expect(error).toBeInstanceOf(MesubClientError);
        expect(error.status).toBe(status);
        expect(error.message).toBe(message);
    });

    it('falls back to the status when the body is not JSON', async () => {
        const error = await failure(() => new Response('Bad Gateway', { status: 502 }));

        expect(error.status).toBe(502);
        expect(error.message).toBe('Mesub API answered 502');
    });

    it('has status null on a network failure', async () => {
        const error = await failure(() => Promise.reject(new TypeError('Failed to fetch')));

        expect(error).toBeInstanceOf(MesubClientError);
        expect(error.name).toBe('MesubClientError');
        expect(error.status).toBeNull();
        expect(error.cause).toBeInstanceOf(TypeError);
    });
});

describe('timeouts', () => {
    const MESSAGE = 'Mesub did not answer within 15 seconds';

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function client(response: (init: RequestInit) => Promise<Response>) {
        const fetch = vi.fn((_input: string, init: RequestInit) => response(init));
        const api = createApiClient({ publishableKey: 'PUB_1', fetch });
        const signal = () => fetch.mock.calls[0]![1].signal!;
        return { api, fetch, signal };
    }

    /** Settles `promise` into a result, so a rejection is never unhandled. */
    function outcome<T>(promise: Promise<T>) {
        const result: { value?: T; error?: MesubClientError; done: boolean } = { done: false };
        void promise.then(
            (value) => Object.assign(result, { value, done: true }),
            (error: MesubClientError) => Object.assign(result, { error, done: true }),
        );
        return result;
    }

    const never = () => new Promise<never>(() => undefined);

    it('is 15 seconds', () => {
        expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    });

    it('rejects a request that never answers after 15 seconds, with status null', async () => {
        const { api, signal } = client(never);
        const result = outcome(api.sendCode('ada@example.com'));

        await vi.advanceTimersByTimeAsync(14_999);
        expect(result.done).toBe(false);
        expect(signal().aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(result.error).toBeInstanceOf(MesubClientError);
        expect(result.error!.status).toBeNull();
        expect(result.error!.message).toBe(MESSAGE);
        expect(result.error!.cause).toBeInstanceOf(DOMException);
        expect((result.error!.cause as DOMException).name).toBe('TimeoutError');
        expect(signal().aborted).toBe(true);
        expect(signal().reason).toBe(result.error!.cause);
    });

    it('times out, not "Could not reach", when fetch rejects on the abort', async () => {
        const { api } = client(
            (init) =>
                new Promise((_, reject) => {
                    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
                }),
        );
        const result = outcome(api.sendCode('ada@example.com'));

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(result.error!.message).toBe(MESSAGE);
        expect(result.error!.status).toBeNull();
    });

    it('succeeds when the answer comes at 14.9 seconds', async () => {
        const { api, signal } = client(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve(json(201, { message: 'm' })), 14_900),
                ),
        );
        const result = outcome(api.walletChallenge('st_1', 'Wa11et'));

        await vi.advanceTimersByTimeAsync(14_900);
        expect(result.value).toEqual({ message: 'm' });

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(signal().aborted).toBe(false);
    });

    it.each([
        ['a success', () => json(201, { message: 'm' })],
        ['a 204', () => json(204)],
        ['an HTTP error', () => json(409, { message: 'Conflict' })],
    ])('clears its timer after %s, leaving no late abort', async (_, response) => {
        const { api, signal } = client(() => Promise.resolve(response()));
        const result = outcome(api.walletChallenge('st_1', 'Wa11et'));

        await vi.advanceTimersByTimeAsync(0);
        expect(result.done).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(signal().aborted).toBe(false);
        expect(result.error?.message ?? null).not.toBe(MESSAGE);
    });

    it('clears its timer after a network failure', async () => {
        const { api } = client(() => Promise.reject(new TypeError('Failed to fetch')));
        const result = outcome(api.sendCode('ada@example.com'));

        await vi.advanceTimersByTimeAsync(0);
        expect(result.error!.message).toBe('Could not reach the Mesub API');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        ['a success', true, 201],
        ['an error', false, 500],
    ])('times out a body that never ends, on %s', async (_, ok, status) => {
        const hung = { ok, status, json: never } as unknown as Response;
        const { api } = client(() => Promise.resolve(hung));
        const result = outcome(api.walletChallenge('st_1', 'Wa11et'));

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
        expect(result.done).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(result.error!.message).toBe(MESSAGE);
        expect(result.error!.status).toBeNull();
    });

    it('times each request on its own', async () => {
        let calls = 0;
        const { api } = client(() => (calls++ === 0 ? never() : Promise.resolve(json(204))));
        const first = outcome(api.sendCode('ada@example.com'));

        await vi.advanceTimersByTimeAsync(10_000);
        const second = outcome(api.sendCode('ada@example.com'));
        await vi.advanceTimersByTimeAsync(0);
        expect(second.done).toBe(true);
        expect(second.error).toBeUndefined();

        await vi.advanceTimersByTimeAsync(5_000);
        expect(first.error!.message).toBe(MESSAGE);
    });
});
