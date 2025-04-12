"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateReleaseNotes = generateReleaseNotes;
const tslib_1 = require("tslib");
const core_1 = require("@octokit/core");
const core = tslib_1.__importStar(require("@actions/core"));
const plugin_rest_endpoint_methods_1 = require("@octokit/plugin-rest-endpoint-methods");
function generateReleaseNotes() {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const MyOctokit = core_1.Octokit.plugin(plugin_rest_endpoint_methods_1.restEndpointMethods);
        const octokit = new MyOctokit({ auth: 'secret123' });
        const [owner, repo] = 'kghafari/testbot'.split('/');
        // https://developer.github.com/v3/users/#get-the-authenticated-user
        octokit.rest.users.getAuthenticated();
        const repos = yield octokit.rest.repos.listDeployments({
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
    });
}
// function getLastSuccessfulDeploy(envinronment: string): string {
//   const octokit = new Octokit();
//   return '';
// }
generateReleaseNotes();
//# sourceMappingURL=gen-release-notes.js.map