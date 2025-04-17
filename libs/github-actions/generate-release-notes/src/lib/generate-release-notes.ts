import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import {
  Api,
  restEndpointMethods,
} from '@octokit/plugin-rest-endpoint-methods';
import { WebhookEvent, DeploymentStatusEvent } from '@octokit/webhooks-types';
import { throttling } from '@octokit/plugin-throttling';
import { createActionAuth } from '@octokit/auth-action';
import * as fs from 'fs';

const octokit = configureOctokit();

const GITHUB_REPOSITORY = core.getInput('GITHUB_REPOSITORY');
const BETA_ENV = core.getInput('BETA_ENV');
const PROD_ENV = core.getInput('PROD_ENV');
const DRAFT_NAME = core.getInput('DRAFT_NAME');

const [owner, repo] = GITHUB_REPOSITORY.split('/');

export async function manageReleases() {
  // 0. Clear the draft release. We're going to regenerate it to keep life simple
  await clearDraftRelease();

  // 1. Get the current workflow deploy sha
  const deploymentStatusEvent = getEvent() as DeploymentStatusEvent;
  const currentDeploymentSha = deploymentStatusEvent.deployment.sha;

  // 2. Find the last successful beta deployment sha (?)
  const lastSuccessfulNonprodDeploymentSha =
    await getLastSuccessfulDeploymentSha(owner, repo, BETA_ENV);

  // 3. Get the last PROD release commitish
  const latestReleaseCommitish = await getLatestReleaseCommitish(
    owner,
    repo,
    lastSuccessfulNonprodDeploymentSha
  );

  try {
    // 4. On beta deploy create/update the rolling draft release
    if (deploymentStatusEvent.deployment.environment === BETA_ENV) {
      await createRelease(
        deploymentStatusEvent,
        BETA_ENV,
        latestReleaseCommitish,
        currentDeploymentSha,
        DRAFT_NAME,
        true
      );
    }
    // 5. On prod deploy create a release
    else if (deploymentStatusEvent.deployment.environment === PROD_ENV) {
      const releaseName = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, '')
        .replace('T', '-');

      await createRelease(
        deploymentStatusEvent,
        PROD_ENV,
        latestReleaseCommitish,
        currentDeploymentSha,
        releaseName,
        false
      );

      // 6. Compare the latest release to the last successful nonprod deployment
      // This keeps track of beta deployments that are not yet released to prod
      core.info(`============BEGIN DRAFT RELEASE ==================\n\n`);
      // Need to create a new draft release with the latest release commitish as the base
      const latestReleaseResponse = await octokit.rest.repos.getLatestRelease({
        owner: owner,
        repo: repo,
      });

      await createRelease(
        deploymentStatusEvent,
        BETA_ENV,
        latestReleaseResponse.data.target_commitish,
        lastSuccessfulNonprodDeploymentSha,
        DRAFT_NAME,
        true
      );
    }
  } catch (error: any) {
    core.error('❌ An error occurred:');
    core.error(error);
    core.error(JSON.stringify(error));
    core.setFailed(error.message);
  }
}

manageReleases();

async function createRelease(
  deploymentStatusEvent: DeploymentStatusEvent,
  env: string,
  from: string,
  to: string,
  name: string,
  draft = true
): Promise<void> {
  core.info(`🎊 Push to ${env} successful... Creating release...`);
  const { data: diff } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: owner,
    repo: repo,
    basehead: `${from}...${to}`,
  });

  core.info('Comparing from latest release to...current deployment\n');
  core.info(`${from}...${to}`);

  let body = '=== CUSTOM RELEASE BODY STARTS HERE ===\n';
  body += `## Last ${env} deployment from ${deploymentStatusEvent.workflow.html_url}\n`;
  body += await buildReleaseNotesBody(diff.commits);
  const { data: release } = await octokit.rest.repos.createRelease({
    owner: owner,
    repo: repo,
    tag_name: name,
    name: name,
    body: body,
    draft: draft ? true : false,
    prerelease: draft ? true : false,
    target_commitish: to,
  });
  core.info(`Draft release created: ${release.html_url}`);
}

// TODO: Check if retryAfter has configured values
function configureOctokit(): Octokit & Api {
  const MyOctokit = Octokit.plugin(restEndpointMethods, throttling);
  const octokit = new MyOctokit({
    authStrategy: createActionAuth,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        core.warning(
          `Request quota exhausted for request ${options.method} ${options.url}`
        );
        if (options.request.retryCount === 0) {
          core.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (_retryAfter, options) => {
        core.warning(
          `Abuse detected for request ${options.method} ${options.url}`
        );
      },
    },
  });

  return octokit;
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
    throw new Error("This doesn't seem to be a deployment event 😭");
  }
}

async function clearDraftRelease() {
  core.info(`✅ Checking ${GITHUB_REPOSITORY} for draft release...`);
  const { data: releases } = await octokit.rest.repos.listReleases({
    owner: owner,
    repo: repo,
    per_page: 50,
  });

  const draftRelease = releases
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find(
      (release) => release.tag_name === DRAFT_NAME && release.draft === true
    );

  if (
    draftRelease &&
    draftRelease.name === DRAFT_NAME &&
    draftRelease.draft === true
  ) {
    core.info(`🙋‍♀️ Removing Old Draft Release: ${draftRelease.name}... `);
    await octokit.rest.repos.deleteRelease({
      owner: owner,
      repo: repo,
      release_id: draftRelease.id,
    });
  } else {
    core.info('No draft release found to remove!');
  }
}

async function getLastSuccessfulDeploymentSha(
  owner: string,
  repo: string,
  env: string,
  limit = 15
): Promise<string> {
  core.info(`🔍 Finding last successful deployment for ${env}...`);

  try {
    const deployments = (
      await octokit.rest.repos.listDeployments({
        owner,
        repo,
        environment: env,
        per_page: limit,
      })
    ).data.sort((a, b) => b.created_at.localeCompare(a.created_at));

    for (const deployment of deployments) {
      core.info(`Checking deployment ${deployment.id}...`);
      core.info(`Timestamp: ${deployment.created_at}`);
      const { data: statuses } =
        await octokit.rest.repos.listDeploymentStatuses({
          owner,
          repo,
          deployment_id: deployment.id,
          per_page: 5, // Most deployments don't have tons of statuses
        });

      const wasSuccessful = statuses.find((s) => s.state === 'success');

      statuses.find((s) => s.state === 'success');

      if (wasSuccessful) {
        core.info(`🏁Found last successful ${deployment.environment} deployment: 
          SHA: ${deployment.sha}
          URL: ${deployment.url}
          Environment: ${deployment.environment}
          Log URL: ${wasSuccessful.log_url}
          Target URL: ${wasSuccessful.target_url} // keep this
          `);
        return deployment.sha;
      }
    }
  } catch (err) {
    core.setFailed(`No successful ${env} deployments found 😵💫`);
  }
}

async function getLatestReleaseCommitish(
  owner: string,
  repo: string,
  fallbackSha: string = ''
): Promise<string> {
  try {
    core.info(`🔍 Finding latest release commitish...`);
    const latestReleaseResponse = await octokit.rest.repos.getLatestRelease({
      owner: owner,
      repo: repo,
    });
    core.info(`found: ${latestReleaseResponse.data.target_commitish}`);
    return latestReleaseResponse.data.target_commitish;
  } catch {
    // TODO: Better handling
    core.info(`No latest release found. Using fallback: ${fallbackSha}`);
    return fallbackSha;
  }
}

interface Commit {
  sha: string;
  commit: {
    message: string;
    tree: object;
  };
}

async function buildReleaseNotesBody(commits: Commit[]) {
  core.info('📝Building release notes body...');
  let releaseNotesBody = '';
  if (commits.length === 0) {
    core.info('No commits found!');
    return '';
  }

  for (const commit of commits) {
    const commitSha = commit.sha;
    const shortSha = commitSha.slice(0, 7);
    const commitMessage = commit.commit.message.split('\n')[0];
    core.info(`checking ${shortSha} for PR...`);
    try {
      const { data: prResponse } =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: commitSha,
        });

      if (prResponse.length > 0) {
        const pr = prResponse[0];
        const prNum = pr.number;
        const prTitle = pr.title;
        const prAuthor = pr.user?.login || 'unknown';
        core.info(
          `Found PR for commit ${commitSha} - ${prTitle} by @${prAuthor} in [${prNum}](https://github.com/${owner}/${repo}/pull/${prNum})\n`
        );
        releaseNotesBody += `- # ${prTitle} by @${prAuthor} in [${prNum}](https://github.com/${owner}/${repo}/pull/${prNum})\n`;
      } else {
        core.warning(`⚠️ Failed to get PR for ${commitSha}`);
        releaseNotesBody += `- ${shortSha} - ${commitMessage}\n`;
      }
    } catch (err) {
      core.warning(`⚠️ Failed to get PR for ${commitSha}: ${err}`);
      releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
    }
  }
  return releaseNotesBody;
}
