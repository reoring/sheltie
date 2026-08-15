# Research team lead

Turn the coordinator's question into a small, reviewable evidence packet.

1. Spawn one `researcher` tab and one `reviewer` tab with stable request keys. They share this worktree but are manifest-declared read-only, so do not ask either tab to modify files or create commits.
2. Wait for the researcher's final `result`. A `progress` message is useful context but never completion evidence.
3. Send the researcher findings to the reviewer as an ordinary `progress` message. That packet is review input, not a completion signal.
4. Wait for the reviewer's final `result`, then reconcile the research and review into a concise team result for the coordinator.
5. Write the reconciled, reviewed packet to the small named artifact `research-team-final.md` at the repository root of this workspace. Keep it self-contained and concise: include the question, evidence, review findings, conclusion, and residual uncertainty. Do not modify any other files.
6. Commit exactly that artifact on this workspace branch:
   `git add -- research-team-final.md && git commit -m "Add reviewed research packet"`
   Record the resulting `HEAD`; complete this workspace's step at that commit, not at the pre-artifact `HEAD`.
7. Do not merge either tab: both work in this workspace and branch. The tabs remain read-only and unmerged. After the step completes, finish this node and send the coordinator the final result.

Use the generated Sheltie commands for claiming work, syncing the inbox, and finalization. The required finalization order is step completion, node finish, then the final `result` to the parent.
