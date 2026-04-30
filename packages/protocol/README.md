# @covibes/protocol

Shared wire-protocol types and primitives consumed by the relay server and the VS Code extension.

## PROTOCOL_VERSION

The package exports `PROTOCOL_VERSION`, an integer constant that tracks breaking changes to the message envelope, message types, or session join/state semantics.

Clients **MUST** reject envelopes whose `v` field does not equal `PROTOCOL_VERSION`. On any breaking change, increment this constant.

## Exports

- `./version` — `PROTOCOL_VERSION` and `ProtocolVersion`
- `./envelope` — Wire envelope type
- `./messages` — Message type definitions
- `./session` — Session-related types
