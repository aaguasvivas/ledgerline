# vhs tape: records docs/demo.gif (https://github.com/charmbracelet/vhs)
#
# Prereqs: `brew install vhs`, a running `npm run dev` on :8787, and
# /tmp/ledgerline-demo-env.sh exporting BASE, KEY, and SID (see README).
# Run with: vhs scripts/demo.tape

Output docs/demo.gif

Set Shell bash
Set FontSize 16
Set Width 960
Set Height 500
Set Padding 12
Set TypingSpeed 20ms

Hide
Type "source /tmp/ledgerline-demo-env.sh && clear"
Enter
Show

Type `# 1. append an event (Idempotency-Key: invoice-001)`
Enter
Type `curl -s -X POST $BASE/v1/streams/$SID/events -H "Authorization: Bearer $KEY" -H "Idempotency-Key: invoice-001" -H "Content-Type: application/json" -d '{"amount":100,"currency":"USD"}' | jq -c`
Enter
Sleep 2s

Type `# 2. retry the SAME key: original result, no new event`
Enter
Type `curl -si -X POST $BASE/v1/streams/$SID/events -H "Authorization: Bearer $KEY" -H "Idempotency-Key: invoice-001" -H "Content-Type: application/json" -d '{"amount":100,"currency":"USD"}' | grep -iE "idempotent-replay|seq"`
Enter
Sleep 2.5s

Type `# 3. verify the whole hash chain in one call`
Enter
Type `curl -s $BASE/v1/streams/$SID/verify -H "Authorization: Bearer $KEY" | jq -c`
Enter
Sleep 3s
