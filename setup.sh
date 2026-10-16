#!/usr/bin/env bash
# Guided setup for the mcp-atlassian Claude Code plugin.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/JanKolenko-git/mcp-atlassian/main/setup.sh)
#
# Checks Node and Claude Code, installs the plugin, asks for each product's URL and personal access
# token, tries the token against your host, then saves everything with `claude plugin configure`,
# which keeps the tokens in the system keychain. Questions are read from the terminal, so piping the
# script into bash works too. macOS and Linux.
set -euo pipefail

MARKETPLACE_SOURCE='JanKolenko-git/mcp-atlassian'
MARKETPLACE_NAME='jankolenko'
PLUGIN='mcp-atlassian@jankolenko'
NODE_MIN='22.18.0'
CLAUDE_MIN='2.1.285'

# --- output and prompts --------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' RESET=''
fi
step() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }
note() { printf '  %s\n' "$1"; }
ok()   { printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
fail() { printf '\n  %s✘ %s%s\n\n' "$RED" "$1" "$RESET" >&2; exit 1; }

TTY=/dev/tty
[ -r "$TTY" ] && [ -w "$TTY" ] || fail 'This setup asks questions, so it needs a terminal.'
# Ctrl-C during a hidden prompt would otherwise leave the terminal without echo.
trap 'stty echo <"$TTY" 2>/dev/null || true; printf "\n"; exit 130' INT

ask()        { printf '  %s ' "$1" >"$TTY"; IFS= read -r REPLY <"$TTY"; }
ask_secret() { printf '  %s ' "$1" >"$TTY"; IFS= read -rs REPLY <"$TTY"; printf '\n' >"$TTY"; }
confirm()    { ask "$1 [Y/n]"; case "$REPLY" in [nN]*) return 1 ;; *) return 0 ;; esac; }

# version_at_least 2.1.300 2.1.285: numeric compare of dotted versions, a leading v or a -suffix ignored.
version_at_least() {
  local have="${1#v}" want="${2#v}" a b i
  have=${have%%-*}; want=${want%%-*}
  for i in 1 2 3; do
    a=$(printf '%s' "$have" | cut -d. -f"$i"); b=$(printf '%s' "$want" | cut -d. -f"$i")
    a=${a:-0}; b=${b:-0}
    [ "$a" -gt "$b" ] 2>/dev/null && return 0
    [ "$a" -lt "$b" ] 2>/dev/null && return 1
  done
  return 0
}

printf '\n%sLet'"'"'s set up mcp-atlassian, the Jira and Confluence plugin for Claude Code.%s\n' "$BOLD" "$RESET"
note "Four steps: Node, Claude Code, the plugin, then your Jira and Confluence. Ctrl-C leaves at any point."

# --- 1. Node -------------------------------------------------------------------------------------

step '1/4  Node'
node_version() { command -v node >/dev/null 2>&1 && node --version 2>/dev/null | sed 's/^v//'; }
load_nvm() {
  local f
  for f in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
    # nvm's own script is not written for set -e / set -u.
    if [ -s "$f" ]; then set +eu; . "$f"; set -eu; return 0; fi
  done
  return 1
}

have_node=$(node_version || true)
if [ -n "$have_node" ] && version_at_least "$have_node" "$NODE_MIN"; then
  ok "Node $have_node"
else
  if [ -n "$have_node" ]; then note "Node $have_node is too old: the plugin needs $NODE_MIN or later."; else note 'Node is not installed.'; fi
  if load_nvm; then
    note 'Installing Node 22 with nvm…'
    set +eu; nvm install 22 >/dev/null; rc=$?; set -eu
    [ "$rc" -eq 0 ] || fail 'nvm could not install Node 22. Run `nvm install 22` yourself, then start this again.'
    have_node=$(node_version || true)
    version_at_least "${have_node:-0}" "$NODE_MIN" || fail "nvm installed Node 22 but this shell still runs ${have_node:-none}. Open a new terminal and start this again."
    if confirm 'Make Node 22 the nvm default, so Claude Code finds it when it starts the servers?'; then
      set +eu; nvm alias default 22 >/dev/null; set -eu
      ok "Node $(node_version), now the nvm default"
    else
      ok "Node $(node_version) for this shell"
      warn 'Claude Code starts the servers with the `node` on its own PATH: make sure that one is 22.18 or later.'
    fi
  else
    fail "Install Node $NODE_MIN or later from https://nodejs.org (or \`brew install node\`), then start this again."
  fi
fi

# --- 2. Claude Code ------------------------------------------------------------------------------

step '2/4  Claude Code'
command -v claude >/dev/null 2>&1 || fail 'Claude Code is not installed. See https://docs.claude.com/en/docs/claude-code/setup, then start this again.'
have_claude=$(claude --version 2>/dev/null | awk '{print $1}')
if version_at_least "${have_claude:-0}" "$CLAUDE_MIN"; then
  ok "Claude Code $have_claude"
else
  note "Claude Code ${have_claude:-?} is older than $CLAUDE_MIN, the first version with per-tier plugin options."
  confirm 'Run `claude update` now?' || fail "Update Claude Code to $CLAUDE_MIN or later, then start this again."
  claude update
  have_claude=$(claude --version 2>/dev/null | awk '{print $1}')
  version_at_least "${have_claude:-0}" "$CLAUDE_MIN" || fail "Claude Code is still ${have_claude:-?}. Update it to $CLAUDE_MIN or later, then start this again."
  ok "Claude Code $have_claude"
fi

# --- 3. Plugin -----------------------------------------------------------------------------------

step '3/4  Plugin'
# By name, so a marketplace added from a clone of the repo counts too.
if claude plugin marketplace list --json 2>/dev/null | grep -qE "\"name\": *\"$MARKETPLACE_NAME\""; then
  ok "Marketplace $MARKETPLACE_NAME already added"
else
  claude plugin marketplace add "$MARKETPLACE_SOURCE" >/dev/null
  ok "Marketplace $MARKETPLACE_NAME added"
fi
if claude plugin list 2>/dev/null | grep -qF "$PLUGIN"; then
  ok "$PLUGIN already installed"
else
  claude plugin install "$PLUGIN" >/dev/null
  ok "$PLUGIN installed"
fi

# --- 4. Jira and Confluence ----------------------------------------------------------------------

step '4/4  Jira and Confluence'
note 'Each product takes its address and a personal access token. Leave one out with "n" and add it later by running this again.'

# normalize_url "jira.example.com/" -> https://jira.example.com
normalize_url() {
  local u
  u=$(printf '%s' "$1" | tr -d '[:space:]')
  [ -n "$u" ] || return 0
  case "$u" in http://*|https://*) ;; *) u="https://$u" ;; esac
  while [ "${u%/}" != "$u" ]; do u=${u%/}; done
  printf '%s' "$u"
}

# probe NAME URL TOKEN: prints who the token signs in as, or explains the failure on stderr and returns 1.
probe() {
  local name=$1 url=$2 token=$3 body err code target who
  body=$(mktemp) err=$(mktemp)
  # The token goes to curl through its config on stdin, so it never shows in the process list.
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS -m 20 -K - -o "$body" -w '%{http_code} %{redirect_url}' "$url" 2>"$err") || code=000
  target=${code#* }; code=${code%% *}
  case "$code" in
    200)
      if who=$(node -e '
        const u = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (!u.displayName) throw new Error("not a user");
        console.log(`${u.displayName} (${u.name || u.username || u.key})`);' "$body" 2>/dev/null); then
        rm -f "$body" "$err"; printf '%s\n' "$who"; return 0
      fi
      warn "$url answered with a page instead of the API. Is this the address you use in the browser, with its context path (such as /jira) if it has one?" ;;
    401) warn "$name rejected the token (401). Check that it is a $name token, not one from the other product, and that it has not expired." ;;
    403) warn "$name knows the token but refused the request (403). Your account may need a login in the browser first, or the token may lack permissions." ;;
    301|302|303|307|308)
      case "$target" in
        *login*|*openid*|*sso*|*saml*|*oauth*|*auth*)
          warn "$name sent the request to a login page ($target) instead of answering. The API is not reachable from this network: connect to the VPN or have your address allowlisted, then try again. If it still happens on the VPN, the token may have been revoked." ;;
        *) warn "$name redirected $url to $target. Try that address as the $name URL." ;;
      esac ;;
    000) warn "Could not reach $url: $(tr -d '\n' <"$err" | sed 's/^curl: ([0-9]*) //'). Are you on the VPN, or is this machine on the allowlist?" ;;
    *)   warn "Unexpected answer $code from $url. Is this the base address of $name?" ;;
  esac
  rm -f "$body" "$err"
  return 1
}

# setup_product NAME EXAMPLE PROBE_PATH "where the token is": sets PRODUCT_URL and PRODUCT_TOKEN, both empty when skipped.
setup_product() {
  local name=$1 example=$2 probe_path=$3 where=$4 url token
  PRODUCT_URL='' PRODUCT_TOKEN=''
  printf '\n'
  confirm "Set up $name?" || { note "Skipping $name."; return 0; }
  while :; do
    ask "$name URL (for example $example):"
    url=$(normalize_url "$REPLY")
    [ -n "$url" ] && break
    warn "Enter the address you open in the browser, such as $example."
  done
  note "In $name: $where. Create one and paste it here; typing stays hidden."
  while :; do
    ask_secret "$name personal access token:"
    token=$REPLY
    if [ -z "$token" ]; then warn 'The token is empty.'; continue; fi
    if who=$(probe "$name" "$url$probe_path" "$token"); then ok "Signed in to $name as $who"; break; fi
    ask 'Try again (t), save it anyway (s), or skip this product (k)? [t/s/k]'
    case "$REPLY" in [sS]*) warn "Saving the $name token unchecked."; break ;; [kK]*) note "Skipping $name."; return 0 ;; esac
  done
  PRODUCT_URL=$url PRODUCT_TOKEN=$token
}

setup_product 'Jira' 'https://jira.example.com' '/rest/api/2/myself' 'your avatar → Profile → Personal Access Tokens'
JIRA_URL=$PRODUCT_URL JIRA_TOKEN=$PRODUCT_TOKEN
setup_product 'Confluence' 'https://confluence.example.com' '/rest/api/user/current' 'your avatar → Settings → Personal Access Tokens'
CONFLUENCE_URL=$PRODUCT_URL CONFLUENCE_TOKEN=$PRODUCT_TOKEN

# --- Save ----------------------------------------------------------------------------------------

printf '\n'
if [ -z "$JIRA_URL$CONFLUENCE_URL" ]; then
  note 'Nothing to save: both products were skipped. The plugin is installed; run this again to add them.'
  exit 0
fi

# Only the products set up go in, so a saved token for the other one is kept.
JIRA_URL="$JIRA_URL" JIRA_TOKEN="$JIRA_TOKEN" CONFLUENCE_URL="$CONFLUENCE_URL" CONFLUENCE_TOKEN="$CONFLUENCE_TOKEN" node -e '
  const values = {};
  for (const [option, env] of [["jira_url", "JIRA_URL"], ["jira_token", "JIRA_TOKEN"], ["confluence_url", "CONFLUENCE_URL"], ["confluence_token", "CONFLUENCE_TOKEN"]]) {
    if (process.env[env]) values[option] = process.env[env];
  }
  process.stdout.write(JSON.stringify(values));' | claude plugin configure "$PLUGIN" --values-stdin >/dev/null
unset JIRA_TOKEN CONFLUENCE_TOKEN PRODUCT_TOKEN
ok 'Saved. The URLs are plugin options; the tokens are in your system keychain, not in a file.'

step 'Setup complete'
note 'Restart Claude Code. Then /mcp lists Jira and Confluence as connected; ask Claude to run whoami on each.'
note 'If a server shows as failed, check that this machine can reach the host: VPN on, or your address on the allowlist.'
note 'Reads and writes run under your usual permissions; deletes ask before every call. Change a tier in /config.'
printf '\n'
