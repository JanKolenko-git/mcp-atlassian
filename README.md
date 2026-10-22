# mcp-atlassian

MCP servers for Jira and Confluence **Server or Data Center**, packaged as a Claude Code plugin: 41
Jira tools and 29 Confluence tools that read, search, create, edit, comment, transition, plan
sprints, write pages and manage who may see them. Your personal access token is sent only to your
own host. Atlassian Cloud is a different API; for Cloud use Atlassian's own
[remote server](https://github.com/atlassian/atlassian-mcp-server).

## Installation

Needs Node 22.18 or later and Claude Code 2.1.285 or later (`claude update`).

**1. Download the repository and install the plugin.** Claude Code copies the plugin into its own
cache and installs its dependencies, so the clone can stay where it is or be deleted afterwards.

```bash
git clone https://github.com/JanKolenko-git/mcp-atlassian.git
claude plugin marketplace add ./mcp-atlassian
claude plugin install mcp-atlassian@jankolenko
```

To install straight from GitHub instead of a clone, replace the first two lines with
`claude plugin marketplace add JanKolenko-git/mcp-atlassian`.

**2. Create a personal access token in each product.** Jira: your avatar → **Profile** → **Personal
Access Tokens**. Confluence: your avatar → **Settings** → **Personal Access Tokens**. One token per
product; copy each once.

**3. Enter the URLs and tokens.** In Claude Code, run `/plugin`, open **mcp-atlassian** and choose
**Configure options**. Fill in the Jira and Confluence URLs and paste each token; tokens are stored
in the system keychain, never in a file. Set up only one product if you use only one.

<details>
<summary><b>From the terminal instead</b></summary>

`claude plugin configure` saves the same options from stdin. Replace the two URLs, then run; the
tokens are typed with hidden input and go to the system keychain, never to a file or your shell
history.

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

**4. Restart Claude Code.** `/mcp` lists `Jira` and `Confluence` as connected; ask Claude to run
`whoami` on each to confirm the token works. If a server shows as failed, check that your machine
can reach the host: VPN on, or your address on the allowlist.

Reads and writes run under Claude Code's usual permissions; deletes ask before every call. Each tier
is set per product to `on`, `ask` or `off` in `/config` (`jira_read`, `jira_write`, `jira_delete`
and the Confluence three).

**Updating.** `claude plugin marketplace update jankolenko` refreshes the catalog (after a
`git pull` when it was added from a clone), then `claude plugin update mcp-atlassian@jankolenko` and
a restart.

## Use cases

Say it in plain words; Claude picks the tools.

- "Move DXP-10000 to In Review and comment with the link to my PR."
- "Create a story under epic DXP-9000 from the Confluence page _Checkout redesign_, with its
  acceptance criteria as the description, and assign it to me."
- "Users report Core Web Vitals got slower since Monday. The details are in DXP-13050. Investigate
  and report back."
- "Is this a known bug?" followed by a pasted stack trace. Claude searches Jira, then comments on
  the existing ticket or creates one.
- "Break the spec _Loyalty points v2_ into stories under a new epic, linked back to the page."
- "Summarise what changed in sprint 42 and write it into the _Status_ section of the _DXP team_
  page."
- "Log 2h on DXP-10000 for today: reproduced the cache bug."
- "Which pull requests are linked to DXP-10000, and are they merged?"
- "Create next week's status page from the _Weekly status_ template and restrict editing to the DXP
  team."

## Other MCP clients

Run `npm install` in a clone, then point any client that starts stdio servers at it:

```json
{
  "mcpServers": {
    "Jira": {
      "command": "node",
      "args": ["/path/to/mcp-atlassian/connectors/jira/server.ts"],
      "env": { "JIRA_URL": "https://jira.example.com", "JIRA_PERSONAL_TOKEN": "..." }
    },
    "Confluence": {
      "command": "node",
      "args": ["/path/to/mcp-atlassian/connectors/confluence/server.ts"],
      "env": {
        "CONFLUENCE_URL": "https://confluence.example.com",
        "CONFLUENCE_PERSONAL_TOKEN": "..."
      }
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

`check` runs `tsc`, [Oxlint](https://oxc.rs/docs/guide/usage/linter), `oxfmt --check` and the tests,
which start each server against a fake local Jira or Confluence. `npm run fix` applies the lint
fixes and formats the code. The servers live in `connectors/jira` and `connectors/confluence`; code
both use is in `connectors/shared`.
