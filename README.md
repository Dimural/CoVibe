# CoVibes

Real-time collaborative coding inside VS Code, with AI-agent awareness.

**Status: pre-alpha, under active development.**

---

## Repository Structure

This is a pnpm monorepo. The following packages are being built out:

```
packages/
  protocol/     Shared types and message schema for the relay protocol
  relay/        WebSocket relay server
  extension/    VS Code extension (publisher client)
e2e/            End-to-end tests
```

---

## License

MIT. See [LICENSE](./LICENSE).
