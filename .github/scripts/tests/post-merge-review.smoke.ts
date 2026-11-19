// lane: smoke
// Value: protects=the post-merge review issues the change policy relies on: every high-risk merge
//   into main reaches the founder who did not write it, and every merge reaches the weekly list;
//   fails_when=a merge on a window boundary is skipped or repeated, a failed run's window is never
//   made up, a high-risk path past the first 100 files or a high-risk file renamed away is missed, the wrong founder is assigned, or
//   an issue someone else titled like a review stands in for it;
// why_new=scripts/post-merge-review.py is new; seam=the gh CLI, replaced by a fake on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(resolve(fileURLToPath(new URL("../../..", import.meta.url))), ".github", "scripts", "post-merge-review.py");

type Pr = { number: number; author: string; mergedAt: string; files: string[]; renamedFrom?: string };
type Issue = { title: string; author: string; body: string; assignee?: string };
type State = { prs: Pr[]; issues: Issue[]; created: Issue[]; apiFileCap?: number; apiFail?: boolean };

// The fake answers the four gh calls the script makes. Like gh, `pr list` returns at most 100 paths
// per pull request; only the files endpoint returns the rest.
const fakeGh = `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(state.prs.slice(0, Number(flag("--limit"))).map((pr) => ({
    number: pr.number, title: "PR " + pr.number, author: { login: pr.author }, mergedAt: pr.mergedAt,
    files: pr.files.slice(0, 100).map((path) => ({ path })), changedFiles: pr.files.length
  }))));
} else if (args[0] === "api" && state.apiFail) {
  process.stderr.write("HTTP 502: Bad Gateway");
  process.exit(1);
} else if (args[0] === "api") {
  const pr = state.prs.find((candidate) => args.some((arg) => arg.includes("/pulls/" + candidate.number + "/files")));
  const files = pr.files.slice(0, state.apiFileCap ?? pr.files.length);
  process.stdout.write(files.map((path, index) => path + "\\t" + (index === 0 && pr.renamedFrom ? pr.renamedFrom : "")).join("\\n") + "\\n");
} else if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify(state.issues.map((issue) => ({ title: issue.title, author: { login: issue.author }, body: issue.body }))));
} else if (args[0] === "issue" && args[1] === "create") {
  const issue = { title: flag("--title"), author: "app/github-actions", body: flag("--body"), assignee: flag("--assignee") };
  state.issues.push(issue);
  state.created.push(issue);
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
} else {
  process.stderr.write("unexpected gh call: " + args.join(" "));
  process.exit(9);
}
`;

const dir = mkdtempSync(join(tmpdir(), "post-merge-review-"));
writeFileSync(join(dir, "gh"), fakeGh);
chmodSync(join(dir, "gh"), 0o755);
const statePath = join(dir, "state.json");

const GLOBS = "db/** Dockerfile* lib/auth/** lib/auth*.ts middleware.ts .github/**";

function run(args: string[], state: Partial<State>, env: Record<string, string> = {}) {
  writeFileSync(statePath, JSON.stringify({ prs: [], issues: [], created: [], ...state }));
  const result = spawnSync("python3", [script, ...args], {
    encoding: "utf8",
    // Only what the script reads: the runner's own GitHub variables must not reach it.
    env: {
      PATH: `${dir}:${process.env.PATH}`, FAKE_GH_STATE: statePath, GITHUB_REPOSITORY: "acme/boards",
      // A fixed clock long after every window here, unless a case sets its own.
      CEO_LOGIN: "ceo", CTO_LOGIN: "cto", HIGH_RISK_GLOBS: GLOBS, NODE_ENV: "test", REVIEW_CLOCK: "2030-01-01T00:00:00Z", ...env
    }
  });
  const after = JSON.parse(readFileSync(statePath, "utf8")) as State;
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, created: after.created, state: after };
}

const numbers = (issue: Issue) => [...issue.body.matchAll(/^- \[ \] #(\d+) /gm)].map((match) => Number(match[1]));
const risky = (number: number, author: string, mergedAt: string): Pr => ({ number, author, mergedAt, files: ["db/schema.ts"] });

// 20 Nov 2026 is a Friday, 23 Nov a Monday. One daily window per boundary pair.
const week: Pr[] = [
  risky(1, "cto", "2026-11-19T06:59:59Z"), // Wednesday's window
  risky(2, "ceo", "2026-11-19T07:00:00Z"), // first second of Thursday's
  risky(3, "cto", "2026-11-20T06:59:59Z"), // last second of Thursday's
  risky(4, "cto", "2026-11-20T07:00:00Z"), // first second of Friday-to-Monday
  risky(5, "ceo", "2026-11-21T15:00:00Z"), // Saturday
  { number: 6, author: "cto", mergedAt: "2026-11-22T10:00:00Z", files: ["app/page.tsx"] },
  risky(7, "bot", "2026-11-23T06:59:59Z"),
  risky(8, "cto", "2026-11-23T07:00:00Z") // belongs to Monday-to-Tuesday
];

// Monday's run, with the two windows before it already answered for: each founder gets the other's
// merges, a bot's merge goes to the CEO, the ordinary change is left out, and both edges are exact.
{
  const monday = run(["daily", "--as-of", "2026-11-23T07:05:00Z"], { prs: week }, { REVIEW_NOT_BEFORE: "2026-11-20T07:00:00Z" });
  assert.equal(monday.status, 0, monday.stderr);
  assert.deepEqual(monday.created.map((issue) => [issue.assignee, issue.title, numbers(issue)]), [
    ["ceo", "High-risk change review for @ceo: 2026-11-20 07:00 to 2026-11-23 07:00 UTC", [4, 7]],
    ["cto", "High-risk change review for @cto: 2026-11-20 07:00 to 2026-11-23 07:00 UTC", [5]]
  ]);

  // The same run again opens nothing: the window is recognised by this workflow's own issue.
  const again = run(["daily", "--as-of", "2026-11-23T09:00:00Z"], { prs: week, issues: monday.state.issues }, { REVIEW_NOT_BEFORE: "2026-11-20T07:00:00Z" });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.created, []);
}

// A date stands for that day's 07:00 boundary, a run before 07:00 belongs to the day before, and a
// weekend run reports up to Friday 07:00: all three end on Thursday's window.
for (const asOf of ["2026-11-20", "2026-11-21T06:59:59Z", "2026-11-21T12:00:00Z", "2026-11-22T23:00:00Z", "2026-11-23T06:59:59Z"]) {
  const result = run(["daily", "--as-of", asOf], { prs: week }, { REVIEW_NOT_BEFORE: "2026-11-19T07:00:00Z" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.created.map((issue) => [issue.assignee, numbers(issue)]), [["cto", [2]], ["ceo", [3]]], asOf);
}

// Monday's run failed and nobody reran it until Tuesday: Tuesday's run still opens the
// Friday-to-Monday review, and Thursday's, alongside its own.
{
  const tuesday = run(["daily", "--as-of", "2026-11-24T07:10:00Z"], { prs: week });
  assert.equal(tuesday.status, 0, tuesday.stderr);
  assert.deepEqual(tuesday.created.map((issue) => [issue.assignee, issue.title.slice(-40), numbers(issue)]), [
    ["cto", "2026-11-19 07:00 to 2026-11-20 07:00 UTC", [2]],
    ["ceo", "2026-11-19 07:00 to 2026-11-20 07:00 UTC", [3]],
    ["ceo", "2026-11-20 07:00 to 2026-11-23 07:00 UTC", [4, 7]],
    ["cto", "2026-11-20 07:00 to 2026-11-23 07:00 UTC", [5]],
    ["ceo", "2026-11-23 07:00 to 2026-11-24 07:00 UTC", [8]]
  ]);
}

// An issue only counts as the review if this workflow wrote it. Someone else's issue with the same
// title, open or closed, does not suppress the checklist; neither does a bot issue without the marker.
{
  const title = "High-risk change review for @ceo: 2026-11-23 07:00 to 2026-11-24 07:00 UTC";
  const env = { REVIEW_NOT_BEFORE: "2026-11-23T07:00:00Z" };
  const args = ["daily", "--as-of", "2026-11-24T07:10:00Z"];
  const marker = "<!-- post-merge-review daily ceo 2026-11-23T07:00:00Z 2026-11-24T07:00:00Z -->";
  const squatted = run(args, { prs: week, issues: [{ title, author: "mallory", body: marker }] }, env);
  assert.deepEqual(squatted.created.map((issue) => issue.title), [title], "a look-alike issue does not stand in for the review");
  assert.ok(squatted.created[0].body.endsWith(marker), "the opened issue carries the window marker");
  const unmarked = run(args, { prs: week, issues: [{ title, author: "app/github-actions", body: "" }] }, env);
  assert.equal(unmarked.created.length, 1, "a bot issue for something else does not stand in either");
  const genuine = run(args, { prs: week, issues: [{ title, author: "app/github-actions", body: `list\n\n${marker}` }] }, env);
  assert.deepEqual(genuine.created, []);
  assert.match(genuine.stdout, /Already opened/);
}

// The list query returns 100 paths per pull request. A high-risk path after those, or a high-risk
// file renamed away, still selects the merge; a list GitHub cannot return whole is treated as high-risk.
{
  const ordinary = Array.from({ length: 100 }, (_, index) => `app/page-${index}.tsx`);
  const at = "2026-11-23T08:00:00Z";
  const args = ["daily", "--as-of", "2026-11-24T07:10:00Z"];
  const env = { REVIEW_NOT_BEFORE: "2026-11-23T07:00:00Z" };
  const prs: Pr[] = [
    { number: 11, author: "cto", mergedAt: at, files: [...ordinary, "lib/auth/session.ts"] },
    { number: 12, author: "cto", mergedAt: at, files: [...ordinary, "app/extra.tsx"] },
    { number: 13, author: "cto", mergedAt: at, files: [...ordinary, "app/moved.ts"], renamedFrom: "db/moved.ts" },
    { number: 14, author: "cto", mergedAt: at, files: ordinary },
    // A small pull request too: the list query names only the new path of a renamed file.
    { number: 15, author: "cto", mergedAt: at, files: ["lib/moved.ts"], renamedFrom: "db/moved.ts" },
    { number: 16, author: "cto", mergedAt: at, files: ["lib/renamed.ts"], renamedFrom: "lib/original.ts" }
  ];
  const paged = run(args, { prs }, env);
  assert.equal(paged.status, 0, paged.stderr);
  assert.deepEqual(paged.created.map(numbers), [[11, 13, 15]]);
  assert.doesNotMatch(paged.created[0].body, /incomplete/);

  const truncated = run(args, { prs: [prs[1]], apiFileCap: 100 }, env);
  assert.deepEqual(truncated.created.map(numbers), [[12]]);
  assert.match(truncated.created[0].body, /#12 .*file list incomplete/);

  // A failed files lookup does not stop the run: that pull request is listed as high-risk with an
  // incomplete file list, and the run still opens its checklist.
  const failed = run(args, { prs: [prs[0], prs[1]], apiFail: true }, env);
  assert.equal(failed.status, 0, failed.stderr);
  assert.deepEqual(failed.created.map(numbers), [[11, 12]]);
  assert.match(failed.created[0].body, /#12 .*file list incomplete/);
  assert.match(failed.stderr, /Could not read the files of #12/);
}

// The clock: a window opens only an hour after it closes, whether the run is scheduled or a
// rerun, and a rerun date that has not happened yet opens nothing.
{
  const prs: Pr[] = [risky(31, "cto", "2026-11-23T12:00:00Z")];
  const env = { REVIEW_NOT_BEFORE: "2026-11-23T07:00:00Z" };
  const title = "High-risk change review for @ceo: 2026-11-23 07:00 to 2026-11-24 07:00 UTC";
  const early = run(["daily"], { prs }, { ...env, REVIEW_CLOCK: "2026-11-24T07:59:59Z" });
  assert.equal(early.status, 0, early.stderr);
  assert.deepEqual(early.created, []);
  assert.match(early.stdout, /Skipped 2026-11-23 07:00 to 2026-11-24 07:00 UTC: it closed less than/);
  const settled = run(["daily"], { prs }, { ...env, REVIEW_CLOCK: "2026-11-24T08:00:00Z" });
  assert.deepEqual(settled.created.map((issue) => [issue.title, numbers(issue)]), [[title, [31]]]);
  const rerunEarly = run(["daily", "--as-of", "2026-11-24T07:30:00Z"], { prs }, { ...env, REVIEW_CLOCK: "2026-11-24T07:40:00Z" });
  assert.equal(rerunEarly.status, 0, rerunEarly.stderr);
  assert.deepEqual(rerunEarly.created, []);
  assert.match(rerunEarly.stdout, /Skipped 2026-11-23 07:00 to 2026-11-24 07:00 UTC: it closed less than/);
  const future = run(["daily", "--as-of", "2026-11-25"], { prs }, { ...env, REVIEW_CLOCK: "2026-11-24T09:00:00Z" });
  assert.equal(future.status, 2);
  assert.match(future.stderr, /is in the future/);
  assert.deepEqual(future.created, []);
}

// Matcher edges, through the daily selection: `*` stays inside one path segment, `**` crosses
// them, a plain name matches at the root only and its dot is a dot.
{
  const cases: Array<[string, boolean]> = [
    ["db/a.sql", true], ["db/migrations/0001/up.sql", true], ["lib/db/a.ts", false], ["dbx/a.ts", false],
    ["Dockerfile", true], ["Dockerfile.worker", true], ["docker/Dockerfile", false],
    ["lib/auth.ts", true], ["lib/auth-session.ts", true], ["lib/authx/a.ts", false], ["lib/auth/deep/a.ts", true],
    ["middleware.ts", true], ["app/middleware.ts", false], ["middlewareXts", false], ["middleware.tsx", false],
    [".github/workflows/ci.yml", true], ["xgithub/workflows/ci.yml", false]
  ];
  const prs = cases.map(([path], index): Pr => ({ number: 100 + index, author: "cto", mergedAt: "2026-11-23T08:00:00Z", files: [path] }));
  const result = run(["daily", "--as-of", "2026-11-24T07:10:00Z"], { prs }, { REVIEW_NOT_BEFORE: "2026-11-23T07:00:00Z" });
  assert.deepEqual(result.created.map(numbers), [cases.flatMap(([, expected], index) => (expected ? [100 + index] : []))]);
}

// Weekly: every merge from Monday 07:00 to Monday 07:00, for the CEO, with the high-risk ones marked,
// and the week before it made up when its issue is missing. A week with no merges still gets its issue.
{
  const weekly = run(["weekly", "--as-of", "2026-11-23T07:05:00Z"], { prs: week });
  assert.equal(weekly.status, 0, weekly.stderr);
  assert.deepEqual(weekly.created.map((issue) => [issue.assignee, issue.title, numbers(issue)]), [
    ["ceo", "Weekly change review: 2026-11-09 07:00 to 2026-11-16 07:00 UTC", []],
    ["ceo", "Weekly change review: 2026-11-16 07:00 to 2026-11-23 07:00 UTC", [1, 2, 3, 4, 5, 6, 7]]
  ]);
  assert.match(weekly.created[0].body, /No pull requests were merged this week\./);
  assert.match(weekly.created[1].body, /#5 .*\*\*high-risk\*\*/);
  assert.doesNotMatch(weekly.created[1].body, /#6 .*high-risk/);

  const floored = run(["weekly", "--as-of", "2026-11-25T12:00:00Z"], { prs: week }, { REVIEW_NOT_BEFORE: "2026-11-16T07:00:00Z" });
  assert.deepEqual(floored.created.map((issue) => issue.title), ["Weekly change review: 2026-11-16 07:00 to 2026-11-23 07:00 UTC"]);
  assert.match(floored.stdout, /Skipped 2026-11-09 07:00 to 2026-11-16 07:00 UTC/);
}

// A window at the query limit fails the run rather than opening a checklist that may be missing merges.
{
  const many = Array.from({ length: 1000 }, (_, index) => risky(1000 + index, "cto", "2026-11-23T08:00:00Z"));
  const capped = run(["daily", "--as-of", "2026-11-24T07:10:00Z"], { prs: many }, { REVIEW_NOT_BEFORE: "2026-11-23T07:00:00Z" });
  assert.equal(capped.status, 1);
  assert.match(capped.stderr, /query limit/);
  assert.deepEqual(capped.created, []);
}

// Bad input opens nothing and says how to call it; a malformed floor fails instead of skipping everything.
for (const args of [[], ["hourly"], ["daily", "--as-of"], ["daily", "--as-of", "yesterday"], ["daily", "extra"]]) {
  const result = run(args, { prs: week });
  assert.equal(result.status, 2, args.join(" "));
  assert.match(result.stderr, /usage:/);
  assert.deepEqual(result.created, []);
}
{
  const result = run(["daily", "--as-of", "2026-11-24"], { prs: week }, { REVIEW_NOT_BEFORE: "16 Nov" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.created, []);
}

console.log("post-merge review: windows, catch-up, reviewers, whole file lists, genuine issues only");
