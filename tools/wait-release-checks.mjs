// A release may only be created after the independent push checks succeeded.
import { setTimeout } from 'node:timers/promises';
const repo = process.env.GITHUB_REPOSITORY, sha = process.env.GITHUB_SHA, token = process.env.GH_TOKEN;
if (!repo || !sha || !token) throw new Error('Missing GitHub release-check context');
const deadline = Date.now() + 35 * 60_000;
const workflows = ['checks.yml', 'ocr-preview.yml'];
while (Date.now() < deadline) {
  let ready = true;
  for (const workflow of workflows) {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=20`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`Cannot verify ${workflow}: HTTP ${response.status}`);
    const run = (await response.json()).workflow_runs.sort((a, b) => b.id - a.id)[0];
    console.log(`${workflow}: ${run ? run.status + '/' + run.conclusion + ' ' + run.html_url : 'awaiting push run'}`);
    if (run?.status === 'completed' && run.conclusion !== 'success') throw new Error(`${workflow} failed; release refused`);
    if (!run || run.status !== 'completed') ready = false;
  }
  if (ready) process.exit(0);
  await setTimeout(15_000);
}
throw new Error('Timed out waiting for required checks; release refused');
