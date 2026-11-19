#!/usr/bin/env python3
"""Open post-merge review issues for Change & Release Management requirements 4 and 5.

daily:  pull requests merged into main that touch high-risk paths, for review by the end of the
        next business day by a founder other than the author. A window runs between fixed
        07:00 UTC boundaries: the previous business day's 07:00 to a business day's 07:00 (Monday
        covers Friday 07:00 to Monday 07:00).
weekly: every pull request merged into main from one Monday 07:00 UTC to the next, for the CEO's
        weekly review.

Every run also goes back over the windows before the latest one (DAILY_LOOKBACK business days,
WEEKLY_LOOKBACK weeks), so a run that failed, or was retried after the next boundary, is made up
by the next run instead of leaving its window without an issue. `--as-of` reruns an older date by
hand. Windows that end at or before REVIEW_NOT_BEFORE are never opened; a window that straddles
it is opened whole, so no merge after it falls between two reviews.

An issue is opened at most once per window. A window counts as opened only if an issue with its
title was written by this workflow (ISSUE_AUTHORS) and carries the window's marker; an issue that
someone else gives the same title does not stand in for the review. If a window holds more pull
requests than the query limit, the run fails instead of opening a partial checklist.

A pull request's whole file list is read, not the first 100 paths the list query returns. If
GitHub cannot return the whole list, the pull request is treated as high-risk and says so.

Each issue is a checklist; the reviewer ticks each pull request, comments if a fix is needed
(it becomes a new change) and closes the issue. The close date is the review date.

Usage: post-merge-review.py daily|weekly [--as-of YYYY-MM-DD|YYYY-MM-DDTHH:MM:SSZ]
Configuration (environment): GITHUB_REPOSITORY, HIGH_RISK_GLOBS (space-separated), CEO_LOGIN,
CTO_LOGIN; optional REVIEW_NOT_BEFORE (YYYY-MM-DDTHH:MM:SSZ), ISSUE_AUTHORS (space-separated).
Needs the gh CLI with GH_TOKEN allowed to read pull requests and write issues.
"""

import datetime as dt
import json
import os
import re
import subprocess
import sys

FMT = "%Y-%m-%dT%H:%M:%SZ"
QUERY_LIMIT = 1000
DAILY_LOOKBACK = 3
# GitHub's search index can lag behind a merge. A window is only opened once it closed this long
# ago, so a just-closed window is not published without its last merges; the next run opens it.
SETTLE = dt.timedelta(hours=1)
WEEKLY_LOOKBACK = 2
# How gh and the REST API spell the Actions token's account.
DEFAULT_ISSUE_AUTHORS = "app/github-actions github-actions[bot] github-actions"


def glob_to_regex(pattern: str) -> re.Pattern:
    out = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile("^" + out + "$")


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def parse_as_of(value: str) -> dt.datetime:
    """A date means that day's 07:00 UTC boundary; a full timestamp is taken as given."""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return dt.datetime.strptime(value, "%Y-%m-%d").replace(hour=7, tzinfo=dt.timezone.utc)
    return dt.datetime.strptime(value, FMT).replace(tzinfo=dt.timezone.utc)


def windows(mode: str, now: dt.datetime, count: int) -> list[tuple[dt.datetime, dt.datetime]]:
    """The latest `count` completed windows, oldest first."""
    end = now.replace(hour=7, minute=0, second=0, microsecond=0)
    if now < end:
        end -= dt.timedelta(days=1)
    found = []
    if mode == "weekly":
        end -= dt.timedelta(days=end.isoweekday() - 1)  # back to Monday 07:00
        for _ in range(count):
            found.append((end - dt.timedelta(days=7), end))
            end -= dt.timedelta(days=7)
    else:
        while end.isoweekday() > 5:  # a weekend run reports up to Friday 07:00
            end -= dt.timedelta(days=1)
        for _ in range(count):
            start = end - dt.timedelta(days=3 if end.isoweekday() == 1 else 1)
            found.append((start, end))
            end = start
    return found[::-1]


def main() -> int:
    args = sys.argv[1:]
    mode = args[0] if args else ""
    as_of = None
    if len(args) == 3 and args[1] == "--as-of":
        try:
            as_of = parse_as_of(args[2])
        except ValueError:
            mode = ""
    elif len(args) != 1:
        mode = ""
    if mode not in ("daily", "weekly"):
        print("usage: post-merge-review.py daily|weekly [--as-of YYYY-MM-DD|YYYY-MM-DDTHH:MM:SSZ]", file=sys.stderr)
        return 2
    repo = os.environ["GITHUB_REPOSITORY"]
    ceo = os.environ["CEO_LOGIN"]
    cto = os.environ["CTO_LOGIN"]
    globs = [glob_to_regex(g) for g in os.environ.get("HIGH_RISK_GLOBS", "").split()]
    authors = set((os.environ.get("ISSUE_AUTHORS") or DEFAULT_ISSUE_AUTHORS).split())
    not_before = os.environ.get("REVIEW_NOT_BEFORE", "")
    if not_before:
        parse_as_of(not_before)  # a malformed floor fails the run instead of silently opening nothing

    def paths_of(pr: dict) -> tuple[list[str], bool]:
        """Every changed path, and whether the list is known to be whole."""
        paths = [f["path"] for f in pr.get("files", [])]
        expected = pr.get("changedFiles", len(paths))
        if len(paths) >= expected and any(g.match(path) for path in paths for g in globs):
            return paths, True
        # The list query stops at 100 paths per pull request and names only a renamed file's new
        # path; the files endpoint pages and also gives the path it was renamed from.
        try:
            rows = gh("api", "--paginate", f"repos/{repo}/pulls/{pr['number']}/files?per_page=100",
                      "--jq", '.[] | [.filename, (.previous_filename // "")] | @tsv').splitlines()
        except subprocess.CalledProcessError as err:
            # A failed lookup must not stop the run: the pull request is listed as high-risk with
            # an incomplete file list, so it is still reviewed.
            print(f"Could not read the files of #{pr['number']}: {err.stderr.strip()[:200]}", file=sys.stderr)
            return paths, False
        names = [row.split("\t") for row in rows if row]
        return [name for pair in names for name in pair if name], len(names) >= expected

    def classify(pr: dict) -> None:
        paths, whole = paths_of(pr)
        pr["wholeFileList"] = whole
        pr["highRisk"] = not whole or any(g.match(path) for path in paths for g in globs)

    def tag(pr: dict) -> str:
        if not pr["wholeFileList"]:
            return " **high-risk** (file list incomplete, treat as high-risk)"
        return " **high-risk**" if pr["highRisk"] else ""

    def line(pr: dict, with_tag: bool) -> str:
        # A title is one line in the checklist, so a title that holds a task list adds no boxes.
        title = " ".join(pr["title"].split())
        return (f"- [ ] #{pr['number']} {title} (by @{pr['author']['login']}, "
                f"merged {pr['mergedAt'][:16]}Z){tag(pr) if with_tag or not pr['wholeFileList'] else ''}")

    def issue_exists(title: str, marker: str) -> bool:
        # Listed, not searched: the search index can lag behind an issue a run just opened, so a
        # quick rerun would open a second one. This repository has few issues; the list is whole.
        found = json.loads(gh("issue", "list", "--repo", repo, "--state", "all", "--limit", "1000",
                              "--json", "title,author,body"))
        return any(i["title"] == title and (i.get("author") or {}).get("login") in authors
                   and marker in (i.get("body") or "") for i in found)

    def reviewer_for(author: str) -> str:
        return cto if author == ceo else ceo

    def open_issue(title: str, marker: str, assignee: str, body: str) -> bool:
        if issue_exists(title, marker):
            print(f"Already opened: {title}")
            return False
        gh("issue", "create", "--repo", repo, "--title", title, "--assignee", assignee,
           "--body", body + "\n\n" + marker)
        return True

    # REVIEW_CLOCK stands in for the current time in tests; the workflow never sets it.
    clock = os.environ.get("REVIEW_CLOCK", "")
    real_now = parse_as_of(clock) if clock else dt.datetime.now(dt.timezone.utc)
    if as_of and as_of > real_now:
        # A rerun date that has not happened yet would publish a window before it closed.
        print(f"--as-of {as_of.strftime(FMT)} is in the future; nothing to review yet.", file=sys.stderr)
        return 2
    now = as_of or real_now
    for start, end in windows(mode, now, DAILY_LOOKBACK if mode == "daily" else WEEKLY_LOOKBACK):
        since, until = start.strftime(FMT), end.strftime(FMT)
        window = f"{start.strftime('%Y-%m-%d %H:%M')} to {end.strftime('%Y-%m-%d %H:%M')} UTC"
        if real_now - end < SETTLE:
            print(f"Skipped {window}: it closed less than {SETTLE} ago; the next run opens it.")
            continue
        if not_before and until <= not_before:
            print(f"Skipped {window}: it ends before {not_before}.")
            continue
        prs = json.loads(gh("pr", "list", "--repo", repo, "--base", "main", "--state", "merged",
                            "--search", f"merged:{since}..{until}", "--limit", str(QUERY_LIMIT),
                            "--json", "number,title,author,mergedAt,files,changedFiles"))
        if len(prs) >= QUERY_LIMIT:
            print(f"{len(prs)} pull requests in {window} reach the query limit; refusing to open a partial checklist.",
                  file=sys.stderr)
            return 1
        prs = [p for p in prs if since <= p["mergedAt"] < until]
        prs.sort(key=lambda p: p["mergedAt"])
        for pr in prs:
            classify(pr)

        if mode == "daily":
            selected = [p for p in prs if p["highRisk"]]
            if not selected:
                print(f"No high-risk merges in {window}.")
                continue
            by_reviewer: dict[str, list] = {}
            for p in selected:
                by_reviewer.setdefault(reviewer_for(p["author"]["login"]), []).append(p)
            for reviewer, items in by_reviewer.items():
                title = f"High-risk change review for @{reviewer}: {window}"
                body = ("High-risk changes merged into `main` from " + window + ". Review each one by the end of "
                        "the next business day (Change & Release Management, requirement 4): read the description, "
                        "the diff and the AI review, tick it, and comment here if something needs a fix. Close the "
                        "issue when every box is ticked.\n\n" + "\n".join(line(p, False) for p in items))
                if open_issue(title, f"<!-- post-merge-review daily {reviewer} {since} {until} -->", reviewer, body):
                    print(f"Opened a high-risk review for {reviewer} covering {len(items)} pull request(s).")
            continue

        title = f"Weekly change review: {window}"
        lines = [line(p, True) for p in prs]
        body = ("Weekly review of every pull request merged into `main` from " + window + " (Change & Release "
                "Management, requirement 5). Also check this repository's branch rules and their history for "
                "changes made during the week. Tick each pull request, comment here if something needs a fix, "
                "and close the issue when done.\n\n" + ("\n".join(lines) if lines else "No pull requests were merged this week."))
        if open_issue(title, f"<!-- post-merge-review weekly {since} {until} -->", ceo, body):
            print(f"Opened the weekly review covering {len(prs)} pull request(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
