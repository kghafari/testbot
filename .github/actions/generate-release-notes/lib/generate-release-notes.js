import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import { restEndpointMethods, } from '@octokit/plugin-rest-endpoint-methods';
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
    // -1. Check inputs
    core.info(`GITHUB_REPOSITORY: ${GITHUB_REPOSITORY}`);
    core.info(`BETA_ENV: ${BETA_ENV}`);
    core.info(`PROD_ENV: ${PROD_ENV}`);
    core.info(`DRAFT_NAME: ${DRAFT_NAME}`);
    core.info(`Current ENV: ${process.env.GITHUB_ENV}`);
    // 0. Clear the draft release. We're going to regenerate it to keep life simple
    await clearDraftRelease();
    // 1. Get the current workflow deploy sha
    const deploymentStatusEvent = getEvent();
    const currentDeploymentSha = deploymentStatusEvent.deployment.sha;
    // 2. Find the last successful beta deployment sha (?)
    let lastSuccessfulDevDeploymentSha;
    try {
        core.info(`🔍 Finding last successful deployment for ${BETA_ENV}...`);
        lastSuccessfulDevDeploymentSha = await getLastSuccessfulDeploymentSha(owner, repo, BETA_ENV);
        core.info(`found: ${lastSuccessfulDevDeploymentSha}`);
    }
    catch {
        core.setFailed(`No successful ${BETA_ENV} deployments found 😵💫`);
    }
    // 3. Get the last PROD release commitish
    let latestReleaseCommitish;
    try {
        core.info(`🔍 Finding latest release commitish...`);
        const latestReleaseResponse = await octokit.rest.repos.getLatestRelease({
            owner: owner,
            repo: repo,
        });
        latestReleaseCommitish = latestReleaseResponse.data.target_commitish;
        core.info(`found: ${latestReleaseCommitish}`);
    }
    catch {
        latestReleaseCommitish = lastSuccessfulDevDeploymentSha;
        core.info(`No latest release found. Using lastSuccessfulDevDeploymentSha sha: ${latestReleaseCommitish}`);
    }
    try {
        // LAST_RELEASE..CURRENT_WF_SHA <- For prod release
        // CURRENT_WF_SHA..LAST_TO_BETA_SHA <- for maintaining draft
        if (deploymentStatusEvent.deployment.environment === BETA_ENV) {
            core.info('🎊 Push to beta successful... Creating draft release...');
            const { data: diff } = await octokit.rest.repos.compareCommitsWithBasehead({
                owner: owner,
                repo: repo,
                basehead: `${latestReleaseCommitish}...${currentDeploymentSha}`,
            });
            core.info('prodRelease..currentDeploymentSha diff');
            core.info(`${latestReleaseCommitish}...${currentDeploymentSha}`);
            diff.commits.forEach((commit) => {
                core.info(`${commit.sha} : ${commit.commit.message}`);
            });
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
            core.info(`Draft release created: ${draftRelease.data.html_url}`);
        }
        else if (deploymentStatusEvent.deployment.environment === PROD_ENV) {
            core.info('🎊 Push to prod successful... Creating release...');
            const releaseName = new Date()
                .toISOString()
                .replace(/[-:]/g, '')
                .replace(/\.\d+Z$/, '')
                .replace('T', '-');
            const { data: diff } = await octokit.rest.repos.compareCommits({
                owner: owner,
                repo: repo,
                base: latestReleaseCommitish,
                head: currentDeploymentSha,
            });
            let releaseBody = '=== CUSTOM PROD RELEASE BODY STARTS HERE ===\n';
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
            // Create a new draft release with CURRENT_WF_SHA..LAST_TO_BETA_SHA <- for maintaining draft
            // If there's no commits, the body will be empty (for now). That's fine and expected.
            // egh idk if this still right uhhhh we want to look backwards from the last successful beta deployment sha to the current deployment sha
            const { data: draftDiff } = await octokit.rest.repos.compareCommits({
                owner: owner,
                repo: repo,
                base: lastSuccessfulDevDeploymentSha,
                head: currentDeploymentSha,
            });
            core.info("🤔 Let's keep our draft up to date...");
            let draftBody = '=== CUSTOM NONPROD BODY STARTS HERE (Generated on Prod release) ===\n';
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
    }
    catch (error) {
        core.error('❌ An error occurred:');
        core.error(error);
        core.error(JSON.stringify(error));
        core.setFailed(error.message);
    }
}
manageReleases();
// TODO: Check if retryAfter has configured values
function configureOctokit() {
    const MyOctokit = Octokit.plugin(restEndpointMethods, throttling);
    const octokit = new MyOctokit({
        authStrategy: createActionAuth,
        throttle: {
            onRateLimit: (retryAfter, options) => {
                core.warning(`Request quota exhausted for request ${options.method} ${options.url}`);
                if (options.request.retryCount === 0) {
                    core.info(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
            onSecondaryRateLimit: (_retryAfter, options) => {
                core.warning(`Abuse detected for request ${options.method} ${options.url}`);
            },
        },
    });
    return octokit;
}
// DONE
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
        .find((release) => release.tag_name === DRAFT_NAME && release.draft === true);
    if (draftRelease &&
        draftRelease.name === DRAFT_NAME &&
        draftRelease.draft === true) {
        core.info(`🙋‍♀️ Removing Old Draft Release: ${draftRelease.name}... `);
        await octokit.rest.repos.deleteRelease({
            owner: owner,
            repo: repo,
            release_id: draftRelease.id,
        });
    }
    else {
        core.info('No draft release found to remove!');
    }
}
async function getLastSuccessfulDeploymentSha(owner, repo, env, limit = 15) {
    core.info(`🔍 Finding last successful deployment for ${env}...`);
    const deployments = (await octokit.rest.repos.listDeployments({
        owner,
        repo,
        environment: env,
        per_page: limit,
    })).data.sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const deployment of deployments) {
        core.info(`Checking deployment ${deployment.id}...`);
        core.info(`Timestamp: ${deployment.created_at}`);
        const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
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
        ID: ${deployment.id}
        Deploy URL: ${wasSuccessful.deployment_url}
        Log URL: ${wasSuccessful.log_url}
        Target URL: ${wasSuccessful.target_url}
        `);
            return deployment.sha;
        }
    }
    throw new Error(`No successful dev deployment found in last ${limit} deployments for env ${env}.`);
}
async function buildReleaseNotesBody(commits) {
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
            const { data: prResponse } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
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
            }
            else {
                core.info(`No PR found for commit ${commitSha}`);
                releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
            }
        }
        catch (err) {
            core.warning(`⚠️ Failed to get PR for ${commitSha}: ${err}`);
            releaseNotesBody += `- ${shortSha}: ${commitMessage}\n`;
        }
    }
    core.info('📝Release notes body built!');
    return releaseNotesBody;
}
//# sourceMappingURL=generate-release-notes.js.map