# Writing guide

Use this guide for interface text, the README, documentation and source comments.

- Name the task or state directly: “Pair a phone”, “No saved location”, “Connection failed”. Use the same term for the same action throughout the app and dashboard.
- Explain what happens and what the user should do next. An error should identify the failed action and a recovery step when one is known.
- Describe observable behavior. Replace broad claims about security or privacy with the mechanism, data destination or permission involved.
- Keep instructions close to the control they explain. Put detailed protocols and test procedures in their own documents and link to them.
- Write short paragraphs and use ordinary words. Prefer active voice and sentence-case headings. Use lists for steps and tables for comparisons.
- Remove slogans, repeated reassurance, stock introductions and decorative conclusions. Do not pad a sentence with synonyms for the same idea.
- Keep limits that affect a decision. State permission requirements, retention, irreversible deletion and missing verification plainly. Put a shared explanation in one place instead of repeating it on every screen.
- Document current behavior. Keep historical review findings in their review records; do not leave superseded release descriptions in setup instructions.
- Explain the reason for unusual code in comments. Preserve protocol details, security invariants, attribution and license notices.

Copy changes must preserve accessible labels, accurate destructive-action prompts and meaningful test assertions. Regenerate screenshots when visible text changes. Recheck technical claims against source; a writing edit must not turn a build result into a device-test claim.

## References

- [Google: Documentation best practices](https://google.github.io/styleguide/docguide/best_practices.html), especially keeping documentation current, removing dead material and avoiding duplication.
- [Microsoft: Top 10 tips for style and voice](https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice), especially leading with the task, brevity, everyday wording and sentence-case headings.
