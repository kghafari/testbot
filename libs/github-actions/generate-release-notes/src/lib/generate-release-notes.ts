import * as core from '@actions/core';
import { Octokit } from '@octokit/action';

export async function runHelloWorld() {
  core.info('👋 Hello from generate-release-notes!');
  const octokit = new Octokit();
  const [owner, repo] = 'kghafari/testbot/releases'.split('/');

  // See https://developer.github.com/v3/issues/#create-an-issue
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner,
    repo,
    title: 'My test issue',
  });
  console.log('Issue created: %s', data.html_url);
}
