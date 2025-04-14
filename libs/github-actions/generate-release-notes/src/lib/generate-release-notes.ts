import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import {
  Api,
  restEndpointMethods,
} from '@octokit/plugin-rest-endpoint-methods';
import {
  WebhookEvent,
  DeploymentEvent,
  DeploymentStatusEvent,
} from '@octokit/webhooks-types';
import { throttling } from '@octokit/plugin-throttling';
import { createActionAuth } from '@octokit/auth-action';
import * as fs from 'fs';

// Things to pass as input:
// - owner
// - repo
// - draft release name

const octokit = configureOctokit();
const [owner, repo] = 'kghafari/testbot'.split('/'); // configure these to be passed in as inputs

export async function manageReleases() {
  // no matter what -

  // 1. Clear the draft release. We're going to regenerate it to keep life simple
  clearDraftRelease();

  // 2. Get the current workflow deploy sha
  const deploymentStatusEvent = getEvent() as DeploymentStatusEvent;
  const currentDeploymentSha = deploymentStatusEvent.deployment.sha;

  // 3. Get the last PROD release commitish -
  // This will resolve to either a tag or a commit sha. Both work to compare against.
  // Since this workflow is only run on 'success' deploy event,
  // this should always be last successful prod deployment.
  const latestRelease = await octokit.rest.repos.getLatestRelease({
    owner: owner,
    repo: repo,
  });
  const latestReleaseCommitish = latestRelease.data.target_commitish;

  // 4. Find the last successful beta deployment sha (?)
  const lastSuccessfulDevDeploymentSha =
    await getLastSuccessfulDevDeploymentSha(owner, repo);

  try {
    // -1. Get the sha comparisons
    // Beta current: latestReleaseCommitish..currentDeploymentSha
    // Prod current: latestReleaseCommitish..currentDeploymentSha

    // 0. Generate new draft release notes
    const draftBody = await buildReleaseNotes(
      latestReleaseCommitish,
      currentDeploymentSha,
      deploymentStatusEvent.deployment.environment,
      [] // oh boy
    );

    // 1. Create a new draft release Always.
    // If there's no commits, the body will be empty (for now). That's fine and expected.
    const newDraft = await octokit.rest.repos.createRelease({
      owner: owner,
      repo: repo,
      tag_name: `v-next`,
      name: `v-next`,
      body: draftBody,
      draft: true,
      prerelease: true,
    });
  } catch (error: any) {
    core.error('❌ An error occurred:');
    core.error(error.message);
    core.setFailed(error.message);
  }
}

manageReleases();

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

// DONE
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

// TODO: replace 'v-next' with input
async function clearDraftRelease() {
  core.info('✅ Checking for Draft release...');
  const { data: releases } = await octokit.rest.repos.listReleases({
    owner: owner,
    repo: repo,
    per_page: 50,
  });

  const draftRelease = releases
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find((release) => release.tag_name === 'v-next' && release.draft === true);

  if (draftRelease) {
    core.info(`🙋‍♀️ Removing Old Draft Release: ${draftRelease.name}... `);
    await octokit.rest.repos.deleteRelease({
      owner: owner,
      repo: repo,
      release_id: draftRelease.id,
    });
  } else {
    core.info('😢No draft release found to remove!');
  }
}

// TODO: replace 'environment: 'dev'' with input
async function getLastSuccessfulDevDeploymentSha(
  owner: string,
  repo: string,
  limit = 15
): Promise<string> {
  const deployments = await octokit.rest.repos.listDeployments({
    owner,
    repo,
    environment: 'dev',
    per_page: limit,
  });

  for (const deployment of deployments.data) {
    const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: deployment.id,
      per_page: 5, // Most deployments don't have tons of statuses
    });

    const wasSuccessful = statuses.find((s) => s.state === 'success');

    if (wasSuccessful) {
      core.info(`🏁Found last successful ${deployment.environment} deployment: 
        SHA: ${deployment.sha}
        URL: ${deployment.url}
        Environment: ${deployment.environment}
        ID: ${deployment.id}
        `);
      return deployment.sha;
    }
  }

  throw new Error(
    `No successful dev deployment found in last ${limit} deployments.`
  );
}

async function buildReleaseNotes(
  from: string,
  to: string,
  env: string,
  commits: any[]
) {
  let releaseNotes = `# Changelog from ${from} to ${to}\n\n`;
  // releaseNotes += `[Last Successful ${env} Deploy](${from})\n\n`;
  releaseNotes += await buildReleaseNotesBody(commits);
  core.info(`💸Release Notes:`);
  core.info(releaseNotes);
  return releaseNotes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildReleaseNotesBody(commits: any[]) {
  let releaseNotesBody = '';
  for (const commit of commits) {
    const commitSha = commit.sha;
    const shortSha = commitSha.slice(0, 7);
    const commitMessage = commit.commit.message.split('\n')[0];

    try {
      const prResponse =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: commitSha,
        });

      if (prResponse.data.length > 0) {
        const pr = prResponse.data[0];
        const prNum = pr.number;
        const prTitle = pr.title;
        const prAuthor = pr.user?.login || 'unknown';

        releaseNotesBody += `- [#${prNum}](https://github.com/${owner}/${repo}/pull/${prNum}): ${prTitle} (by @${prAuthor})\n`;
      } else {
        releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
      }
    } catch (err) {
      core.warning(`⚠️ Failed to get PR for ${commitSha}: ${err}`);
      releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
    }
  }
  return releaseNotesBody;
}
