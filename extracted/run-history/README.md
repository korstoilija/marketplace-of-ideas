# run-history — durable export of the live database

`data/marketplace.sqlite` is gitignored, and a database recreation earlier in this
project destroyed 29 human rulings (FINDINGS.md §3.4). This directory is the lesson
applied: the run record exported to git-tracked JSON so a schema change cannot delete it.

| File | Rows | Contents |
|---|---|---|
| `sessions.json` | 8 | deliberation sessions with start/end times |
| `ideas-claims-markets.json` | 105 | ideas, their claims, and final LMSR share quantities |
| `transcripts.json` | 78 | **every agent iteration: the JavaScript written and its stdout** (stdout truncated to 2KB) |

There is no `adjudications.json`: the current database contains **zero** human rulings.
The 29 that produced the 0.44 informativeness result were lost with the earlier database.

`transcripts.json` is the interesting file — it is the primary evidence that agents
write working code unassisted, and the raw material for any future analysis of *which*
code-writing patterns actually earned value.

Regenerate after future runs:
```bash
sqlite3 data/marketplace.sqlite -json "SELECT session_id,agent_id,depth,iteration,code,substr(stdout,1,2000) AS stdout,timed_out,has_final FROM agent_iterations ORDER BY id;" > extracted/run-history/transcripts.json
```
