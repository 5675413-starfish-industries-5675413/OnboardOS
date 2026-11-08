# Continuous integration

This repository does not yet include a GitHub Actions workflow file. Verification is local:

```sh
npm ci
npm run verify
```

`npm run verify` typechecks the workspaces and scripts, builds the web app, runs the test suite, and runs `sam build`. The SAM step needs the AWS SAM CLI. It does not deploy a stack.

Deploy the hackathon environment through one authorized owner. Prefer short-lived credentials over static AWS keys in GitHub secrets.
