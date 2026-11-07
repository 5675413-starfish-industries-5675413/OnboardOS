# CI workflow creation

Do not enable a CI workflow that only appears green because the application packages and tests do not exist. Once root npm scripts are configured, add a GitHub Actions workflow that checks out the repo, sets up the pinned Node.js version, runs `npm ci`, and runs `npm run verify` on pushes to `main` and pull requests.

Deploy the hackathon environment through one authorized owner after verifying IAM privileges. Prefer short-lived credentials / scoped roles over static AWS keys in GitHub secrets.
