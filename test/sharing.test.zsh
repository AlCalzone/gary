#!/usr/bin/env zsh
# Tests for setup, doctor, paths, profile and config validation and the account modes. Runs offline against the fake gh.
# Usage: zsh test/sharing.test.zsh
T=${0:A:h}
W=${T:h}
B=$W/bin/gary
P=$T/fixtures/profile
H=$(mktemp -d "${TMPDIR:-/tmp}/gary-test-XXXXXX")
export PATH="$T/fake-gh:$PATH"
unset GH_TOKEN GITHUB_TOKEN
TOKEN=$H/bot-token; print fake-bot-token > $TOKEN; chmod 600 $TOKEN
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
CHECKOUT=$H/checkout; mkdir -p $CHECKOUT/.git
pass=0 fail=0
ok() { ((pass++)) }
bad() { ((fail++)); print -r -- "FAIL $1"; print -r -- "$2" | head -12 }
expect() { # name, expected exit, pattern, command...
	local name=$1 code=$2 pat=$3; shift 3
	local out; out=$("$@" 2>&1 < /dev/null); local got=$?
	if [[ $got == $code ]] && print -r -- "$out" | grep -qF -- "$pat"; then ok; else bad "$name (exit $got)" "$out"; fi
}

act() { print -r -- "$2" | GARY_HOME=$1 node $B action --dry-run $3 }


# setup
expect "setup with a shipped profile and a bot" 0 "wrote" env GARY_HOME=$H/bot node $B setup --profile $P --me octocat --bot-login widgets-bot --bot-token-file $TOKEN --port $PORT --no-links
expect "setup refuses to overwrite" 1 "Pass --force" env GARY_HOME=$H/bot node $B setup --profile $P --me octocat --no-bot --no-links
expect "setup --force overwrites" 0 "wrote" env GARY_HOME=$H/bot node $B setup --profile $P --me octocat --bot-login widgets-bot --bot-token-file $TOKEN --port $PORT --no-links --force
expect "setup without a bot" 0 "wrote" env GARY_HOME=$H/nobot node $B setup --profile $P --me octocat --checkout $CHECKOUT --no-bot --port $PORT --no-links
expect "paths has the checkout" 0 "\"checkout\": \"$CHECKOUT\"" env GARY_HOME=$H/nobot node $B paths
expect "config stores the checkout" 0 "\"checkout\": \"$CHECKOUT\"" cat $H/nobot/instances/widgets/config.json
mkdir -p $H/keep; print "# mine" > $H/keep/personal.md
expect "setup keeps an existing personal.md" 0 "wrote" env GARY_HOME=$H/keep node $B setup --profile $P --me octocat --no-bot --no-links
expect "personal.md unchanged" 0 "# mine" cat $H/keep/personal.md
expect "setup creates a new profile from the template" 0 "created profile" env GARY_HOME=$H/new node $B setup --repo octo-org/widgets --me octocat --no-bot --no-links
expect "new profile is valid and named after the repo" 0 '"name": "widgets"' cat $H/new/profiles/widgets/profile.json
expect "new profile has the rules skeleton" 0 "issues.md" ls $H/new/profiles/widgets/rules
expect "setup needs --repo for a new profile" 1 "--repo" env GARY_HOME=$H/norepo node $B setup --me octocat --no-bot --no-links
expect "setup rejects a bad login" 1 '"me" must be' env GARY_HOME=$H/badme node $B setup --profile $P --me "not a login" --no-bot --no-links
expect "setup needs a token file with a bot" 1 "--bot-token-file" env GARY_HOME=$H/notoken node $B setup --profile $P --me octocat --bot-login widgets-bot --no-links
expect "setup writes personal.md" 0 "read this file last" cat $H/nobot/personal.md
expect "setup creates state/" 0 "" test -d $H/nobot/instances/widgets/state

# setup links into a temp HOME, never the real one
expect "setup links skills and the launcher" 0 "linked" env HOME=$H/fakehome GARY_HOME=$H/links node $B setup --profile $P --me octocat --no-bot
expect "skill link points into the core" 0 "$W/skills/triage-routine" readlink $H/fakehome/.claude/skills/triage-routine
expect "triage-setup skill is linked" 0 "$W/skills/triage-setup" readlink $H/fakehome/.claude/skills/triage-setup
expect "launcher link" 0 "$W/bin/gary" readlink $H/fakehome/.local/bin/gary
expect "setup prints the MCP command" 0 "claude mcp add --scope user gary -- node $W/mcp-server/index.mjs" env HOME=$H/fakehome GARY_HOME=$H/links node $B setup --profile $P --me octocat --no-bot --force
expect "linked launcher runs" 0 '"home"' env GARY_HOME=$H/links $H/fakehome/.local/bin/gary paths

# paths and doctor
expect "paths" 0 "\"profile\": \"$P\"" env GARY_HOME=$H/bot node $B paths
expect "doctor passes with the bot" 0 "widgets-bot, token in" env GARY_HOME=$H/bot node $B doctor
expect "doctor checks the checkout" 0 "$CHECKOUT" env GARY_HOME=$H/nobot node $B doctor
expect "doctor without a bot" 0 "bot routes become text you post yourself" env GARY_HOME=$H/nobot node $B doctor
cp -r $H/bot $H/wrongme; sed -i 's/"me": "octocat"/"me": "someone-else"/' $H/wrongme/instances/widgets/config.json
expect "doctor fails on a gh login that is not me" 1 'config.json names "someone-else"' env GARY_HOME=$H/wrongme node $B doctor
cp -r $H/bot $H/wrongbot; sed -i 's/"login": "widgets-bot"/"login": "other-bot"/' $H/wrongbot/instances/widgets/config.json
expect "doctor fails on a token of another account" 1 'belongs to "widgets-bot"' env GARY_HOME=$H/wrongbot node $B doctor
expect "doctor without config" 1 "There is no Gary instance" env GARY_HOME=$H/none node $B doctor
expect "doctor --json" 0 '"name": "gh login"' env GARY_HOME=$H/bot node $B doctor --json

# profile and config validation
mkdir -p $H/badprofile-p; print '{"name":"x","repo":"not a repo","maintainers":["a b"],"reviewBots":["octobot"],"relatedRepos":["a/b"],"botCommands":{"x":""},"extra":1}' > $H/badprofile-p/profile.json
cp -r $H/nobot $H/badprofile; sed -i "s|\"profile\": \"[^\"]*\"|\"profile\": \"$H/badprofile-p\"|" $H/badprofile/instances/widgets/config.json
for pat in '"repo" must look like' '"maintainers" must be' '"reviewBots[0]" must be "copilot"' '"relatedRepos" must be' '"botCommands" must map'; do
	expect "profile validation: $pat" 2 "$pat" env GARY_HOME=$H/badprofile node $B snapshot
done
mkdir -p $H/badconfig/instances/widgets; print '{"profile":"x","me":"octocat","bot":{"login":"octocat"},"port":0,"typo":1,"escalateAs":"bot"}' > $H/badconfig/instances/widgets/config.json
for pat in 'must be null or' 'belongs in the root config' 'must be one of me, prefill'; do
	expect "config validation: $pat" 2 "$pat" env GARY_HOME=$H/badconfig node $B paths
done
# Unknown fields only warn at run time, so a newer profile or config does not stop an older Gary. Doctor refuses them
mkdir -p $H/newer-p; cp -r $P/* $H/newer-p/; sed -i 's|^{|{"extra": 1,|' $H/newer-p/profile.json
cp -r $H/nobot $H/newer; sed -i "s|\"profile\": \"[^\"]*\"|\"profile\": \"$H/newer-p\"|; s|^{|{\"typo\": 1,|" $H/newer/instances/widgets/config.json
expect "unknown fields do not stop the run time" 0 '"instance": "widgets"' env GARY_HOME=$H/newer node $B paths
expect "doctor refuses an unknown profile field" 1 'unknown field "extra"' env GARY_HOME=$H/newer node $B doctor
expect "doctor refuses an unknown config field" 1 'unknown field "typo"' env GARY_HOME=$H/newer node $B doctor
expect "setup refuses a profile with an unknown field" 1 'profile: unknown field "extra"' env GARY_HOME=$H/newer-setup node $B setup --profile $H/newer-p --me octocat --no-bot --checkout $CHECKOUT --no-links
mkdir -p $H/notjson/instances/widgets; print '{' > $H/notjson/instances/widgets/config.json
expect "config that is not JSON" 2 "is not valid JSON" env GARY_HOME=$H/notjson node $B paths

# account modes for actions
expect "bot mode writes as the bot" 0 '"as": "widgets-bot"' act $H/bot '{"action":"comment","kind":"pr","number":12,"text":"x"}'
expect "no bot: writes are refused" 1 "No bot account is configured" act $H/nobot '{"action":"comment","kind":"pr","number":12,"text":"x"}'
expect "no bot: request_review still runs as me" 0 '"as": "octocat"' act $H/nobot '{"action":"request_review","kind":"pr","number":12,"params":{"reviewer":"copilot"}}'
cp -r $H/nobot $H/own; sed -i 's/"allowOwnTokenPushes": false/"allowOwnTokenPushes": true/' $H/own/instances/widgets/config.json
expect "allowOwnTokenPushes: writes run as me" 0 '"as": "octocat"' act $H/own '{"action":"comment","kind":"pr","number":12,"text":"x"}'
expect "allowOwnTokenPushes: REST write as me" 0 '"as": "octocat"' act $H/own '{"action":"rerun_ci","kind":"pr","number":14}'
cp -r $H/own $H/ownwrong; sed -i 's/"me": "octocat"/"me": "someone-else"/' $H/ownwrong/instances/widgets/config.json
expect "allowOwnTokenPushes: refused when the stored login is not me" 1 'but config.json names' act $H/ownwrong '{"action":"comment","kind":"pr","number":12,"text":"x"}'
expect "bot mode: request_review refused when the stored login is not me" 1 'but config.json names' act $H/wrongme '{"action":"request_review","kind":"pr","number":12,"params":{"reviewer":"copilot"}}'
print '{"name":"x","repo":"acme/widgets"}' > $H/badprofile-p/profile.json
expect "request_review needs copilot in reviewBots" 1 "does not list copilot" act $H/badprofile '{"action":"request_review","kind":"pr","number":12,"params":{"reviewer":"copilot"}}'
expect "transfer needs relatedRepos" 1 "none listed" act $H/badprofile '{"action":"transfer","kind":"issue","number":21,"params":{"repo":"widgets-desktop"}}'
expect "bot commands in text are refused" 1 "bot command" act $H/bot '{"action":"comment","kind":"pr","number":12,"text":"@widgets-bot escalate"}'
expect "action passes --check-fresh through" 1 "needs the itemId" act $H/bot '{"action":"comment","kind":"pr","number":12,"text":"x"}' --check-fresh

# put, snapshot and watch-queue pass their flags through
print '{"kind":"issue","number":21,"title":"t"}' > $H/item.json
expect "put writes an item" 0 '"ok":true' env GARY_HOME=$H/nobot node $B put --merge items issue-21 $H/item.json
expect "the item is in the home state" 0 '"number": 21' cat $H/nobot/instances/widgets/state/board/items/issue-21.json
expect "put --delete removes it" 0 '"ok":true' env GARY_HOME=$H/nobot node $B put items issue-21 --delete
expect "item is gone" 1 "" test -e $H/nobot/instances/widgets/state/board/items/issue-21.json
expect "snapshot --commit without a staged snapshot" 1 "without --commit first" env GARY_HOME=$H/nobot node $B snapshot --commit
expect "watch-queue --once" 0 "" env GARY_HOME=$H/nobot node $B watch-queue --once
expect "unknown command" 2 "Unknown command" node $B frobnicate

# Only request_review reaches the stored login while a bot is configured
callers=$(grep -rln "requestCopilotReview" $W/scripts $W/server $W/mcp-server/index.mjs $W/bin | sort | tr '\n' ' ')
[[ $callers == "$W/scripts/lib/actions.mjs $W/scripts/lib/gh.mjs " ]] && ok || bad "helper callers" "$callers"
[[ $(grep -c "requestCopilotReview(" $W/scripts/lib/actions.mjs) == 1 ]] && ok || bad "one call site" ""
# Only the board server posts the escalate command, from one place
callers=$(grep -rln "postEscalateCommand" $W/scripts $W/server $W/mcp-server/index.mjs $W/bin | sort | tr '\n' ' ')
[[ $callers == "$W/scripts/lib/gh.mjs $W/server/server.mjs " ]] && ok || bad "escalate helper callers" "$callers"
[[ $(grep -c "postEscalateCommand(" $W/server/server.mjs) == 1 ]] && ok || bad "one escalate call site" ""
# Only the link of an escalated discussion edits a PR's body
callers=$(grep -rln "updatePullRequest(" $W/scripts $W/server $W/mcp-server/index.mjs $W/bin | sort | tr '\n' ' ')
[[ $callers == "$W/scripts/lib/escalation.mjs " ]] && ok || bad "body edit callers" "$callers"
expect "gh() in bot mode uses the bot token" 0 "widgets-bot" env GARY_HOME=$H/bot node -e "import('$W/scripts/lib/gh.mjs').then(async (m) => console.log((await m.gh(['api','user','--jq','.login'])).trim()))"

rm -rf $H
print "sharing: $pass passed, $fail failed"
[[ $fail == 0 ]]
