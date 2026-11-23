# Third-party code notice

Parts of Draftmeter are copied or adapted from third-party software licensed under the
GNU General Public License v3 (see `../../LICENSE`):

- `src/zwift/zwift.mjs` (lines 1–2363) and `src/zwift/zwift.proto`, plus the map data in
  `src/zwift/data/`: from Sauce for Zwift 2.3.4, © Sauce, LLC. `zwift.proto` is itself based on
  zwift-offline's protocol definitions.
- `src/vendor/curves.mjs` and `src/vendor/routes.mjs`: from the same project, unmodified.
- The rider-on-route placement in `src/terrain.mjs` is adapted from the same project.

Modifications in Draftmeter: the local game-control server was removed from `zwift.mjs`, and
`src/zwift/env.mjs` is a slim replacement for the original.
