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

const GITHUB_REPOSITORY = core.getInput('GITHUB_REPOSITORY'); // TODO: replace with input
const BETA_ENV = core.getInput('BETA_ENV'); // TODO: replace with input
const PROD_ENV = core.getInput('PROD_ENV'); // TODO: replace with input
const DRAFT_NAME = core.getInput('DRAFT_NAME'); // TODO: replace with input

const octokit = configureOctokit();
const [owner, repo] = GITHUB_REPOSITORY.split('/'); // configure these to be passed in as inputs

export async function manageReleases() {
  // -2. Testing file write
  octokit.rest.repos.createOrUpdateFileContents({
    owner: owner,
    repo: repo,
    path: './test.txt',
    message: 'Hello World!',
    content: 'Hello world content!',
  });

  // -1. Check inputs
  core.info(`GITHUB_REPOSITORY: ${GITHUB_REPOSITORY}`);
  core.info(`BETA_ENV: ${BETA_ENV}`);
  core.info(`PROD_ENV: ${PROD_ENV}`);
  core.info(`DRAFT_NAME: ${DRAFT_NAME}`);
  core.info(`Current ENV: ${process.env.GITHUB_ENV}`);

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
    // LAST_RELEASE..CURRENT_WF_SHA <- For prod release
    // CURRENT_WF_SHA..LAST_TO_BETA_SHA <- for maintaining draft
    if (deploymentStatusEvent.deployment.environment === BETA_ENV) {
      core.info(
        `🎊 Push to ${BETA_ENV} successful... Let's see what's new...\n\n`
      );
      const { data: diff } =
        await octokit.rest.repos.compareCommitsWithBasehead({
          owner: owner,
          repo: repo,
          basehead: `${latestReleaseCommitish}...${currentDeploymentSha}`,
        });

      core.info('Comparing from latest release to...current deployment\n');
      core.info(`${latestReleaseCommitish}...${currentDeploymentSha}`);

      // TODO: REMOVE THIS WHEN WE"RE DONE
      for (const commit of diff.commits) {
        core.info(JSON.stringify(commit, null, 2));
      }

      let draftBody = '=== CUSTOM NONPROD BODY STARTS HERE ===\n';
      draftBody += await buildReleaseNotesBody(diff.commits);
      const draftRelease = await octokit.rest.repos.createRelease({
        owner: owner,
        repo: repo,
        tag_name: DRAFT_NAME,
        name: DRAFT_NAME,
        body: draftBody,
        generate_release_notes: true,
        draft: true,
        prerelease: true,
        target_commitish: currentDeploymentSha,
      });
      core.info(
        `(dev/beta) Draft release created: ${draftRelease.data.html_url}`
      );
    } else if (deploymentStatusEvent.deployment.environment === PROD_ENV) {
      core.info(`🎊 Push to ${PROD_ENV} successful... Creating release...`);
      const releaseName = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, '')
        .replace('T', '-');

      const { data: diff } =
        await octokit.rest.repos.compareCommitsWithBasehead({
          owner: owner,
          repo: repo,
          basehead: `${latestReleaseCommitish}...${currentDeploymentSha}`,
        });

      core.info('Comparing from latest release to...current deployment\n');
      core.info(`${latestReleaseCommitish}...${currentDeploymentSha}`);
      for (const commit of diff.commits) {
        core.info(JSON.stringify(commit, null, 2));
      }

      let releaseBody = '=== CUSTOM PROD RELEASE BODY STARTS HERE ===\n';
      releaseBody += `Comparing: ${latestReleaseCommitish}..${currentDeploymentSha}\n`;
      releaseBody += 'Link to last successful deployment~~: \n\n';
      releaseBody += await buildReleaseNotesBody(diff.commits);
      await octokit.rest.repos.createRelease({
        owner: owner,
        repo: repo,
        tag_name: releaseName,
        name: releaseName,
        body: releaseBody,
        generate_release_notes: true, // i dont htink this works
        target_commitish: currentDeploymentSha,
      });

      core.info(`============BEGIN DRAFT RELEASE ==================\n\n`);

      // LOL we have to get latest again
      const latestReleaseResponse = await octokit.rest.repos.getLatestRelease({
        owner: owner,
        repo: repo,
      }); // last release to last beta sha

      // Create a new draft release with CURRENT_WF_SHA..LAST_TO_BETA_SHA <- for maintaining draft
      // If there's no commits, the body will be empty (for now). That's fine and expected.
      // egh idk if this still right uhhhh we want to look backwards from the last successful beta deployment sha to the current deployment sha
      const { data: draftDiff } =
        await octokit.rest.repos.compareCommitsWithBasehead({
          owner: owner,
          repo: repo,
          basehead: `${lastSuccessfulNonprodDeploymentSha}...${latestReleaseResponse.data.target_commitish}`,
        });

      core.info(
        'Comparing from lastSuccessfulNonprodDeploymentSha to...current latestReleaseResponse\n'
      );
      core.info(
        `${lastSuccessfulNonprodDeploymentSha}...${latestReleaseResponse.data.target_commitish}`
      );
      for (const commit of diff.commits) {
        core.info(JSON.stringify(commit, null, 2));
      }

      core.info('Comparing from latest release to...current deployment\n');
      core.info(`${latestReleaseCommitish}...${currentDeploymentSha}`);
      for (const commit of draftDiff.commits) {
        core.info(JSON.stringify(commit, null, 2));
      }

      core.info("🤔 Let's keep our draft up to date...");
      let draftBody =
        '=== CUSTOM NONPROD BODY STARTS HERE (Generated on Prod release) ===\n';
      draftBody += `Comparing: ${lastSuccessfulNonprodDeploymentSha}..${latestReleaseResponse.data.target_commitish}\n`;
      draftBody += await buildReleaseNotesBody(draftDiff.commits);
      const { data: newDraft } = await octokit.rest.repos.createRelease({
        owner: owner,
        repo: repo,
        tag_name: DRAFT_NAME,
        name: DRAFT_NAME,
        body: draftBody,
        generate_release_notes: true,
        draft: true,
        prerelease: true,
        target_commitish: currentDeploymentSha,
      });
      core.info(`Draft release created: ${newDraft.html_url}`);
    }
  } catch (error: any) {
    core.error('❌ An error occurred:');
    core.error(error);
    core.error(JSON.stringify(error));
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
  core.info(`✅ Checking ${GITHUB_REPOSITORY} for Draft release...`);
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
    core.info(`No latest release found. Using fallback: ${fallbackSha}`);
    return fallbackSha;
  }
}

// async function buildReleaseNotes(
//   from: string,
//   to: string,
//   env: string,
//   commits: any[]
// ) {
//   let releaseNotes = `# Changelog from ${from} to ${to}\n\n`;
//   // releaseNotes += `[Last Successful ${env} Deploy](${from})\n\n`;
//   releaseNotes += await buildReleaseNotesBody(commits);
//   core.info(`💸Release Notes:`);
//   core.info(releaseNotes);
//   return releaseNotes;
// }

interface Commit {
  sha: string;
  commit: {
    message: string;
    tree: object;
  };
}

async function buildReleaseNotesBody(commits: Commit[]) {
  core.info('📝Building release notes body for...');
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
        core.info(`Found PR for commit ${commitSha}: ${pr.title}`);
        releaseNotesBody += `- [#${prNum}](https://github.com/${owner}/${repo}/pull/${prNum}): ${prTitle} (by @${prAuthor})\n`;
      } else {
        core.info(`No PR found for commit ${commitSha}`);
        releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
      }
    } catch (err) {
      core.warning(`⚠️ Failed to get PR for ${commitSha}: ${err}`);
      releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
    }
  }
  core.info('📝Release notes body built!');
  return releaseNotesBody;
}
