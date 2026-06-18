## Summary

Describe the behavior change and why it belongs in the data-channel-first
milestone.

## Verification

Check commands that were run, and mark unrelated items as not applicable in the
PR body.

- [ ] `npm run check`
- [ ] `npm run native:check`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run api:check`
- [ ] `npm run types:check`
- [ ] `npm run e2e:chrome`
- [ ] `npm run wpt:selection:check`
- [ ] `npm run wpt:smoke`
- [ ] `npm run wpt:smoke:check`
- [ ] `npm run wpt:test` / `npm run wpt:check:strict`

## WPT impact

State whether this changes `wpt-manifest.json`, selected WPT results, or
`docs/divergences.md`.

## Browser interoperability

State whether Chrome E2E behavior or coverage changes.

## Notes

Mention any libdatachannel pin, WPT pin, native lifetime, or callback-threading
impact. For workflow or release changes, describe permission and publication
impact.
