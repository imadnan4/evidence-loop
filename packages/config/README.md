# Shared configuration

`tsconfig.base.json` is the workspace TypeScript baseline. Packages may extend it but must not weaken `strict`, `noUncheckedIndexedAccess`, or `exactOptionalPropertyTypes`.

Runtime validation remains mandatory at API boundaries; TypeScript types alone do not authorize input or prove provenance.
