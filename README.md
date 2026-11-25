# Norcaster plugins for Claude Code

This repository is the Claude Code marketplace for **Norcaster Companion**, which routes Claude Code through your organization's Norcaster gateway, part of the Norcaster AI Runtime Control Plane.

```bash
claude plugin marketplace add norcaster/claude-plugin
```

```bash
claude plugin install norcaster@norcaster
```

What the plugin does, what it changes on your machine, what it sends and how to undo it: [plugin/README.md](plugin/README.md).

## Layout

| Path | What it is |
|---|---|
| `plugin/` | The plugin itself |
| `.claude-plugin/marketplace.json` | The marketplace that lists it |
| `test/` | Tests (`node --test test/*.test.mjs`, Node 18 or later, no dependencies) |
| `.github/workflows/ci.yml` | Runs the syntax check and the tests on Linux and macOS |

Questions: [support@norcaster.com](mailto:support@norcaster.com). Security reports: [security@norcaster.com](mailto:security@norcaster.com). Licensed under MIT.
