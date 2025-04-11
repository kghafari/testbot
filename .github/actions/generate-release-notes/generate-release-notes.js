"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHelloWorld = runHelloWorld;
const tslib_1 = require("tslib");
const core = tslib_1.__importStar(require("@actions/core"));
const action_1 = require("@octokit/action");
function runHelloWorld() {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        try {
            core.info('👋 Hello from generate-release-notes!');
            const octokit = new action_1.Octokit();
            const [owner, repo] = 'kghafari/testbot'.split('/');
            // See https://developer.github.com/v3/issues/#create-an-issue
            const { data } = yield octokit.request('POST /repos/{owner}/{repo}/issues', {
                owner,
                repo,
                title: 'My test issue',
            });
            console.log('Issue created: %s', data.html_url);
        }
        catch (error) {
            core.error('❌ An error occurred:');
            core.error(error.message);
            core.setFailed(error.message);
        }
    });
}
runHelloWorld();
//# sourceMappingURL=generate-release-notes.js.map