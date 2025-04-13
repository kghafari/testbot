import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import {
  WebhookEvent,
  DeploymentEvent,
  DeploymentStatusEvent,
} from '@octokit/webhooks-types';
import { throttling } from '@octokit/plugin-throttling';
import { createActionAuth } from '@octokit/auth-action';

import * as fs from 'fs';

// TODO: I think we need to rethink the approach of searching for existing draft releases
// we should probably just create a new one every time and delete the old one if it exists
const MyOctokit = Octokit.plugin(restEndpointMethods, throttling);
const octokit = new MyOctokit({
  authStrategy: createActionAuth,
  // auth: process.env.GITHUB_TOKEN,
  throttle: {
    onRateLimit: (retryAfter, options) => {
      core.warning(
        `Request quota exhausted for request ${options.method} ${options.url}`
      );
      if (options.request.retryCount === 0) {
        core.info(`Retrying after ${retryAfter} seconds!`);
        return true; // true = retry the request
      }
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      core.warning(
        `Abuse detected for request ${options.method} ${options.url}`
      );
    },
  },
});

const [owner, repo] = 'kghafari/testbot'.split('/');

export async function generateReleaseNotes() {
  const deploymentStatusEvent = getEvent() as DeploymentStatusEvent;

  if (
    deploymentStatusEvent.deployment_status.state === 'success' &&
    deploymentStatusEvent.deployment.environment === 'dev'
  ) {
    core.info('🧪Dev deploy was successful!');
    createOrUpdateDraftRelease(deploymentStatusEvent);
  } else if (
    deploymentStatusEvent.deployment_status.state === 'success' &&
    deploymentStatusEvent.deployment.environment === 'prod'
  ) {
    core.info('🚀Prod deploy was successful!');
    doProdReleaseNotes(deploymentStatusEvent);
  } else {
    core.info('😵You seem to be lost. Skipping release notes generation.');
    core.info(
      `Triggering Actor: ${JSON.stringify(
        deploymentStatusEvent.workflow_run.triggering_actor
      )} 
      workflow url: ${deploymentStatusEvent.workflow_run.html_url}`
    );
    core.setFailed('This is not a deployment event! Whatever man!');
  }
}

async function createOrUpdateDraftRelease(
  deploymentStatusEvent: DeploymentStatusEvent
) {
  // Get the latest release
  const latestRelease = await octokit.rest.repos.getLatestRelease({
    owner: owner,
    repo: repo,
  });

  // Compare the latest release with the current deployment event sha
  const comparison = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: latestRelease.data.target_commitish,
    head: deploymentStatusEvent.deployment.sha,
  });

  if (comparison.data.status === 'identical') {
    core.info('No new commits since the last release. Skipping...');
    return;
  }

  const commits = comparison.data.commits;
  core.info(`🔢 Found ${commits.length} commits to process.`);
  const releaseNotes = await buildReleaseNotes(
    latestRelease.data.name,
    deploymentStatusEvent.deployment.sha,
    deploymentStatusEvent.deployment.environment,
    commits
  );

  // Create or update the draft release
  clearDraftRelease();

  core.info('✅ Creating new Draft release...');
  const newDraft = await octokit.rest.repos.createRelease({
    owner: owner,
    repo: repo,
    tag_name: `v-next`,
    name: `v-next`,
    body: releaseNotes,
    target_commitish: deploymentStatusEvent.deployment.sha,
    draft: true,
    prerelease: true,
  });

  if (newDraft.status === 201) {
    core.info('✅ Created NEW Draft release!');
  } else {
    core.info('❌ Failed to create Draft release!');
  }
}

async function doProdReleaseNotes(
  deploymentStatusEvent: DeploymentStatusEvent
) {
  // Last prod release
  const latestRelease = await octokit.rest.repos.getLatestRelease({
    owner: owner,
    repo: repo,
  });

  // Last successful beta deployment sha (dev now)
  const lastSuccessfulBetaDeploySha = await getLastSuccessfulDevDeploymentSha(
    owner,
    repo
  );

  // if there are commits, we need to create a new release with the new notes
  // and update the draft release with the new notes. That has the new difference between beta and prod
  const currentToBetaComparison = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: lastSuccessfulBetaDeploySha,
    head: deploymentStatusEvent.deployment.sha,
  });

  clearDraftRelease();

  if (currentToBetaComparison.data.status === 'identical') {
    core.info(
      `🔎in the 'identical' block, here's the commits ${currentToBetaComparison.data.commits}`
    );
    // this means that the beta and prod are the same, so we can create a new release
    // more or less unchanged
    core.info(
      'No differences between beta and prod. Releasing existing draft! 😎'
    );

    try {
      const { data: comparison } = await octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: latestRelease.data.target_commitish,
        head: deploymentStatusEvent.deployment.sha,
      });

      const releaseNotes = await buildReleaseNotes(
        latestRelease.data.name,
        deploymentStatusEvent.deployment.sha,
        deploymentStatusEvent.deployment.environment,
        comparison.commits
      );

      const date = new Date();
      const { data: prodRelease } = await octokit.rest.repos.createRelease({
        owner: owner,
        repo: repo,
        draft: false,
        prerelease: false,
        make_latest: 'true',
        body: releaseNotes,
        tag_name: `${date
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, '')
          .replace('T', '-')}`,
        name: date.toLocaleString('en-US', {
          timeZone: 'America/New_York',
        }),
        target_commitish: deploymentStatusEvent.deployment.sha,
      });
      core.info(`🚀🚀🚀 Prod released!
        Release ID: ${prodRelease.id}
        Release URL: ${prodRelease.html_url}
        Release Name: ${prodRelease.name}
        Release Tag: ${prodRelease.tag_name}
        `);
    } catch (e) {
      core.info('❎ Failed to update Draft release!');
      core.info(e);
    }
  } else {
    // TODO: UPDATE THE EXISTING DRAFT RELEASE WITH THE NEW NOTES - THIS IS THE IMPORTANT PART
    // NEED TO DIFF BETWEEN BETA AND PROD
    // put this in a func later

    // Rebuild the draft release
    core.info(
      `🔎in the 'NOT identical' block, here's the commits ${currentToBetaComparison.data.commits}`
    );

    core.info('📝 Looks like theres some changes still in beta...');
    const draftNotes = await buildReleaseNotes(
      lastSuccessfulBetaDeploySha,
      deploymentStatusEvent.deployment.sha,
      deploymentStatusEvent.deployment.environment,
      currentToBetaComparison.data.commits
    );

    await octokit.rest.repos.createRelease({
      owner: owner,
      repo: repo,
      draft: true,
      prerelease: true,
      body: draftNotes,
      tag_name: 'v-next',
      name: 'v-next',
      target_commitish: deploymentStatusEvent.deployment.sha,
    });
    core.info('📝 Recreated draft release...');

    // create a new release with the new notes
    const { data: comparison } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: latestRelease.data.target_commitish,
      head: deploymentStatusEvent.deployment.sha,
    });

    const releaseNotes = await buildReleaseNotes(
      latestRelease.data.name,
      deploymentStatusEvent.deployment.sha,
      deploymentStatusEvent.deployment.environment,
      comparison.commits
    );

    const date = new Date();
    const newRelease = await octokit.rest.repos.createRelease({
      owner: owner,
      repo: repo,
      make_latest: 'true',
      tag_name: `${date
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, '')
        .replace('T', '-')}`,
      name: date.toLocaleString('en-US', {
        timeZone: 'America/New_York',
      }),
      body: releaseNotes,
      target_commitish: deploymentStatusEvent.deployment.sha,
    });

    core.info('✅ Created new release!');
    core.info(`Release ID: ${newRelease.data.name}`);
    core.info(`Release URL: ${newRelease.data.html_url}`);
  }
}

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

async function clearDraftRelease() {
  core.info('✅ Checking for Draft release...');
  const { data: releases } = await octokit.rest.repos.listReleases({
    owner: owner,
    repo: repo,
    per_page: 50,
  });

  const maybeDraft = releases
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find((release) => release.tag_name === 'v-next' && release.draft === true);

  if (maybeDraft) {
    core.info(`🙋‍♀️ Removing Old Draft Release: ${maybeDraft.name}... `);
    await octokit.rest.repos.deleteRelease({
      owner: owner,
      repo: repo,
      release_id: maybeDraft.id,
    });
  } else {
    core.info('😢No draft release found to remove!');
  }
}

generateReleaseNotes();
