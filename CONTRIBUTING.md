# Contributing

1. Install Pi and clone the repository.
2. Run the extension directly with `pi -e ./index.ts`.
3. Create a temporary parent directory, copy the checkout into `<tmp>/repo`, install test-only dependencies in `<tmp>`, then run `<tmp>/node_modules/.bin/tsx --test test/*.test.ts` and `<tmp>/node_modules/.bin/tsc -p tsconfig.json` from `<tmp>/repo`.
4. Do not add test runners or Pi host packages to the root package's dependencies or devDependencies.
5. Keep root-agent prompt injection minimal and user-facing completion messages compact.
6. Do not weaken permission forwarding or expose child sessions in Pi's normal resume directory.
