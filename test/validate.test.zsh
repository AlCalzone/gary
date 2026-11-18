#!/usr/bin/env zsh
# Tests for gary item, gary put validation, gary validate and gary action --autonomous. Runs offline against the fake gh.
# Usage: zsh test/validate.test.zsh
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

export GARY_HOME=$H/home
node $B setup --profile $P --me octocat --bot-login widgets-bot --bot-token-file $TOKEN --port $PORT --no-links > /dev/null
ITEMS=$GARY_HOME/instances/widgets/state/board/items

# gary item
expect "item: PR with threads and reviews" 0 '"openThreadCount": 3' node $B item pr 12
expect "item: PR thread ids" 0 '"id": "PRRT_' node $B item pr 12
expect "item: reviewer summary" 0 '"state": "approved"' node $B item pr 12
expect "item: outdated thread is kept and flagged" 0 '"outdated": true' node $B item pr 12
expect "item: issue with a closing PR" 0 '"closingPrs"' node $B item issue 22
expect "item: closing PR number" 0 '"number": 12' node $B item issue 22
expect "item: discussion" 0 '"isAnswered"' node $B item discussion 31
expect "item: unknown number" 1 "not found" node $B item pr 99999
expect "item: an issue number asked as PR" 1 "not found" node $B item pr 21
expect "item: a kind that does not exist" 1 "kind must be one of" node $B item thing 1
expect "item: an id that is not on the board" 1 "is not on the board" node $B item pr-12
expect "item: a repo outside the instance" 1 "is not a repository of instance widgets" node $B item pr 12 --repo acme/other
expect "item writes no state" 0 "" test ! -e $GARY_HOME/state/snapshot.pending.json

# put validation
mk() { print -r -- "$2" > $H/$1.json }
BASE='"repo":"acme/widgets","kind":"pr","number":12,"title":"t","url":"https://github.com/x","author":"a","authorType":"maintainer","section":"easy","priority":1,"effortMinutes":5,"reviewDepth":"full","state":"Decide."'
mk good "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"r1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"Thanks\",\"recommended\":true},{\"id\":\"r2\",\"type\":\"merge\",\"title\":\"Merge: ready\",\"as\":\"me\"}],\"findings\":[{\"severity\":\"minor\",\"text\":\"x\",\"routeId\":\"r2\"}]}"
expect "put: a valid item is written" 0 '"ok":true' node $B put items pr-12 $H/good.json
expect "put: the item is stored" 0 '"Reply: thanks"' cat $ITEMS/pr-12.json
expect "put --merge: a partial update of maintainer fields is not validated" 0 '"ok":true' zsh -c "print '{\"hidden\":true,\"snoozedUntil\":\"2026-12-01\"}' > $H/p.json; node $B put --merge items pr-12 $H/p.json"
expect "put: partial update keeps the routes" 0 '"hidden": true' cat $ITEMS/pr-12.json

# replace semantics
mk replace "{$BASE,\"priority\":null,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"r1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"Thanks\",\"recommended\":true}],\"hidden\":false}"
node -e 'const f=process.argv[1];const d=JSON.parse(require("fs").readFileSync(f));delete d.priority;require("fs").writeFileSync(f,JSON.stringify(d))' $H/replace.json
expect "put replaces the stored doc" 0 '"ok":true' node $B put items pr-12 $H/replace.json
expect "a field the new doc omits is gone" 0 "" zsh -c "! grep -q findings $ITEMS/pr-12.json"
expect "hidden carries over from the stored doc" 0 '"hidden": true' cat $ITEMS/pr-12.json
expect "snoozedUntil carries over" 0 '"snoozedUntil": "2026-12-01"' cat $ITEMS/pr-12.json
expect "priority carries over when the new doc has none" 0 '"priority": 1' cat $ITEMS/pr-12.json
expect "put --merge changes only the given fields" 0 '"ok":true' zsh -c "print '{\"priority\":3}' > $H/m.json; node $B put --merge items pr-12 $H/m.json"
expect "merge keeps the routes" 0 '"Reply: thanks"' cat $ITEMS/pr-12.json
expect "merge sets the field" 0 '"priority": 3' cat $ITEMS/pr-12.json
mk replace2 "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"r1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"Thanks\",\"recommended\":true}]}"
expect "a replace with its own priority keeps it" 0 '"priority": 1' zsh -c "node $B put items pr-12 $H/replace2.json > /dev/null; cat $ITEMS/pr-12.json"
expect "a replace that breaks a rule is refused" 1 "hint" zsh -c "sed 's/\"hint\":\"Reply: thanks\"/\"hint\":\"Other\"/' $H/replace2.json > $H/r3.json; node $B put items pr-12 $H/r3.json"
node $B put items pr-12 $H/good.json > /dev/null

bad_case() { # name, pattern, json
	mk case "$3"
	expect "put refuses: $1" 1 "$2" node $B put items pr-12 $H/case.json
}
R1='{"id":"r1","type":"reply","title":"Reply: thanks","as":"bot","text":"Thanks","recommended":true}'
bad_case "missing section" "section must be one of" "{${BASE/\"section\":\"easy\"/\"section\":null},\"hint\":\"Reply: thanks\",\"routes\":[$R1]}"
bad_case "bad effort" "effortMinutes must be one of" "{${BASE/\"effortMinutes\":5/\"effortMinutes\":7},\"hint\":\"Reply: thanks\",\"routes\":[$R1]}"
bad_case "route id s1" "id must be one of r1, r2, r3, r4" "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"s1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"x\",\"recommended\":true}]}"
bad_case "duplicate route id" "is used twice" "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[$R1,{\"id\":\"r1\",\"type\":\"merge\",\"title\":\"Merge\",\"as\":\"me\"}]}"
bad_case "five routes" "at most 4 routes" "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[$R1,{\"id\":\"r2\",\"type\":\"merge\",\"title\":\"M\"},{\"id\":\"r3\",\"type\":\"merge\",\"title\":\"M\"},{\"id\":\"r4\",\"type\":\"merge\",\"title\":\"M\"},{\"id\":\"r4\",\"type\":\"merge\",\"title\":\"M\"}]}"
bad_case "no recommended" "exactly one route must be recommended, found 0" "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"r1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"x\"}]}"
bad_case "two recommended" "found 2" "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[$R1,{\"id\":\"r2\",\"type\":\"merge\",\"title\":\"M\",\"recommended\":true}]}"
bad_case "hint differs" "differs from the recommended route" "{$BASE,\"hint\":\"Reply: other\",\"routes\":[$R1]}"
bad_case "long hint" "longer than 60" "{$BASE,\"hint\":\"$(printf 'x%.0s' {1..61})\",\"routes\":[{\"id\":\"r1\",\"type\":\"reply\",\"title\":\"$(printf 'x%.0s' {1..61})\",\"as\":\"bot\",\"text\":\"x\",\"recommended\":true}]}"
bad_case "routes with an unjudged thread" "unjudged thread" "{$BASE,\"hint\":\"Reply: thanks\",\"threads\":[{\"id\":\"PRRT_1\",\"verdict\":\"unjudged\"}],\"routes\":[$R1]}"
bad_case "actor not allowed" "is not allowed for close" "{$BASE,\"hint\":\"Close: x\",\"routes\":[{\"id\":\"r1\",\"type\":\"close\",\"title\":\"Close: x\",\"as\":\"bot\",\"recommended\":true}]}"
bad_case "address_review without thread ids" "every thread needs an id" "{$BASE,\"hint\":\"Fix: x\",\"threads\":[{\"verdict\":\"valid\"}],\"routes\":[{\"id\":\"r1\",\"type\":\"address_review\",\"title\":\"Fix: x\",\"as\":\"agent\",\"recommended\":true}]}"
bad_case "address_review on a contributor PR" "Use take_over on a contributor PR" "{${BASE/maintainer/contributor},\"hint\":\"Fix: x\",\"threads\":[{\"id\":\"PRRT_1\",\"verdict\":\"valid\"}],\"routes\":[{\"id\":\"r1\",\"type\":\"address_review\",\"title\":\"Fix: x\",\"as\":\"agent\",\"recommended\":true}]}"
mk case "{${BASE/maintainer/contributor},\"takenOver\":true,\"hint\":\"Fix: x\",\"threads\":[{\"id\":\"PRRT_1\",\"verdict\":\"valid\"}],\"routes\":[{\"id\":\"r1\",\"type\":\"address_review\",\"title\":\"Fix: x\",\"as\":\"agent\",\"recommended\":true}]}"
expect "address_review on a taken-over contributor PR is fine" 0 '"ok":true' node $B put items pr-12 $H/case.json
node $B put items pr-12 $H/good.json > /dev/null
bad_case "drive on a contributor PR" "taken-over PRs" "{${BASE/maintainer/contributor},\"hint\":\"Drive: x\",\"routes\":[{\"id\":\"r1\",\"type\":\"drive\",\"title\":\"Drive: x\",\"as\":\"agent\",\"recommended\":true}]}"
bad_case "take_over replace without callout" "needs a callout" "{$BASE,\"hint\":\"Take over: x\",\"routes\":[{\"id\":\"r1\",\"type\":\"take_over\",\"title\":\"Take over: x\",\"as\":\"agent\",\"params\":{\"mode\":\"replace\"},\"recommended\":true}]}"
bad_case "finding names no route" 'names no route' "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[$R1],\"findings\":[{\"severity\":\"major\",\"text\":\"x\",\"routeId\":\"r3\"}]}"
bad_case "bot command in bot text" 'would post the command' "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"r1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"@widgets-bot escalate\",\"recommended\":true}]}"
bad_case "chore with merge" 'a chore cannot run' "{$BASE,\"hint\":\"Chore: x\",\"routes\":[{\"id\":\"r1\",\"type\":\"chore\",\"title\":\"Chore: x\",\"as\":\"bot\",\"params\":{\"action\":\"merge\"},\"recommended\":true}]}"
OPEN='{"id":"r1","type":"open","title":"Open: on GitHub","as":"me","recommended":true}'
mk case "{$BASE,\"hint\":\"Open: on GitHub\",\"blocked\":{\"reason\":\"safety_filter\",\"at\":\"2026-11-18T08:00:00Z\"},\"routes\":[$OPEN]}"
expect "a blocked item with one open route is fine" 0 '"ok":true' node $B put items pr-12 $H/case.json
mk case "{$BASE,\"hint\":\"Open: on GitHub\",\"routes\":[$OPEN]}"
expect "an open route without blocked is fine" 0 '"ok":true' node $B put items pr-12 $H/case.json
bad_case "analyzedBy with another value" "analyzedBy must be" "{$BASE,\"analyzedBy\":\"small\",\"hint\":\"Reply: thanks\",\"routes\":[$R1]}"
mk case "{$BASE,\"analyzedBy\":\"fallback\",\"hint\":\"Reply: thanks\",\"routes\":[$R1]}"
expect "analyzedBy fallback is fine" 0 '"ok":true' node $B put items pr-12 $H/case.json
bad_case "blocked with another route" "exactly one route, of type open" "{$BASE,\"hint\":\"Reply: thanks\",\"blocked\":{\"reason\":\"failed\",\"at\":\"2026-11-18T08:00:00Z\"},\"routes\":[$R1]}"
bad_case "blocked with a bad reason" "blocked must be" "{$BASE,\"hint\":\"Open: on GitHub\",\"blocked\":{\"reason\":\"tired\",\"at\":\"2026-11-18T08:00:00Z\"},\"routes\":[$OPEN]}"
bad_case "open with text" "no text and no params" "{$BASE,\"hint\":\"Open: on GitHub\",\"routes\":[{\"id\":\"r1\",\"type\":\"open\",\"title\":\"Open: on GitHub\",\"as\":\"me\",\"text\":\"hi\",\"recommended\":true}]}"
bad_case "open as bot" "is not allowed for open" "{$BASE,\"hint\":\"Open: on GitHub\",\"routes\":[{\"id\":\"r1\",\"type\":\"open\",\"title\":\"Open: on GitHub\",\"as\":\"bot\",\"recommended\":true}]}"
node $B put items pr-12 $H/good.json > /dev/null
mk case "{${BASE/\"kind\":\"pr\",\"number\":12/\"kind\":\"issue\",\"number\":21},\"hint\":\"Move: x\",\"routes\":[{\"id\":\"r1\",\"type\":\"move\",\"title\":\"Move: x\",\"params\":{\"to\":\"other-repo\"},\"recommended\":true}]}"
expect "put refuses: move target outside relatedRepos" 1 "not in the profile's relatedRepos" node $B put items issue-21 $H/case.json
expect "put takes any opaque id" 0 '"ok":true' node $B put items some.item_1 $H/good.json
expect "gary item finds a stored item by its doc" 0 '"openThreadCount": 3' node $B item some.item_1
node $B put items some.item_1 --delete > /dev/null
expect "put refuses an id that is not opaque-safe" 1 "Invalid document path" node $B put --no-validate items Bad/Id $H/good.json
mk case "{${BASE/acme\/widgets/acme\/other},\"hint\":\"Reply: thanks\",\"routes\":[$R1]}"
expect "put refuses a repo outside the instance" 1 "is not a repository of this instance" node $B put items pr-12 $H/case.json
mk case "{${BASE/\"repo\":\"acme\/widgets\",/},\"hint\":\"Reply: thanks\",\"routes\":[$R1]}"
expect "put refuses an item without repo" 1 "repo is required" node $B put items pr-12 $H/case.json
expect "refused writes leave the stored item alone" 0 '"Reply: thanks"' cat $ITEMS/pr-12.json
mk case "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"s1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"x\",\"recommended\":true}]}"
expect "put --no-validate writes anyway" 0 '"ok":true' node $B put --no-validate items pr-12 $H/case.json
expect "an item without routes needs no hint" 0 '"ok":true' zsh -c "print '{\"routes\":[],\"hint\":null,\"findings\":null}' > $H/c2.json; node $B put --merge items pr-12 $H/c2.json"
mk case "{$BASE,\"hint\":\"Approve: x\",\"threads\":[{\"id\":\"PRRT_1\",\"verdict\":\"valid\"}],\"routes\":[{\"id\":\"r1\",\"type\":\"review\",\"title\":\"Approve: x\",\"as\":\"bot\",\"params\":{\"event\":\"approve\"},\"recommended\":true},{\"id\":\"r2\",\"type\":\"merge\",\"title\":\"Merge: x\",\"as\":\"me\"}]}"
expect "approve while a thread is valid is a warning" 0 "warning: pr-12: routes[0] (r1): approves while a thread is judged valid" node $B put items pr-12 $H/case.json
expect "merge while a thread is valid is a warning" 0 "merges while a thread is judged valid" node $B put items pr-12 $H/case.json

# gary validate over stored items
mk case "{$BASE,\"hint\":\"Reply: thanks\",\"routes\":[{\"id\":\"s1\",\"type\":\"reply\",\"title\":\"Reply: thanks\",\"as\":\"bot\",\"text\":\"x\",\"recommended\":true}]}"
node $B put --no-validate items pr-12 $H/case.json > /dev/null
node $B put --no-validate items issue-21 $H/good.json > /dev/null 2>&1
expect "validate groups the problems" 1 "route-id" node $B validate
expect "validate counts" 1 "2 items checked, 1 fail" node $B validate
expect "validate one id" 1 "1 items checked, 1 fail" node $B validate pr-12
expect "validate --json" 1 '"failed": 1' node $B validate --json

# gary action takes kind, number and repo from the stored item
node $B put items pr-12 $H/good.json > /dev/null 2>&1
expect "action with an itemId uses the stored doc" 0 '"id": "PR_12"' zsh -c "print '{\"itemId\":\"pr-12\",\"action\":\"comment\",\"text\":\"x\"}' | node $B action --dry-run"
mk case "{${BASE/acme\/widgets/acme\/other},\"routes\":[]}"
node $B put --no-validate items foreign.1 $H/case.json > /dev/null 2>&1
expect "action refuses an item of a foreign repo" 1 "acme/other is not a repository of instance widgets" zsh -c "print '{\"itemId\":\"foreign.1\",\"action\":\"comment\",\"text\":\"x\"}' | node $B action --dry-run"
expect "action refuses an unknown itemId" 1 "is not on the board" zsh -c "print '{\"itemId\":\"nope\",\"action\":\"comment\",\"text\":\"x\"}' | node $B action --dry-run"
node $B put items foreign.1 --delete > /dev/null 2>&1

# gary action --autonomous
act() { print -r -- "$1" | node $B action --dry-run $2 }
expect "autonomous: a label from autoLabels" 0 "addLabelsToLabelable" act '{"action":"label","kind":"issue","number":21,"params":{"add":["needs-info"]}}' --autonomous
expect "autonomous: a label outside autoLabels" 1 "not in the profile's autoLabels" act '{"action":"label","kind":"issue","number":21,"params":{"add":["bug"]}}' --autonomous
expect "autonomous: removing a label outside autoLabels" 1 "not in the profile's autoLabels" act '{"action":"label","kind":"issue","number":21,"params":{"remove":["bug"]}}' --autonomous
expect "autonomous: assign" 0 "addAssigneesToAssignable" act '{"action":"assign","kind":"issue","number":21,"params":{"assignees":["octocat"]}}' --autonomous
expect "autonomous: a comment needs a click" 1 "needs a click on the board" act '{"action":"comment","kind":"issue","number":21,"text":"x"}' --autonomous
expect "without --autonomous any label runs" 0 "addLabelsToLabelable" act '{"action":"label","kind":"issue","number":21,"params":{"add":["bug"]}}'

rm -rf $H
print "validate: $pass passed, $fail failed"
[[ $fail == 0 ]]
