import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

export async function generateReleaseNotes() {
  const MyOctokit = Octokit.plugin(restEndpointMethods);
  const octokit = new MyOctokit({ auth: 'secret123' });

  const [owner, repo] = 'kghafari/testbot'.split('/');

  // https://developer.github.com/v3/users/#get-the-authenticated-user
  octokit.rest.users.getAuthenticated();

  const repos = await octokit.rest.repos.listDeployments({
    per_page: 10,
    owner: owner,
    repo: repo,
  });

  for (const deployment of repos.data) {
    console.log('============DEPLOYMENT=============');
    console.log(deployment);
    core.info(`Id: ${deployment.id}`);
    core.info(`Url: ${deployment.url}`);
    core.info(`Sha: ${deployment.sha}`);
  }

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
