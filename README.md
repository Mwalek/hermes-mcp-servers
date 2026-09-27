# hermes-mcp-servers

Pinned installs of the MCP servers my Hermes agent runs on its server, with upgrades that arrive as pull requests.

## How an upgrade happens

1. **Dependabot** opens a PR: weekly for new versions of the server, straight away for security fixes. Each kind comes as one grouped PR.
2. **CI** (`smoke`) runs `npm ci` and starts the server with a fake credentials file, checking it lists its tools. It never touches Google.
3. **I review and merge.** Nothing reaches the server before that.
4. **The server pulls.** Every 15 minutes, `calendar/update.sh` on the server checks `main`. A new commit is installed into its own directory, tested with one real `list-calendars` call, and only then made live. If anything fails, the running version stays live and I get a Telegram message.

The server pulls from this public repo, so no key for the server is stored anywhere else.

## calendar/

The Google Calendar MCP server ([nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp), npm `@cocal/google-calendar-mcp`), pinned exactly, with `package-lock.json` fixing every dependency.

- `probe.mjs tools`: the CI check. Starts the server and checks `list-calendars` is offered.
- `probe.mjs call <account>`: the server-side check. Makes a real `list-calendars` call and passes only if `<account>` is among the calendars.
- `update.sh`: the pull-deploy script that runs on the server.

To upgrade by hand, change the version in `package.json`, run `npm install`, and open a PR with both files.

The server checks for merged changes every 15 minutes and messages me on Telegram when a release goes live or is refused.
