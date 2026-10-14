<!-- Open pull requests against main. Keith (the code owner) reviews and approves every change,
and only Keith creates installer-v* release tags. See CONTRIBUTING.md. -->

## Summary

Describe what changed and why. Link the related issue, if any.

## Scope

Parts affected (installer / app / Fabric notebooks and pipeline / Azure infra, jobs or web / core / Power BI models):

Source contracts, optional inputs, install record or deployed item names changed:

## Validation

- [ ] Ran `python -B -m pytest tests -q` and recorded results below.
- [ ] Ran `npm test` (and `npm run typecheck` for the installer) in each changed Node project.
- [ ] Updated directly related documentation and checked changed links.
- [ ] No credentials, tenant exports, prompts or customer names are included.
- [ ] If `.pbit` files changed, documented the rebuild method and Desktop refresh / visual checks.

Results, skipped checks and limitations:

## Compatibility

Describe what happens to existing installs on **Repair or change**, migration steps, and anything
deliberately left unchanged. Note if the Power BI templates in ValueLens need a matching change.