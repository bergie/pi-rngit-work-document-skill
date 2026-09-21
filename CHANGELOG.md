# Changelog
## [Unreleased]

## [0.6.2] - 2026-09-22
### Fixed
- Migrated identity recall to the reticulum-js 0.9.0 API
  (`rns.transport.recallIdentity`). The `Destination.recall` static removed in
  `@reticulum/core` 0.9.0 made every `connect()` fail with a `TypeError`, so no
  work-document operations could be sent at all
### Added
- Test coverage for the identity-recall path, including a contract guard that
  fails if a future `@reticulum/core` bump removes `transport.recallIdentity`

## [0.6.1] - 2026-09-21

## [0.6.0] - 2026-09-20
### Changed
- Updated `@reticulum/core` and `@reticulum/node` from 0.6.0 to 0.8.2
## [0.5.0] - 2026-08-18
### Removed
- Removed fallback to TCP client interface. Now we only use shared instance and AutoInterface, except if RNS_HOST and RNS_PORT env vars are set
## [0.4.0] - 2026-07-23
### Added
- Now using Reticulum AutoInterface by default
### Changed
- Migrated from the `reticulum-js` package to the split `@reticulum/core` and
  `@reticulum/node` packages
## [0.3.0] - 2026-07-18
### Changed
- Updated to reticulum-js 0.3.0
## [0.2.0] - 2026-07-18
### Added
- Enabled using shared Reticulum interface for the client
## [0.1.0] - 2026-07-18
### Added
- Initial version
