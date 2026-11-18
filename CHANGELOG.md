# Changelog

## 0.1.1

- The extension's homepage is https://entire.com, so its Open VSX listing links to the Entire website.

## 0.1.0

Initial release.

- Checkpoints view that lists each commit on the current branch with an `Entire-Checkpoint` trailer, including commits that carry several checkpoints and checkpoints that no commit on the branch carries.
- Sessions view that merges running sessions, local session state, and sessions referenced by checkpoints, each with its checkpoints under it. For a repository whose `origin` uses the `entire://` scheme, the view lists the sessions as entire.com does: every session on every branch, under the name Entire gave it, with the checkpoints Entire lists for it. In any other repository, each session is named by the prompt that opened it.
- Detail panel with the commit, the files touched with diffs, and a transcript whose tool calls expand to show their input and result. Each prompt in the transcript names the person who sent it.
- Each checkpoint's place in its session, such as 12 of 249, on its row and in the detail panel, with Previous and Next to step through the session. The selected row in the sidebar moves to the checkpoint the tab steps to.
- A checkpoint whose session data was never uploaded opens on its commit and diff, with a note that says why there is no transcript.
- Open on entire.com for commits, sessions, and trails in repositories whose `origin` uses the `entire://` scheme.
- Trails view for those repositories, which lists the trails that touch the repository and marks the trail on the checked-out branch. A filter shows only the trails in one state: all, open, closed, or an open trail's phase of planning, building, or complete. The `entire.trails.enabled` setting turns trails off.
- Trail panel with the trail's description, the merge gates and CI runs of each change, and a timeline whose commits open their checkpoints. The panel draws the trail's title at once and fills in the changes and the timeline as the Entire CLI returns them. A trail opened earlier in the same window shows from that read while the panel reads it again.
- Brain view, collapsed until you open it, with what the entire-brain plugin reports about the repository's brain. Its View Brain button starts the plugin's graph page for the repository and opens it in the browser.
- Open Raw Transcript for the stored transcript in the agent's own format.
- Lists that show 50 rows at a time and load the next 50 when you scroll to the end, with a Load More row to click as well. The extension reads further back in the commit history only when a page needs it.
