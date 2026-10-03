/**
 * A merchant's server, for the playground only. It holds the API key and
 * mounts the routes of `@mesub/node` the widget calls, behind a login of its
 * own: the browser never talks to Mesub.
 *
 * `@mesub/node` is not on npm yet, so it is loaded from a local build:
 * MESUB_NODE_SDK, or ../node-sdk next to this repo, along with the Express
 * that repo already installs.
 *
 *   pnpm playground:server
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function stop(message) {
    console.error(message);
    process.exit(1);
}

const sdk = resolve(
    process.env.MESUB_NODE_SDK ?? fileURLToPath(new URL('../../node-sdk', import.meta.url)),
);
const entry = `${sdk}/dist/express.js`;

if (!existsSync(entry)) {
    stop(
        `No build of @mesub/node at ${sdk}.\n` +
            'Clone Mesub-io/node-sdk next to this repo, or set MESUB_NODE_SDK to its folder, ' +
            'then run `pnpm install && pnpm build` there.',
    );
}

const express = createRequire(`${sdk}/package.json`)('express');
const { Mesub } = await import(pathToFileURL(`${sdk}/dist/index.js`).href);
const { mesubRoutes, requirePlan } = await import(pathToFileURL(entry).href);

if (typeof mesubRoutes !== 'function') {
    stop(
        `The @mesub/node build at ${sdk} has no mesubRoutes: the widget's routes.\n` +
            'They come with Mesub-io/node-sdk#86: check that branch out (or a later main), ' +
            'then run `pnpm build` there.',
    );
}

const apiKey = process.env.MESUB_API_KEY;
const apiUrl =
    process.env.MESUB_API_URL ?? process.env.VITE_MESUB_API_URL ?? 'http://localhost:3333';
const plan = process.env.VITE_MESUB_PLAN ?? 'pro';
const port = Number(process.env.PLAYGROUND_SERVER_PORT ?? 5174);

if (!apiKey) {
    stop('Set MESUB_API_KEY=SUB_... in playground/.env.local: the API key of the project.');
}

const mesub = new Mesub({ apiKey, baseUrl: apiUrl });
const app = express();

/**
 * The site's own login, reduced to a cookie anybody can write: fine to try
 * the widget, never on a real site, where this is your verified session.
 */
const COOKIE = 'playground-user';

function userOf(req) {
    const cookie = (req.headers.cookie ?? '')
        .split('; ')
        .find((entry) => entry.startsWith(`${COOKIE}=`));
    if (!cookie) return null;
    try {
        const { id, email } = JSON.parse(decodeURIComponent(cookie.slice(COOKIE.length + 1)));
        return typeof id === 'string' && id !== '' ? { id, email: email || null } : null;
    } catch {
        return null;
    }
}

app.get('/api/me', (req, res) => {
    res.json({ user: userOf(req) });
});

app.post('/api/login', express.json(), (req, res) => {
    const id = String(req.body?.id ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    if (!id) return res.status(400).json({ error: 'An id is needed.' });

    const value = encodeURIComponent(JSON.stringify({ id, email }));
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ user: { id, email: email || null } });
});

app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ user: null });
});

// The one line a merchant adds: everything the widget calls is under it.
app.use(
    '/api/mesub',
    mesubRoutes({
        client: mesub,
        customer: (req) => {
            const user = userOf(req);
            return user ? { external_id: user.id } : null;
        },
        email: (req) => userOf(req)?.email,
    }),
);

// What the subscription is for: a route only a subscriber of the plan gets.
app.get(
    '/api/reports',
    requirePlan(plan, {
        client: mesub,
        customer: (req) => {
            const user = userOf(req);
            return user ? { external_id: user.id } : null;
        },
    }),
    (req, res) => {
        const { wallet, answer, stale } = res.locals.mesub;

        res.json({
            message: `Welcome, subscriber of ${plan}.`,
            wallet,
            status: answer?.status,
            stale,
        });
    },
);

// What any error the SDK hands to next(err) looks like: a broken integration.
app.use((error, req, res, _next) => {
    res.status(500).json({ error: { code: error.code ?? 'unexpected', message: error.message } });
});

app.listen(port, () => {
    console.log(
        `Merchant server on http://localhost:${port}: the widget's routes under /api/mesub, ` +
            `and GET /api/reports for subscribers of ${plan}. Mesub at ${apiUrl}.`,
    );
});
