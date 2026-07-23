# Changelog
## [Unreleased]
### Changed
- Migrated from the `reticulum-js` package to the split `@reticulum/core` and
  `@reticulum/node` packages
- Fixed a `ReferenceError` (`rns` → `this.rns`) when falling back from the
  shared Reticulum interface to `AutoInterface`/TCP

## [0.3.0] - 2026-07-18
### Changed
- Updated to reticulum-js 0.3.0
## [0.2.0] - 2026-07-18
### Added
- Enabled using shared Reticulum interface for the client
## [0.1.0] - 2026-07-18
### Added
- Initial version
