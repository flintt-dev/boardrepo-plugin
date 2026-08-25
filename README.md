# BoardRepo plugin

BoardRepo connects ChatGPT, Codex, Claude Code, and Claude Cowork to real PCB projects. It combines
BoardRepo's hosted MCP tools with one shared workflow skill for finding boards, reading schematic
connectivity and BOMs, running checks, and reviewing boards a user owns.

The OpenAI package is for the universal Plugins Directory shared by ChatGPT and Codex. The Claude
package complements BoardRepo's existing connector listing by adding the same workflow skill for
Claude Code and Cowork. Both wrappers use the same hosted service and the same skill in this folder.

## Package contents

- `.codex-plugin/plugin.json` contains the ChatGPT and Codex package metadata.
- `.app.json` references BoardRepo's registered OpenAI MCP integration.
- `.claude-plugin/plugin.json` contains the Claude package metadata and hosted MCP connection.
- `skills/boardrepo/SKILL.md` is the shared provider-neutral workflow.
- `assets/` contains BoardRepo's approved light and dark icons.

The package contains no local server, access token, reviewer account, user data, cached analysis, or
analytics. The OpenAI app identifier is public connection metadata, not a credential. Tool access is
authorized by BoardRepo OAuth when a user connects.

## What it can do

The hosted server exposes 15 tools for public-board discovery, board metadata, file and BOM reads,
schematic connectivity, KiCad DRC/ERC, fabrication profiles, structured design queries, and
owner-authorized reviews. Every tool is read-only. Checks and reviews may return a running status,
but no tool edits, deletes, uploads, renames, or publishes a board.

Public boards are available by default. Reading a user's own boards, including private ones, requires
the user to grant that access during BoardRepo authorization.

## How the guidance is split

The server's `initialize` instructions are the authority for safety and review-reporting rules. The
bundled skill supplies the operational workflow: how to find a board, choose the right tool, page
results, run expensive checks carefully, and verify findings. When wording differs, the live server
instructions and tool descriptors win.

## Validate

From the plugin package root:

```bash
claude plugin validate --strict .
```

To load the Claude package for one local session:

```bash
claude --plugin-dir .
```

The release source validates the Codex manifest and registered app mapping against the current plugin
ingestion contract before this package is mirrored here. Directory preview testing remains required
before either submission is published.

- Documentation: <https://boardrepo.com/connect>
- Smithery: <https://smithery.ai/servers/boardrepo/boardrepo>
- Glama: <https://glama.ai/mcp/connectors/com.boardrepo/boardrepo>
- Privacy: <https://boardrepo.com/privacy>
- Terms: <https://boardrepo.com/terms>
- Support: <mailto:support@boardrepo.com>
