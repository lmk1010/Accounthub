# AccountHub Open Source Checklist

AccountHub is an **independent** project. It is not AIClient and does not share that brand.

## Before making the repository public

1. **Secrets**
   - Rotate any DB/Redis/API keys that ever appeared in git history
   - Confirm no real `.env` values remain in the tree (`git grep -i password`)
   - Prefer a fresh orphan release commit if history still contains dumps/keys

2. **Identity**
   - README, UI, package names, User-Agent all say **AccountHub**
   - No AIClient product branding in user-facing surfaces

3. **Runtime**
   - New installs: `DB_DATABASE=accounthub`, `REDIS_KEY_PREFIX=accounthub:`
   - Existing private deploys may keep legacy names via environment variables

4. **Scope**
   - Public edition focuses on account pools, OAuth, routing, protocol bridge, logs/usage
   - Consider keeping auto-registration / bulk provisioning private or behind explicit flags

5. **Legal**
   - LICENSE (MIT) present
   - SECURITY.md present
   - README disclaimer: provider ToS, trademarks, no bundled accounts

6. **Deploy separation**
   - Production deploys should use server-side env files (never bake secrets into the image)
   - Auto-deploy branches for private production should stay separate from the public release branch
