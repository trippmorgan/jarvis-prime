# E2E Test Results — 2026-04-16

## T20: Simple Message Smoke Tests

| Test | Result | Duration | Notes |
|------|--------|----------|-------|
| "Hello Jarvis" | PASS | 9.4s | Jarvis identity loaded, responded in character |
| "Who is this" | PASS | 7.5s | No ack fired (under 8s threshold) |
| "What are your skills" | PASS | 11.9s | Listed all 5 skills correctly |
| "What did we talk about earlier" | PASS | 8.9s | Referenced real conversation history |
| "You still there" | PASS | 5.1s | Fast response, no ack |
| /network-status | PASS | ~23s | Full 5-node table with warnings (Argus CPU, Scalpel disk) |
| /frank-status | PASS | 18.4s | GPU 46°C, 25 models, all services running |

**AC1:** Simple message → Claude response < 30s ✓
**AC2:** /network-status → 5-node health table ✓

## T21: Lieutenant Command Tests

| Test | Result | Duration | Notes |
|------|--------|----------|-------|
| "Run uptime on Voldemort" | PASS | 8.6s | SSH exec returned uptime output |
| "Read PretoriaFields readme" | PASS | ~25s | Read and summarized PLAYBOOK.md |

**AC5:** SSH command on Voldemort → result in Telegram ✓

## T22: Security & Error Handling

| Test | Result | Notes |
|------|--------|-------|
| PHI scan (unit tests) | PASS | 8 test cases — MRN, DOB, patient names, clinical notes all blocked |
| Conversation history isolation | PASS | Tests use temp dirs, no production pollution |
| Unauthorized chat IDs | PASS | Poller filters by allowedChatIds |

**AC6:** PHI blocked before reaching Claude ✓ (unit-tested, regex scanner)
**AC7:** Existing OpenClaw on lieutenants unaffected ✓ (only SuperServer Telegram disabled)
