# Accounts and identity

Who writes to GitHub depends on the home `config.json`. SPEC.md "Accounts" is the contract. Three setups:

| setup | config | bot routes | agent routes that push |
| --- | --- | --- | --- |
| with a bot | `bot: { login, tokenFile }` | run as the bot | allowed, as the bot |
| without a bot | `bot: null`, `allowOwnTokenPushes: false` | prefill for the maintainer where a prefill exists, otherwise not offered | not offered |
| own token | `bot: null`, `allowOwnTokenPushes: true` | prefill where one exists, otherwise run under the maintainer's `gh` login | allowed, under the maintainer's `gh` login |

`request_review` for a Copilot review runs under the maintainer's login in every setup. The request for the maintainer's own review runs under the writing identity: the bot with a bot, and skipped in the own-token setup.

## Writing routes for each setup

- With a bot, use the `as` values from SPEC.md "Routes".
- Without a bot, a route that would be `as: "bot"` becomes `as: "me"` when it has a prefill: `reply`, `request_logs`, `reopen`, and the body of a `review`. A `review` keeps only its body as `text`. Its inline comments go into that body as a list with `path:line`, because a prefill cannot carry inline comments.
- Without a bot, routes without a prefill (inline review comments, `move` to a repo, `chore`) appear only with `allowOwnTokenPushes: true`. They keep `as: "bot"`. The server runs them under the maintainer's login, and the card shows his avatar.
- `address_review`, `take_over`, `revise`, `drive` and `follow_up` with `as: "agent"` push code. Offer them only with a bot or with `allowOwnTokenPushes: true`. The same holds for a `take_over` or `revise` in the API form, with `as: "bot"`.

## The automatic first review

`gary auto-review post` sends its review as the bot, or with `allowOwnTokenPushes: true` under the maintainer's `gh` login. Without either it is off. Never post such a review with `gh` or `gary action` yourself: the command is the only path, and it enforces the rules.

## Running writes

Every GitHub write that is not a `gary action` call runs under the writing identity:

- **With a bot**: `GH_TOKEN="$(cat <bot.tokenFile>)" command gh …`. `command gh` skips any `gh` shell function the maintainer may have defined.
- **Own token**: plain `command gh …`, which uses the maintainer's `gh` login.

Reads can use plain `gh`.

## Git identity

Commits by agents carry the writing identity, whatever the global git config says:

- **With a bot**: name `<bot.login>`, email `<id>+<bot.login>@users.noreply.github.com`, with `<id>` from `gh api users/<bot.login> --jq .id`.
- **Own token**: the maintainer's own git identity. Pass no `-c user.*`.

Push over HTTPS:

```bash
# with a bot: the helper reads the token at push time, so it never lands in the command line
git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat <bot.tokenFile>)"; }; f' push https://github.com/<owner>/<repo>.git HEAD:refs/heads/<branch>

# own token
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/<owner>/<repo>.git HEAD:refs/heads/<branch>
```

Never force-push.

## Who counts as "us"

A comment is from our side when its author is the maintainer (`me`), a login in the profile's `maintainers`, the bot or a login in `botLogins`, or has author association `OWNER`, `MEMBER` or `COLLABORATOR`. Comments posted through the board appear as the bot, so they count as the maintainer's reply.

Automated comments are the exception. The bot account also posts comments from workflows, where no human decided to post. Such a comment does not count as our request or our reply. The profile's `automatedComments` in `profile.json` lists their patterns, and `facts.timeline` marks matching comments with `side: "automated"`. A bot comment that matches no listed pattern counts as ours.
