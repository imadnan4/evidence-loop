# R03 — Identity and access

- **Date:** 2026-07-18
- **Status:** Proposed, conditional on procurement
- **Owner:** Identity/security research agent; approval owner: security/IAM + institution

## Recommendation
Use **Clerk** provisionally for synthetic staging email-link sign-in, with future institutional federation through a separately approved custom OIDC/SAML connection. API authorization remains Evidence Loop's own organization/course/membership/object checks; an identity-provider role or email alone is never sufficient.

Account linking is explicit and audited: do not merge magic-link and Google/Microsoft/federated identities merely because email strings match. Require verified ownership plus approved tenant/issuer/domain/claims and a recovery/review path. Treat social Google/Microsoft login as distinct from institution tenant verification.

## Primary sources
- [Clerk email links](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options)
- [Clerk Enterprise SSO](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview)
- [Clerk account linking](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/account-linking)
- [Auth0 OIDC enterprise connections](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers/oidc)
- [Firebase generic OIDC](https://firebase.google.com/docs/auth/web/openid-connect)

## Rejected/deferred
Auth0 is deferred because its documented magic-link flow has Classic Login/same-browser constraints; Firebase/Identity Platform is deferred unless the institution already standardizes on GCP. Clerk EASIE multi-tenant federation is not approved for an institution without tenant-crossover assessment. Password auth is out of scope.

## Security and cost impact
Use short-lived sessions, CSRF protection, rate limits, default-deny RBAC, audit actor IDs, and no client-supplied role/tenant trust. Enterprise plan pricing, DPA, and support entitlements are unverified; do not purchase or claim availability.

## Acceptance checks
1. Cross-tenant/course/object access matrix rejects every unauthorized read/write.
2. Email-link, link/merge, IdP issuer/tenant/claim, deprovisioning, and session-revocation tests pass.
3. Admin MFA and least-privilege support access are configured before non-synthetic use.
4. Identity-provider and application audit records correlate without raw tokens.

## Dependencies and unresolved owner decisions
Depends on R00/R04. IAM and institution must select provider/plan, approved IdP connections, enrollment source, account-linking policy, recovery path, MFA rules, and pilot account type.
