import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import {
  WebhookEvent,
  DeploymentEvent,
  DeploymentStatusEvent,
  WebhookEventMap,
} from '@octokit/webhooks-types';
import * as fs from 'fs';

// const token = process.env.GITHUB_TOKEN;

const MyOctokit = Octokit.plugin(restEndpointMethods);
const octokit = new MyOctokit();

const [owner, repo] = 'kghafari/testbot'.split('/');

export async function generateReleaseNotes() {
  //const deploymentEvent = getEvent() as DeploymentEvent;
  const deploymentStatusEvent = getEvent() as DeploymentStatusEvent;

  //printDeploymentEvent(deploymentEvent);
  printDeploymentStatusEvent(deploymentStatusEvent);

  if (
    deploymentStatusEvent.deployment_status.state === 'success' &&
    deploymentStatusEvent.deployment.environment === 'dev'
  ) {
    core.info('Dev deploy was successful!');
    core.info(`
      
      =====DEV DEPLOY SUCCESS====
      ID: ${deploymentStatusEvent.deployment.id}
      Action: ${deploymentStatusEvent.action}
      Workflow Html Url: ${deploymentStatusEvent.workflow.html_url}
      Environment: ${deploymentStatusEvent.deployment.environment}
      SHA: ${deploymentStatusEvent.deployment.sha}
      Ref: ${deploymentStatusEvent.deployment.ref}
      URL: ${deploymentStatusEvent.deployment.url}
      `);

    const latestRelease = await octokit.rest.repos.getLatestRelease({
      owner: owner,
      repo: repo,
    });

    core.info(` 
      
      ====LAST PROD RELEASE INFO====
      Name: ${latestRelease.data.name}
      Tag Name: ${latestRelease.data.tag_name}
      ID: ${latestRelease.data.id}
      URL: ${latestRelease.data.html_url}
      Created at: ${latestRelease.data.created_at}
      SHA: ${latestRelease.data.target_commitish}
      Tag: ${latestRelease.data.tag_name}
      Draft: ${latestRelease.data.draft}
      Prerelease: ${latestRelease.data.prerelease}
      Assets: ${latestRelease.data.assets.length}
      Assets URL: ${latestRelease.data.assets_url}
      Body: ${latestRelease.data.body}
      `);
  }

  // listDeployments();

  // 1.
  // GH_TOKEN

  // 2. Split early
  // we're either goign to go down the "beta deploy succes" path or the "prod deploy success" path
  // don't forget I'm using dev as "beta" for my personal project. This should probably be a config value

  // 3. Shared steps/values
  // 3.1. LAST_PROD_RELEASE
  // - tag, title, date, body, sha, url
  // 3.2 CURRENT_SUCCESSFUL_DEPLOYMENT
  // since we trigger on deploy, were gonna find the last successful deployment for a given environment

  //const lastSuccessfulDeploy = getLastSuccessfulDeploy('dev');
  // 4. beta steps/values
  // 4.1 Named draft release "v-next" in our example.
  // does it exist? create it if not. update it if it does.
  // Perhaps another config value
  // - tag, title, date, body, sha, url
}

function getEvent(): WebhookEvent {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH not defined');
  }
  const rawEvent = fs.readFileSync(eventPath, 'utf-8');

  try {
    return JSON.parse(rawEvent) as WebhookEvent;
  } catch (error) {
    core.setFailed(`This doesn't seem to be a deployment event 😭: ${error}`);
    return;
  }
}

function printDeploymentStatusEvent(event: DeploymentStatusEvent) {
  core.info(`
    ========= Deployment Status Details =========
    ID: ${event.deployment.id}
    Environment: ${event.deployment.environment}
    STATE: ${event.deployment_status.state}
    SHA: ${event.deployment.sha}
    Ref: ${event.deployment.ref}
    URL: ${event.deployment.url}
    Creator: ${event.deployment.creator?.login}
    Description: ${event.deployment.description || 'No description provided'}
    ======================================
  `);
}

function printDeploymentEvent(event: DeploymentEvent) {
  core.info(`
    ========= Deployment Details =========
    ID: ${event.deployment.id}
    SHA: ${event.deployment.sha}
    Ref: ${event.deployment.ref}
    URL: ${event.deployment.url}
    Environment: ${event.deployment.environment}
    Creator: ${event.deployment.creator?.login}
    Description: ${event.deployment.description || 'No description provided'}
    Payload?: ${event.deployment.payload}
    ======================================
  `);
}

async function listDeployments() {
  const repos = await octokit.rest.repos.listDeployments({
    per_page: 10,
    owner: owner,
    repo: repo,
  });

  core.info(JSON.stringify(repos.data, null, 2));
}

generateReleaseNotes();
