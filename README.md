# Render Deployment Status Action

[![build-test](https://github.com/AnandChowdhary/render-deployment-status-action/actions/workflows/test.yml/badge.svg)](https://github.com/AnandChowdhary/render-deployment-status-action/actions/workflows/test.yml)

## How it works

By default, when Render.com creates a PR environment, it adds a comment to your PR. We use the Render API to add a deployment and update its state.

<img width="921" alt="Screenshot of Render comment and deployment" src="https://github.com/AnandChowdhary/render-deployment-status-action/assets/2841780/5519f640-06dd-4a24-81f4-e25f5309cfe4">

Note that this action waits until the deployment is completed, so you will be billed for the minutes where it's essentially waiting for the deployment to be completed or errored.

## Workflow

Add you Render API key to the Actions secret `RENDER_API_KEY` and create a worklow `.github/workflows/render-deployment-status.yml`:

```yaml
name: Render deployment status

on:
  issue_comment:
    types: [created]

jobs:
  update:
    timeout-minutes: 15
    runs-on: ubuntu-latest
    permissions:
      deployments: write

    steps:
      - uses: AnandChowdhary/render-deployment-status-action@main
        with:
          render-api-key: ${{ secrets.RENDER_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

```

This workflow uses the latest version of this action and runs every time a new comment is made. The default GitHub token is used with "write" permission for "deployments".
