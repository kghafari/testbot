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
    printDeploymentStatusEvent(deploymentStatusEvent);
    createOrUpdateDraftRelease(deploymentStatusEvent);
  } else if (
    deploymentStatusEvent.deployment_status.state === 'success' &&
    deploymentStatusEvent.deployment.environment === 'prod'
  ) {
    core.info('🚀Prod deploy was successful!');
    printDeploymentStatusEvent(deploymentStatusEvent);
    // manage releaase notes for prod
  } else {
    core.info('😵You seem to be lost. Skipping release notes generation.');
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

async function createOrUpdateDraftRelease(
  deploymentStatusEvent: DeploymentStatusEvent
) {
  const latestRelease = await octokit.rest.repos.getLatestRelease({
    owner: owner,
    repo: repo,
  });
  printReleaseInfo(latestRelease);

  const comparison = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: latestRelease.data.target_commitish,
    head: deploymentStatusEvent.deployment.sha,
  });

  const commits = comparison.data.commits;
  core.info(`🔢 Found ${commits.length} commits to process.`);

  let releaseNotes = `# Changelog from ${latestRelease.data.name} to ${deploymentStatusEvent.deployment.sha}\n\n`;
  releaseNotes += `[Last Successful Beta Deploy ${deploymentStatusEvent.deployment.sha}](${deploymentStatusEvent.workflow.html_url})\n`;

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

        releaseNotes += `- [#${prNum}](https://github.com/${owner}/${repo}/pull/${prNum}): ${prTitle} (by @${prAuthor})\n`;
      } else {
        releaseNotes += `- ${shortSha}: ${commitMessage}\n`;
      }
    } catch (err) {
      core.warning(`⚠️ Failed to get PR for ${commitSha}: ${err}`);
      releaseNotes += `- ${shortSha}: ${commitMessage}\n`;
    }
  }
  fs.writeFileSync('release_notes.md', releaseNotes);
  core.info('📝 Release notes written to release_notes.md');
  core.info(releaseNotes);

  // Create or update the draft release
  try {
    core.info('✅ Checking for Draft release...');
    const maybeDraft = await octokit.rest.repos.getReleaseByTag({
      owner: owner,
      repo: repo,
      tag: `v-next`,
    });

    if (maybeDraft.status === 200) {
      core.info('✅ Draft release 200!');
    }

    core.info('🛠 Draft Release Updating...');
    const updatedDraft = await octokit.rest.repos.updateRelease({
      owner: owner,
      repo: repo,
      release_id: maybeDraft.data.id,
      body: releaseNotes,
    });

    if (updatedDraft.status === 200) {
      core.info('🛠 UpdatedDraft 200!');
    }
  } catch (e) {
    core.info('❎ Draft release does not exist, creating a new one...');
    const newDraft = await octokit.rest.repos.createRelease({
      owner: owner,
      repo: repo,
      tag_name: `v-next`,
      name: `v-next`,
      body: releaseNotes,
      draft: true,
      prerelease: true,
    });

    if (newDraft.status === 201) {
      core.info('✅ Created NEW Draft release!');
    } else {
      core.info('❎ Failed to create Draft release!');
    }
  }
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
    STATE: ${
      event.deployment_status.state === 'success'
        ? '✅ Success'
        : event.deployment_status.state
    }
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

function printReleaseInfo(release: any) {
  core.info(` 
    ====LAST PROD RELEASE INFO====
    Name: ${release.data.name}
    Tag Name: ${release.data.tag_name}
    ID: ${release.data.id}
    URL: ${release.data.html_url}
    Created at: ${release.data.created_at}
    SHA: ${release.data.target_commitish}
    Tag: ${release.data.tag_name}
    Draft: ${release.data.draft}
    Prerelease: ${release.data.prerelease}
    Assets: ${release.data.assets.length}
    Assets URL: ${release.data.assets_url}
    Body: ${release.data.body}
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
