import { createApiClient } from '../src/api';
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
