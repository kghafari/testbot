import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { createActionAuth } from '@octokit/auth-action';
import * as fs from 'fs';
// const token = process.env.GITHUB_TOKEN;
const auth = createActionAuth();
const authentication = await auth();
const MyOctokit = Octokit.plugin(restEndpointMethods);
const octokit = new MyOctokit({ auth: authentication.token });
const [owner, repo] = 'kghafari/testbot'.split('/');
export async function generateReleaseNotes() {
    // const handleWebhookEvent = (event: WebhookEvent) => {
    //   if ('action' in event && event.action === 'completed') {
    //     console.log(`${event.sender.login} completed something!`);
    //   }
    // };
    const handleDeploymentEvent = (event) => {
        console.log(`${JSON.stringify(event)}`);
        core.info(`🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉${event}`);
    };
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        throw new Error('GITHUB_EVENT_PATH not defined');
    }
    const rawEvent = fs.readFileSync(eventPath, 'utf-8');
    // 2. Parse it and cast to WebhookEvent
    const event = JSON.parse(rawEvent);
    // 3. Call your handler
    handleDeploymentEvent(event);
    // https://developer.github.com/v3/users/#get-the-authenticated-user
    octokit.rest.users.getAuthenticated();
    const repos = await octokit.rest.repos.listDeployments({
        per_page: 10,
        owner: owner,
        repo: repo,
    });
    // for (const deployment of repos.data) {
    //   console.log('============DEPLOYMENT=============');
    //   console.log(deployment);
    //   core.info(`Id: ${deployment.id}`);
    //   core.info(`Url: ${deployment.url}`);
    //   core.info(`Sha: ${deployment.sha}`);
    // }
    core.info('👋 Hello from generate-release-notes!');
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
// function getLastSuccessfulDeploy(envinronment: string): string {
//   const octokit = new Octokit();
//   return '';
// }
generateReleaseNotes();
//# sourceMappingURL=gen-release-notes.mjs.map