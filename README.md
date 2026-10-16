# mcp-atlassian

MCP servers for Jira and Confluence **Server or Data Center**, packaged as a Claude Code plugin:
40 Jira tools and 22 Confluence tools that read, search, create, edit, comment, transition, plan
sprints and write pages. Your personal access token is sent only to your own host. Atlassian
Cloud is a different API; for Cloud use Atlassian's own
[remote server](https://github.com/atlassian/atlassian-mcp-server).

## Installation

Needs Node 22.18 or later and Claude Code 2.1.285 or later (`claude update`).

**Guided setup** (macOS, Linux). One command installs the plugin, asks for your Jira and
Confluence URLs and personal access tokens, checks each token against your host and saves
everything. Typing a token stays hidden, and tokens go to the system keychain, never to a file.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JanKolenko-git/mcp-atlassian/main/setup.sh)
```

Run it again any time to add the other product or replace a token.

<details>
<summary><b>By hand</b></summary>

**1. Install the plugin**

```bash
claude plugin marketplace add JanKolenko-git/mcp-atlassian && claude plugin install mcp-atlassian@jankolenko
```

**2. Create a personal access token in each product.** Jira: your avatar → **Profile** →
**Personal Access Tokens**. Confluence: your avatar → **Settings** → **Personal Access Tokens**.
One token per product; copy each once.

**3. Save the URLs and tokens.** Replace the two URLs, then run. The tokens are typed with
hidden input and go to the system keychain, never to a file or your shell history.

```bash
printf 'Jira token: '; read -rs JIRA_TOKEN; echo; printf 'Confluence token: '; read -rs CONFLUENCE_TOKEN; echo
JIRA_TOKEN="$JIRA_TOKEN" CONFLUENCE_TOKEN="$CONFLUENCE_TOKEN" node -e '
console.log(JSON.stringify({
  jira_url: "https://jira.example.com",
  confluence_url: "https://confluence.example.com",
  jira_token: process.env.JIRA_TOKEN,
  confluence_token: process.env.CONFLUENCE_TOKEN,
}))' | claude plugin configure mcp-atlassian@jankolenko --values-stdin
unset JIRA_TOKEN CONFLUENCE_TOKEN
```

</details>

Restart Claude Code. `/mcp` lists `Jira` and `Confluence` as connected; ask Claude to run
`whoami` on each to confirm the token works. If a server shows as failed, check that your
machine can reach the host: VPN on, or your address on the allowlist.

Reads and writes run under Claude Code's usual permissions; deletes ask before every call.
Each tier is set per product to `on`, `ask` or `off` in `/config` (`jira_read`, `jira_write`,
`jira_delete` and the Confluence three).

## Use cases

Say it in plain words; Claude picks the tools.

- "Move DXP-10000 to In Review and comment with the link to my PR."
- "Create a story under epic DXP-9000 from the Confluence page *Checkout redesign*, with its
  acceptance criteria as the description, and assign it to me."
- "Users report Core Web Vitals got slower since Monday. The details are in DXP-13050.
  Investigate and report back."
- "Is this a known bug?" followed by a pasted stack trace. Claude searches Jira, then comments
  on the existing ticket or creates one.
- "Break the spec *Loyalty points v2* into stories under a new epic, linked back to the page."
- "Summarise what changed in sprint 42 and write it into the *Status* section of the
  *DXP team* page."
- "Log 2h on DXP-10000 for today: reproduced the cache bug."

## Other MCP clients

Run `npm install` in a clone, then point any client that starts stdio servers at it:

```json
{
  "mcpServers": {
    "Jira": {
      "command": "node",
      "args": ["/path/to/mcp-atlassian/jira/server.ts"],
      "env": { "JIRA_URL": "https://jira.example.com", "JIRA_PERSONAL_TOKEN": "..." }
    },
    "Confluence": {
      "command": "node",
      "args": ["/path/to/mcp-atlassian/confluence/server.ts"],
      "env": { "CONFLUENCE_URL": "https://confluence.example.com", "CONFLUENCE_PERSONAL_TOKEN": "..." }
    }
  }
}
```

Optional: `JIRA_READ`, `JIRA_WRITE`, `JIRA_DELETE` and the Confluence three take `on`, `ask` or
`off`; `JIRA_MAX_UPLOAD_MB` and `CONFLUENCE_MAX_UPLOAD_MB` cap `add_attachment`.

## Development

```bash
npm install && npm run check
```

`check` runs `tsc` and the tests, which start each server against a fake local Jira or
Confluence.
