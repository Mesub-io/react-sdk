// @vitest-environment node
// Reads package.json from disk: no browser here.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The package's shape, without building. `scripts/check-exports.mjs` checks the build. */
describe('package.json', () => {
    it('is published as @mesub/react', () => {
        expect(pkg.name).toBe('@mesub/react');
    });

    it('serves one entry to import and require, with types, and the stylesheet', () => {
        expect(Object.keys(pkg.exports)).toEqual(['.', './styles.css', './package.json']);
        expect(pkg.exports['./styles.css']).toBe('./styles.css');
        expect(pkg.exports['.'].import.types).toMatch(/\.d\.ts$/);
        expect(pkg.exports['.'].require.default).toMatch(/\.cjs$/);
    });

    // Two Reacts in one page break hooks: React is always the merchant's own.
    it('takes React as a peer, never as a dependency', () => {
        expect(pkg.dependencies ?? {}).not.toHaveProperty('react');
        expect(pkg.dependencies ?? {}).not.toHaveProperty('react-dom');
        expect(pkg.peerDependencies).toMatchObject({ react: '>=18', 'react-dom': '>=18' });
    });

    // Browser code the merchant never installs: the modal's wallet stack.
    it('depends on the Wallet Standard and @solana/kit', () => {
        expect(Object.keys(pkg.dependencies)).toEqual(['@solana/kit', '@wallet-standard/react']);
    });

    it('ships the build and the stylesheet, nothing else', () => {
        expect(pkg.files).toEqual(['dist', 'styles.css']);
    });

    // false would let a bundler drop `import '@mesub/react/styles.css'`.
    it('keeps CSS imports as side effects', () => {
        expect(pkg.sideEffects).toEqual(['*.css']);
    });
});
