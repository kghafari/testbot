import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { throttling } from '@octokit/plugin-throttling';
import { createActionAuth } from '@octokit/auth-action';
import * as fs from 'fs';
const MyOctokit = Octokit.plugin(restEndpointMethods, throttling);
const octokit = new MyOctokit({
    authStrategy: createActionAuth,
    // auth: process.env.GITHUB_TOKEN,
    throttle: {
        onRateLimit: (retryAfter, options) => {
            core.warning(`Request quota exhausted for request ${options.method} ${options.url}`);
            if (options.request.retryCount === 0) {
                core.info(`Retrying after ${retryAfter} seconds!`);
                return true; // true = retry the request
            }
        },
        onSecondaryRateLimit: (retryAfter, options) => {
            core.warning(`Abuse detected for request ${options.method} ${options.url}`);
        },
    },
});
const [owner, repo] = 'kghafari/testbot'.split('/');
export async function generateReleaseNotes() {
    const deploymentStatusEvent = getEvent();
    if (deploymentStatusEvent.deployment_status.state === 'success' &&
        deploymentStatusEvent.deployment.environment === 'dev') {
        core.info('🧪Dev deploy was successful!');
        printDeploymentStatusEvent(deploymentStatusEvent);
        createOrUpdateDraftRelease(deploymentStatusEvent);
    }
    else if (deploymentStatusEvent.deployment_status.state === 'success' &&
        deploymentStatusEvent.deployment.environment === 'prod') {
        core.info('🚀Prod deploy was successful!');
        printDeploymentStatusEvent(deploymentStatusEvent);
        // manage releaase notes for prod
        doProdReleaseNotes(deploymentStatusEvent);
    }
    else {
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
async function createOrUpdateDraftRelease(deploymentStatusEvent) {
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
    releaseNotes += `[Last Successful Beta Deploy](${deploymentStatusEvent.workflow_run.html_url})\n`;
    for (const commit of commits) {
        const commitSha = commit.sha;
        const shortSha = commitSha.slice(0, 7);
        const commitMessage = commit.commit.message.split('\n')[0];
        try {
            const prResponse = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
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
            }
            else {
                releaseNotes += `- ${shortSha}: ${commitMessage}\n`;
            }
        }
        catch (err) {
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
        const { data: releases } = await octokit.rest.repos.listReleases({
            owner: owner,
            repo: repo,
            per_page: 20,
        });
        const maybeDraft = releases.find((release) => release.tag_name === 'v-next' && release.draft === true);
        // const maybeDraft = await octokit.rest.repos.getReleaseByTag({
        //   owner: owner,
        //   repo: repo,
        //   tag: `v-next`,
        // });
        core.info('🛠 Draft Release Updating...');
        const updatedDraft = await octokit.rest.repos.updateRelease({
            owner: owner,
            repo: repo,
            release_id: maybeDraft.id,
            body: releaseNotes,
        });
        if (updatedDraft.status === 200) {
            core.info('🛠 UpdatedDraft 200!');
        }
    }
    catch (e) {
        core.info('❎ Draft release does not exist, creating a new one...');
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
        }
        else {
            core.info('❎ Failed to create Draft release!');
        }
    }
}
async function doProdReleaseNotes(deploymentStatusEvent) {
    // 1. Last prod release
    const latestRelease = await octokit.rest.repos.getLatestRelease({
        owner: owner,
        repo: repo,
    });
    printReleaseInfo(latestRelease);
    // 2. Current deployment event sha (prod now)
    // From deploymentStatusEvent
    deploymentStatusEvent.workflow.name;
    // 3. Last successful beta deployment sha (dev now)
    const lastSuccessfulDevDeploy = await getLastSuccessfulDevDeploymentSha(owner, repo);
    // we need this when there actually is a difference between what's going to prod here
    // and what's in beta. If there are no differences, we don't need to do anything, and we can just release
    // the draft as is.
    // if there are commits, we need to create a new release with the new notes
    // and update the draft release with the new notes. That has the new difference between beta and prod
    const currentToBetaComparison = await octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: lastSuccessfulDevDeploy,
        head: deploymentStatusEvent.deployment.sha,
    });
    if (currentToBetaComparison.data.status === 'identical') {
        core.info('No differences between beta and prod. No need to create a new release.');
        try {
            core.info('✅ Checking for Draft release...');
            const { data: releases } = await octokit.rest.repos.listReleases({
                owner: owner,
                repo: repo,
                per_page: 20,
            });
            const maybeDraft = releases.find((release) => release.tag_name === 'v-next' && release.draft === true);
            if (maybeDraft) {
                core.info(`✅ Found Draft release: ${maybeDraft.name}... `);
                return;
            }
            const date = new Date();
            await octokit.rest.repos.updateRelease({
                owner: owner,
                repo: repo,
                release_id: maybeDraft.id,
                draft: false,
                prerelease: false,
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
            return;
        }
        catch (e) {
            core.info('❎ Failed to update Draft release!');
            core.info(e);
        }
    }
    else {
        core.info('🧈Differences between beta and prod. Creating a new release.');
    }
    // const maybeDraft = await octokit.rest.repos.getReleaseByTag({
    //   owner: owner,
    //   repo: repo,
    //   tag: `v-next`,
    // });
    // get the last successful deployment
    const deployments = await octokit.rest.repos.listDeployments({
        owner: owner,
        repo: repo,
        per_page: 1,
        environment: 'prod',
    });
    if (deployments.status === 200) {
        core.info('✅ Found last successful deployment!');
    }
    else {
        core.info('❎ Failed to find last successful deployment!');
    }
}
async function getLastSuccessfulDevDeploymentSha(owner, repo, limit = 15) {
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
            return deployment.sha;
        }
    }
    throw new Error(`No successful dev deployment found in last ${limit} deployments.`);
}
function getEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        throw new Error('GITHUB_EVENT_PATH not defined');
    }
    const rawEvent = fs.readFileSync(eventPath, 'utf-8');
    try {
        return JSON.parse(rawEvent);
    }
    catch (error) {
        core.setFailed(`This doesn't seem to be a deployment event 😭: ${error}`);
        return;
    }
}
function printDeploymentStatusEvent(event) {
    core.info(`
    ========= Deployment Status Details =========
    ID: ${event.deployment.id}
    Environment: ${event.deployment.environment}
    STATE: ${event.deployment_status.state === 'success'
        ? '✅ Success'
        : event.deployment_status.state}
    SHA: ${event.deployment.sha}
    Ref: ${event.deployment.ref}
    URL: ${event.deployment.url}
    Creator: ${event.deployment.creator?.login}
    Description: ${event.deployment.description || 'No description provided'}
    ======================================
  `);
}
function printDeploymentEvent(event) {
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
function printReleaseInfo(release) {
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
//# sourceMappingURL=gen-release-notes.mjs.map