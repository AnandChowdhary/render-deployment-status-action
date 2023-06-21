import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'
import axios from 'axios'
import {wait} from './wait'

interface Deploy {
  id: string
  commit: {
    id: string
    message: string
    createdAt: string
  }
  status: 'live' | 'deactivated' | 'build_failed'
  createdAt: string
  updatedAt: string
  finishedAt: string
}

interface Data {
  deploy: Deploy
  cursor: string
}

/**
 * Parses the comment body from a Render PR comment
 * @param commentBody - The comment body to parse
 * @returns - An object containing the parsed comment body
 * @example
 * const commentBody = `
 * Your [Render](https://render.com) PR Server URL is {serverUrl}.
 * Follow its progress at https://dashboard.render.com/{serviceName}/{serviceId}.
 * `
 * const {serverUrl, serviceName, serviceId, dashboardUrl} = parseCommentBody(commentBody)
 */
function parseCommentBody(commentBody: string): {
  serverUrl: string
  serviceName: string
  serviceId: string
  dashboardUrl: string
} {
  const matches = commentBody.match(
    /PR Server URL is (?<serverUrl>https:\/\/api-pr-[0-9a-z-]+.onrender.com)/i
  )
  if (!matches?.groups?.serverUrl) throw new Error('No server URL found')
  const serverUrl = matches.groups.serverUrl

  const serviceName = commentBody.match(
    /https:\/\/dashboard.render.com\/(?<serviceName>[a-z0-9-]+)\/(?<serviceId>[a-z0-9-]+)/i
  )?.groups?.serviceName
  if (!serviceName) throw new Error('No service name found')

  const serviceId = commentBody.match(
    /https:\/\/dashboard.render.com\/(?<serviceName>[a-z0-9-]+)\/(?<serviceId>[a-z0-9-]+)/i
  )?.groups?.serviceId
  if (!serviceId) throw new Error('No service ID found')

  const dashboardUrl = `https://dashboard.render.com/${serviceName}/${serviceId}`
  return {serverUrl, serviceName, serviceId, dashboardUrl}
}

async function run(): Promise<void> {
  try {
    const apiKey: string =
      core.getInput('render-api-key') || process.env.RENDER_API_KEY || ''
    const render = axios.create({
      baseURL: 'https://api.render.com/v1',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })

    // Get comment body
    const commentBody = context.payload.comment?.body
    if (!commentBody) throw new Error('No comment body found')
    core.debug(`Using comment body: ${commentBody}`)

    // Make sure comment is from Render
    if (
      !commentBody.includes(
        'Your [Render](https://render.com) PR Server URL is'
      )
    )
      return core.debug('Comment is not from Render, skipping')

    const {serverUrl, serviceName, serviceId, dashboardUrl} =
      parseCommentBody(commentBody)
    core.debug(`Using server URL: ${serverUrl}`)
    core.debug(`Using service name: ${serviceName}`)
    core.debug(`Using service ID: ${serviceId}`)
    core.debug(`Using dashboard URL: ${dashboardUrl}`)
    core.setOutput('server-url', serverUrl)
    core.setOutput('service-name', serviceName)
    core.setOutput('service-id', serviceId)
    core.setOutput('dashboard-url', dashboardUrl)

    core.debug(`Getting deploys: /services/${serviceId}/deploys?limit=20`)
    const {data} = await render.get<Data[]>(
      `/services/${serviceId}/deploys?limit=20`
    )
    core.debug(`Got deploys: ${data.length}`)
    if (!data.length) throw new Error('No deploys found')

    // Get the most recent deploy
    const {deploy} = data.sort(
      (a, b) =>
        new Date(b.deploy.createdAt).getTime() -
        new Date(a.deploy.createdAt).getTime()
    )[0]

    // Create GitHub deployment
    core.debug(`Creating GitHub deployment for ${serviceName} - ${deploy.id}`)
    const octokit = getOctokit(core.getInput('github-token'))
    const {data: deployment} = await octokit.rest.repos.createDeployment({
      ...context.repo,
      ref: deploy.commit.id,
      environment: 'preview',
      description: `Preview deployment for ${context.payload.pull_request?.head.sha} on Render`,
      transient_environment: true,
      auto_merge: false
    })
    if (!('id' in deployment)) throw new Error('No deployment ID found')
    core.debug(`Created GitHub deployment ${deployment.id}`)
    core.setOutput('deployment-id', deployment.id.toString())

    let status: 'pending' | 'success' | 'inactive' | 'failure' = 'pending'
    let attempts = 0
    while (status === 'pending') {
      // Check if we've exceeded the max number of attempts
      if (attempts > 100) {
        core.debug('Exceeded max number of attempts, failing')
        await octokit.rest.repos.createDeploymentStatus({
          ...context.repo,
          deployment_id: deployment.id,
          state: 'failure',
          description: 'Exceeded max number of attempts'
        })
        return
      }

      // Get deploy status
      core.debug(`Getting deploy status for ${deploy.id}`)
      const {data: deployStatus} = await render.get<Deploy>(
        `/services/${serviceId}/deploys/${deploy.id}`
      )
      core.debug(`Got deploy status: ${deployStatus.status}`)
      if (deployStatus.status === 'live') status = 'success'
      if (deployStatus.status === 'build_failed') status = 'failure'
      if (deployStatus.status === 'deactivated') status = 'inactive'

      // Create GitHub deployment status
      core.debug(`Creating GitHub deployment status for ${deployment.id}`)
      await octokit.rest.repos.createDeploymentStatus({
        ...context.repo,
        deployment_id: deployment.id,
        state: status,
        log_url: dashboardUrl,
        environment_url: deploy.status === 'live' ? serverUrl : undefined,
        description:
          deploy.status === 'build_failed' ? 'Build failed' : undefined
      })

      if (status === 'pending') {
        core.debug('Waiting 5 seconds before checking deploy status again')
        attempts++
        wait(5000)
      }

      if (status === 'success') {
        core.debug('Deploy succeeded')
        core.setOutput(status, 'success')
        return
      }

      if (status === 'failure') {
        core.debug('Deploy failed')
        core.setOutput(status, 'failure')
        return
      }
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
