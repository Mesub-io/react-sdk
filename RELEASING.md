# Releasing `@mesub/react`

A release is a version tag on main. `.github/workflows/publish.yml` checks the
tag, runs every check, waits for a reviewer of the `npm` environment, then
publishes to npm with provenance. Nobody runs `npm publish` from a laptop.

It works as `@mesub/node` releases
([its RELEASING.md](https://github.com/Mesub-io/node-sdk/blob/main/RELEASING.md)),
with one more thing to keep: which `@mesub/node` the widget works with.

## Once, before the first release

Done by an owner of the npm scope and an admin of Mesub-io (kurosaki-sol).
None of it lives in this repository, so a branch cannot undo it.

### npm

1. **The `@mesub` scope.** It is shared with `@mesub/node`: if the `mesub`
   organization was set up for its first release, there is nothing to do
   here. Otherwise, sign in on npmjs.com, open
   `https://www.npmjs.com/org/mesub`: create the `mesub` organization if it
   is free (free plan, public packages), or find out who holds it if not.
   Both co-founders as owners, two-factor authentication on both accounts.
2. **The first publish.** npm lets a trusted publisher be set only on a
   package that exists, and `@mesub/react` is its own package: the trusted
   publisher of `@mesub/node` does not cover it. If npmjs.com still says so
   when you get there:
    - create a granular access token: "Read and write (publish and stage)",
      `@mesub` scope with all its packages, "Bypass two-factor
      authentication" ticked (a run cannot type a code: without it npm
      answers 403), the shortest expiry offered;
    - store it as the secret `NPM_TOKEN` of the `npm` environment of
      Mesub-io/react-sdk (below), not as a repository secret;
    - release 0.1.0 as described further down: the workflow publishes with
      that token, provenance included;
    - npm only stages a version sent with such a token: on npmjs.com, the
      package's staged version, approve it with your two-factor code. Until
      then `latest` is a `0.0.0-stage` placeholder with nothing in it;
      deprecate it after (`npm deprecate @mesub/react@0.0.0-stage "..."`);
    - delete the token on npmjs.com and the secret on GitHub straight after.

    A 404 on the publish means the token cannot write to `@mesub` (wrong
    scope, or "select packages" while the package does not exist yet).

3. **The trusted publisher.** On npmjs.com, `@mesub/react`, Settings, Trusted
   Publisher, GitHub Actions: organization `Mesub-io`, repository
   `react-sdk`, workflow `publish.yml`, environment `npm`. Every publish
   after that goes through OIDC, with no token anywhere.
4. **No tokens from then on.** Same page, Publishing access: "Require
   two-factor authentication and disallow tokens".

### GitHub, in Mesub-io/react-sdk settings

Each repository has its own: what was done for node-sdk does not carry over.

5. **The `npm` environment.** Settings, Environments, New environment, `npm`:
    - Required reviewers: kurosaki-sol (and whoever else may release). Leave
      "Prevent self-review" off while the team is two people, or a release
      tagged by the only reviewer could never be approved;
    - Deployment branches and tags: selected, tag pattern `v*`.
6. **Who may tag.** Settings, Rules, Rulesets, New tag ruleset: target
   `v*`, restrict creations, updates and deletions, bypass list
   Repository admin only. A tag is what starts a release; this keeps the
   approval from being the only gate.

## Compatibility with `@mesub/node`

The widget never talks to Mesub: it calls the routes `@mesub/node` mounts on
the merchant's server (`mesubRoutes`, `mesubRouteHandlers`). The rule:

**`@mesub/react` 0.x works with the routes of `@mesub/node` of the same
minor: 0.1.x with 0.1.x.**

- A release that needs a route, a field or a code that the routes of the
  current `@mesub/node` minor do not serve waits for that `@mesub/node`
  release, then moves to its minor: release both, `@mesub/node` first.
- A release that reads something new only when it is there, and behaves as
  before without it (as the widget does with `/transaction`, `closable` or
  `payments`), stays in the minor.
- A new `@mesub/node` minor that changes what a route answers ships with a
  `@mesub/react` of the same minor, even when nothing changed here but the
  version.

Say it in both changelogs, and in the README's Requirements here.

## Each release

1. **Changelog.** In `CHANGELOG.md`, title the section with the version and
   the date, `## 0.2.0 (2026-11-03)`. Under 1.0, a minor version may break the
   API, a patch never does. Name the `@mesub/node` it works with when that
   changes.
2. **Version.** Set it in `package.json`. The first release ships 0.1.0,
   already set: nothing to bump.
3. **Compatibility.** Against the routes of the `@mesub/node` it names: the
   playground (`pnpm playground:server` and `pnpm playground`) runs a
   subscribe, a cancel, a resume and a close on devnet.
4. **Merge.** Through a pull request, CI green.
5. **Tag** main at the merge, once the release is agreed:

    ```sh
    git fetch origin
    git tag -a v0.2.0 origin/main -m v0.2.0
    git push origin v0.2.0
    ```

    The tag must be `v` and the exact version: the workflow refuses anything
    else, and a tag on a commit that is not on main. `v0.2.0-rc.1` publishes
    under the `next` dist-tag, never `latest`.

6. **Approve.** Actions, the Publish run, Review deployments, `npm`: the
   reviewer reads what the run is about to publish, then approves.
7. **Check** what reached npm:

    ```sh
    npm view @mesub/react version dist-tags
    npm audit signatures   # in a project that installed it: provenance verified
    ```

    The package page on npmjs.com shows the provenance, linking this commit
    and run.

8. **GitHub release.** From the tag, the changelog section as its notes.

## When it goes wrong

- **The run stopped before publishing** (a check failed, the tag was wrong):
  delete the tag (`git push origin :v0.2.0`), fix on main, tag again.
- **A bad version reached npm.** Never unpublish: publish a fixed patch, then
  `npm deprecate @mesub/react@0.2.0 "Use 0.2.1: <why>"`.
