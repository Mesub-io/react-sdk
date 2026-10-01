/**
 * A merchant's server, for the playground only: one route behind
 * `requirePlan` from `@mesub/node`, which is what the access token is for.
 *
 * `@mesub/node` is not on npm yet, so it is loaded from the local node-sdk
 * build (MESUB_NODE_SDK, default ../node-sdk next to this repo), along with
 * the Express that repo already installs.
 *
 *   pnpm playground:server
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdk = resolve(
    process.env.MESUB_NODE_SDK ?? new URL('../../node-sdk', import.meta.url).pathname,
);
const express = createRequire(`${sdk}/package.json`)('express');
const { Mesub } = await import(pathToFileURL(`${sdk}/dist/index.js`).href);
const { requirePlan } = await import(pathToFileURL(`${sdk}/dist/express.js`).href);

const apiKey = process.env.MESUB_API_KEY;
const apiUrl = process.env.VITE_MESUB_API_URL ?? 'http://localhost:3333';
const plan = process.env.VITE_MESUB_PLAN ?? 'pro';
const port = Number(process.env.PLAYGROUND_SERVER_PORT ?? 5174);

if (!apiKey) {
    console.error(
        'Set MESUB_API_KEY=SUB_... in playground/.env.local: the API key of the project.',
    );
    process.exit(1);
}

const mesub = new Mesub({ apiKey, baseUrl: apiUrl });
const app = express();

// The page runs on :5173, this server on :5174: a cross-origin call.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

app.get('/api/reports', requirePlan(plan, { client: mesub }), (req, res) => {
    const { wallet, answer, stale } = res.locals.mesub;

    res.json({ message: `Welcome, subscriber of ${plan}.`, wallet, status: answer?.status, stale });
});

// What any error the SDK hands to next(err) looks like: a broken integration.
app.use((error, req, res, _next) => {
    res.status(500).json({ error: error.code ?? 'unexpected', message: error.message });
});

app.listen(port, () => {
    console.log(
        `Test server on http://localhost:${port}, GET /api/reports needs the plan ${plan}.`,
    );
});
