# Contributing Guidelines

Thank you for your interest in contributing to this project. Whether it's a bug
report, new feature, correction, or additional documentation, we greatly value
feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to
ensure we have all the necessary information to effectively respond to your bug
report or contribution.

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make
sure somebody else hasn't already reported the issue. Please try to include as much
information as you can. Details like these are incredibly useful:

- A reproducible test case or series of steps
- The version of the code being used
- Any modifications you've made relevant to the bug
- Anything unusual about your environment or deployment
- The AWS region you deployed to, and whether the deployment reached
  `runtime: READY / endpoint: READY`

## Contributing via Pull Requests

Contributions via pull requests are much appreciated. Before sending us a pull
request, please ensure that:

1. You are working against the latest source on the `main` branch.
2. You check existing open, and recently merged, pull requests to make sure someone
   else hasn't addressed the problem already.
3. You open an issue to discuss any significant work — we would hate for your time
   to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing.
3. Ensure local checks pass:

   ```bash
   # Container layer unit tests
   cd docker && node --test test/*.test.js

   # Lambda token signing tests
   cd lambda && node --test test/*.test.js

   # CDK type check
   cd infra && npx tsc --noEmit

   # Shell scripts parse cleanly
   bash -n scripts/deploy.sh
   bash -n scripts/run-deploy.sh
   ```

4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request
   interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay
   involved in the conversation.

### Things that will be checked closely

- **No account-specific values.** No AWS account IDs, CloudFront domains, WeCom bot
  IDs or real user identifiers in code, tests, or docs. `scripts/package-delivery.sh`
  scans for these and fails the build if any are found.
- **Docs stay bilingual-consistent.** Documentation lives in `docs/` as
  `<topic>_zh.md` / `<topic>_en.md` pairs. If you change one, update the other.
- **Deployment stays idempotent.** `scripts/deploy.sh` must be safe to re-run after a
  partial failure.

## Finding contributions to work on

Looking at the existing issues is a great way to find something to contribute on.
Issues labelled `help wanted` or `good first issue` are a great place to start.

## Security issue notifications

If you discover a potential security issue in this project, please report it privately
via GitHub's **Report a vulnerability** button (Security tab) so it can be fixed before
it becomes public. Please do **not** create a public GitHub issue.

Note that this project handles WeCom credentials, which grant access to a user's
contacts, documents and calendar. Treat any credential-handling bug as security
sensitive.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing (MIT No Attribution). We
will ask you to confirm the licensing of your contribution.
